const test = require("node:test");
const assert = require("node:assert/strict");

const { run } = require("../check-deps");
const { BRANCH_NAME } = require("../lib/pr");
const { withTempFile, makeGithub, makeRecordingCore, httpError } = require("./helpers");

const ctx = (ref = "refs/heads/main") => ({ ref, repo: { owner: "o", repo: "r" } });

function asyncPagesOf(...pages) {
  return (async function* () {
    for (const p of pages) yield { data: p };
  })();
}

// --- entry guards ---

test("run sets failure when context.ref is not a branch", async () => {
  const nonBranchRefs = [
    "refs/tags/v1",
    "refs/pull/123/merge",
    "refs/notes/commits",
    "refs/remotes/origin/main",
    "main", // missing prefix entirely
    "", // empty string
    "refs/heads", // looks like a prefix but no trailing slash
  ];
  for (const ref of nonBranchRefs) {
    const core = makeRecordingCore();
    const { github } = makeGithub();
    await run({
      github,
      context: { ref, repo: { owner: "o", repo: "r" } },
      core,
    });
    const failures = core.calls.filter((c) => c.level === "setFailed");
    assert.equal(failures.length, 1, `ref=${JSON.stringify(ref)}: one setFailed`);
    assert.match(failures[0].args[0], /Expected branch ref/, `ref=${JSON.stringify(ref)}: message`);
  }
});

// --- partial-write guard ---

test("run aborts and refuses to commit when any upstream lookup fails", async () => {
  // Vary which dep(s) fail (first / middle / last / all) and confirm partial-write
  // guard fires regardless.
  const baseDeps = [
    { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true },
    { name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
    { name: "charlie", repo: "acme/charlie", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
  ];
  // Map repo names (used by paginate dispatch on args.repo) to dep.repo strings
  // (which appear in the failure message).
  const cases = [
    { label: "first dep fails", failingRepoNames: ["alpha"], expectInMessage: ["acme/alpha"] },
    { label: "last dep fails", failingRepoNames: ["charlie"], expectInMessage: ["acme/charlie"] },
    { label: "middle dep fails", failingRepoNames: ["bravo"], expectInMessage: ["globex/bravo"] },
    {
      label: "all deps fail",
      failingRepoNames: ["alpha", "bravo", "charlie"],
      expectInMessage: ["acme/alpha", "globex/bravo", "acme/charlie"],
    },
  ];
  for (const { label, failingRepoNames, expectInMessage } of cases) {
    const cfg = withTempFile("config.json", { dependencies: baseDeps });
    const vfile = withTempFile("versions", "ALPHA_VERSION=8.10.1\nBRAVO_VERSION=0.9.8\nCHARLIE_VERSION=1.34.0");
    try {
      const core = makeRecordingCore();
      const { github, calls } = makeGithub({
        "pulls.list": async () => ({ data: [] }),
        "git.deleteRef": async () => {
          throw httpError(404, "Not Found");
        },
        "paginate.iterator": (_fn, args) => {
          if (failingRepoNames.includes(args.repo)) return asyncPagesOf([]);
          return asyncPagesOf([{ tag_name: "v0.0.1", name: "0.0.1", prerelease: false, draft: false }]);
        },
      });

      await run({
        github,
        context: ctx(),
        core,
        configPath: cfg.path,
        versionFilePath: vfile.path,
      });

      const failures = core.calls.filter((c) => c.level === "setFailed");
      assert.equal(failures.length, 1, `${label}: one setFailed`);
      assert.match(failures[0].args[0], /Upstream lookup failed for:/, `${label}: failure prefix`);
      for (const repo of expectInMessage) {
        assert.match(failures[0].args[0], new RegExp(repo.replace(/[./-]/g, "\\$&")), `${label}: ${repo} in message`);
      }
      assert.ok(!calls.some((c) => c.method === "repos.createOrUpdateFileContents"), `${label}: must not commit`);
      assert.ok(!calls.some((c) => c.method === "pulls.create"), `${label}: must not open a PR`);
    } finally {
      cfg.cleanup();
      vfile.cleanup();
    }
  }
});

// --- happy path ---

test("run creates a branch, commits, and opens a PR for new updates", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true }],
  });
  const vfile = withTempFile("versions", "ALPHA_VERSION=8.10.1");
  try {
    const core = makeRecordingCore();
    let prCreated;
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async () => ({}),
      "pulls.create": async (args) => {
        prCreated = args;
        return { data: { number: 1 } };
      },
    });

    await run({
      github,
      context: ctx(),
      core,
      configPath: cfg.path,
      versionFilePath: vfile.path,
    });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(prCreated, "PR should be created");
    assert.match(prCreated.body, /Updated alpha from 8\.10\.1 to 8\.11\.0/);

    const outputs = core.calls.filter((c) => c.level === "setOutput");
    assert.equal(outputs.length, 1);
    assert.deepEqual(outputs[0].args, ["alpha_version", "8.11.0"]);
  } finally {
    cfg.cleanup();
    vfile.cleanup();
  }
});

// --- no-updates path ---

test("run skips PR creation when nothing has changed", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true }],
  });
  const vfile = withTempFile("versions", "ALPHA_VERSION=8.11.0");
  try {
    const core = makeRecordingCore();
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
    });

    await run({
      github,
      context: ctx(),
      core,
      configPath: cfg.path,
      versionFilePath: vfile.path,
    });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(!calls.some((c) => c.method === "pulls.create"));
    assert.ok(!calls.some((c) => c.method === "repos.createOrUpdateFileContents"));
    assert.ok(core.calls.some((c) => c.level === "info" && /No updates found/.test(c.args[0])));
  } finally {
    cfg.cleanup();
    vfile.cleanup();
  }
});

// --- new dep added to config, version file lacks it ---

test("run logs '(not set)' for deps missing from the version file", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [
      { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true },
      // newdep is in config but not yet in the version file
      { name: "newdep", repo: "newowner/newrepo", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true },
    ],
  });
  const vfile = withTempFile("versions", "ALPHA_VERSION=8.10.1");
  try {
    const core = makeRecordingCore();
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "paginate.iterator": (_fn, args) =>
        args.repo === "alpha"
          ? asyncPagesOf([{ tag_name: "x", name: "8.10.1", prerelease: false, draft: false }])
          : asyncPagesOf([{ tag_name: "x", name: "1.0.0", prerelease: false, draft: false }]),
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async () => ({}),
      "pulls.create": async () => ({ data: { number: 1 } }),
    });

    await run({
      github,
      context: ctx(),
      core,
      configPath: cfg.path,
      versionFilePath: vfile.path,
    });

    const infos = core.calls.filter((c) => c.level === "info").map((c) => c.args[0]);
    // Current-versions loop should log newdep with the "(not set)" fallback.
    assert.ok(
      infos.some((m) => /newowner\/newrepo: \(not set\)$/.test(m)),
      `expected current-versions '(not set)' log for newdep; got: ${JSON.stringify(infos)}`,
    );
    // Update-transition loop should log the "(not set) -> 1.0.0" diff.
    assert.ok(
      infos.some((m) => /newowner\/newrepo: \(not set\) -> 1\.0\.0/.test(m)),
      `expected transition log for newdep; got: ${JSON.stringify(infos)}`,
    );
  } finally {
    cfg.cleanup();
    vfile.cleanup();
  }
});

// --- existing-PR path uses branch state for "what's new" ---

test("run reads bot-branch versions when an existing PR is open", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true }],
  });
  const vfile = withTempFile("versions", "ALPHA_VERSION=8.10.1");
  try {
    const core = makeRecordingCore();
    let updatedPR;
    // base (local) = 8.10.1; branch (API) = 8.10.5; upstream = 8.11.0.
    // → orchestrator finds a new bump (latest 8.11.0 ≠ branch 8.10.5),
    //   delegates to createOrUpdatePR which uses base for the body diff.
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [{ number: 42 }] }),
      "repos.getContent": async () => ({
        data: { sha: "x", content: Buffer.from("ALPHA_VERSION=8.10.5").toString("base64") },
      }),
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
      "repos.createOrUpdateFileContents": async () => ({}),
      "pulls.update": async (args) => {
        updatedPR = args;
        return {};
      },
    });

    await run({
      github,
      context: ctx(),
      core,
      configPath: cfg.path,
      versionFilePath: vfile.path,
    });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(updatedPR, "PR should be updated");
    assert.match(updatedPR.body, /Updated alpha from 8\.10\.1 to 8\.11\.0/);
    assert.ok(
      calls.some((c) => c.method === "repos.getContent" && c.args[0].ref === BRANCH_NAME),
      "should read version file from the bot branch",
    );
  } finally {
    cfg.cleanup();
    vfile.cleanup();
  }
});
