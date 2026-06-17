const test = require("node:test");
const assert = require("node:assert/strict");

const { run } = require("../check-deps");
const { BRANCH_NAME } = require("../lib/pr");
const { withTempFile, makeGithub, makeRecordingCore, makeFetchSha, httpError } = require("./helpers");

const ctx = (ref = "refs/heads/main") => ({ ref, repo: { owner: "o", repo: "r" } });

function asyncPagesOf(...pages) {
  return (async function* () {
    for (const p of pages) yield { data: p };
  })();
}

// Entry as stored in dependency-versions.json.
const e = (version, sha = "h", url = `https://x/${version}.tgz`, extra = {}) => ({
  version,
  url,
  sha256: sha,
  ...extra,
});
const vfile = (map) => withTempFile("versions.json", JSON.stringify(map));

// --- entry guards ---

test("run sets failure when context.ref is not a branch", async () => {
  const nonBranchRefs = ["refs/tags/v1", "refs/pull/123/merge", "main", "", "refs/heads"];
  for (const ref of nonBranchRefs) {
    const core = makeRecordingCore();
    const { github } = makeGithub();
    await run({ github, context: { ref, repo: { owner: "o", repo: "r" } }, core });
    const failures = core.calls.filter((c) => c.level === "setFailed");
    assert.equal(failures.length, 1, `ref=${JSON.stringify(ref)}: one setFailed`);
    assert.match(failures[0].args[0], /Expected branch ref/, `ref=${JSON.stringify(ref)}: message`);
  }
});

// --- partial-write guard (upstream lookup failure) ---

test("run aborts and refuses to commit when any upstream lookup fails", async () => {
  const baseDeps = [
    { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true },
    { name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
    { name: "charlie", repo: "acme/charlie", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
  ];
  const cases = [
    { label: "first dep fails", failing: ["alpha"], expect: ["acme/alpha"] },
    { label: "last dep fails", failing: ["charlie"], expect: ["acme/charlie"] },
    {
      label: "all deps fail",
      failing: ["alpha", "bravo", "charlie"],
      expect: ["acme/alpha", "globex/bravo", "acme/charlie"],
    },
  ];
  for (const { label, failing, expect } of cases) {
    const cfg = withTempFile("config.json", { dependencies: baseDeps });
    const vf = vfile({ alpha: e("8.10.1"), bravo: e("0.9.8"), charlie: e("1.34.0") });
    try {
      const core = makeRecordingCore();
      const { github, calls } = makeGithub({
        "pulls.list": async () => ({ data: [] }),
        "git.deleteRef": async () => {
          throw httpError(404, "Not Found");
        },
        "repos.getCommit": async () => ({ data: { sha: "S" } }),
        "paginate.iterator": (_fn, args) => {
          if (failing.includes(args.repo)) return asyncPagesOf([]);
          return asyncPagesOf([{ tag_name: "v0.0.1", name: "0.0.1", prerelease: false, draft: false }]);
        },
      });

      await run({
        github,
        context: ctx(),
        core,
        configPath: cfg.path,
        versionFilePath: vf.path,
        hash: makeFetchSha({}),
      });

      const failures = core.calls.filter((c) => c.level === "setFailed");
      assert.equal(failures.length, 1, `${label}: one setFailed`);
      assert.match(failures[0].args[0], /Upstream resolution failed for:/, `${label}: failure prefix`);
      for (const repo of expect) {
        assert.match(failures[0].args[0], new RegExp(repo.replace(/[./-]/g, "\\$&")), `${label}: ${repo} in message`);
      }
      assert.ok(!calls.some((c) => c.method === "repos.createOrUpdateFileContents"), `${label}: must not commit`);
      assert.ok(!calls.some((c) => c.method === "pulls.create"), `${label}: must not open a PR`);
    } finally {
      cfg.cleanup();
      vf.cleanup();
    }
  }
});

// --- partial-write guard (hashing failure) ---

test("run aborts and refuses to commit when hashing fails", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true }],
  });
  const vf = vfile({ alpha: e("8.10.1") });
  try {
    const core = makeRecordingCore();
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": () => asyncPagesOf([{ tag_name: "x", name: "8.11.0", prerelease: false, draft: false }]),
    });

    const hash = async () => {
      throw new Error("network down");
    };
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    const failures = core.calls.filter((c) => c.level === "setFailed");
    assert.equal(failures.length, 1);
    assert.match(failures[0].args[0], /Hashing failed for: alpha \(acme\/alpha\)/);
    assert.ok(!calls.some((c) => c.method === "repos.createOrUpdateFileContents"), "must not commit");
    assert.ok(!calls.some((c) => c.method === "pulls.create"), "must not open a PR");
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- happy path ---

test("run creates a branch, commits, and opens a PR for new updates", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true }],
  });
  const vf = vfile({ alpha: e("8.10.1") });
  try {
    const core = makeRecordingCore();
    let prCreated, committed;
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async (args) => {
        committed = args;
        return {};
      },
      "pulls.create": async (args) => {
        prCreated = args;
        return { data: { number: 1 } };
      },
    });

    const url = "https://github.com/acme/alpha/archive/S.tar.gz";
    const hash = makeFetchSha({ [url]: "newsha" });
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(prCreated, "PR should be created");
    assert.match(prCreated.body, /Updated alpha from 8\.10\.1 to 8\.11\.0/);
    assert.deepEqual(hash.hashed, [url], "hashes the new artifact exactly once");

    // The committed manifest records version + url + sha256, with no locked flag.
    const written = JSON.parse(Buffer.from(committed.content, "base64").toString());
    assert.deepEqual(written.alpha, { version: "8.11.0", url, sha256: "newsha" });

    const outputs = core.calls.filter((c) => c.level === "setOutput");
    assert.equal(outputs.length, 1, "one output for the single changed dep");
    assert.deepEqual(outputs[0].args, ["alpha_version", "8.11.0"]);
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- no-updates path: unchanged dep does not re-download ---

test("run skips PR creation and does no download when nothing has changed", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true }],
  });
  const url = "https://github.com/acme/alpha/archive/S.tar.gz";
  const vf = vfile({ alpha: e("8.11.0", "h", url) });
  try {
    const core = makeRecordingCore();
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
    });

    const hash = makeFetchSha({}); // throws if called
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.equal(hash.hashed.length, 0, "unchanged dep must not be re-hashed");
    assert.ok(!calls.some((c) => c.method === "pulls.create"));
    assert.ok(!calls.some((c) => c.method === "repos.createOrUpdateFileContents"));
    assert.ok(core.calls.some((c) => c.level === "info" && /No updates found/.test(c.args[0])));
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- locking ---

test("run holds a locked dep at its pinned version, warns, and does not bump it", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [
      { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true, lock: "8.10.1" },
    ],
  });
  const url = "https://github.com/acme/alpha/archive/S.tar.gz";
  const vf = vfile({ alpha: e("8.10.1", "h", url, { locked: true }) });
  try {
    const core = makeRecordingCore();
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      // A newer version is available upstream but must be ignored.
      "paginate.iterator": () =>
        asyncPagesOf([
          { tag_name: "x", name: "8.11.0", prerelease: false, draft: false },
          { tag_name: "x", name: "8.10.1", prerelease: false, draft: false },
        ]),
    });

    const hash = makeFetchSha({}); // unchanged -> must not be called
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(!calls.some((c) => c.method === "pulls.create"), "locked dep must not open a PR for a bump");
    assert.equal(hash.hashed.length, 0, "unchanged locked dep is not re-hashed");
    // The available 8.11.0 must not be emitted as an update in any form.
    assert.ok(
      !core.calls.some((c) => c.level === "setOutput" && c.args[1] === "8.11.0"),
      "must not signal a bump to 8.11.0",
    );
    const notices = core.calls.filter((c) => c.level === "notice").map((c) => c.args[0]);
    assert.ok(
      notices.some((m) => /alpha is locked to 8\.10\.1/.test(m)),
      `expected lock notice; got ${JSON.stringify(notices)}`,
    );
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- efficiency: only changed deps are downloaded/hashed ---

test("run re-hashes only the dep that changed, carrying the rest forward", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [
      { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true },
      { name: "bravo", repo: "globex/bravo", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true },
    ],
  });
  const alphaUrl = "https://github.com/acme/alpha/archive/S.tar.gz";
  const bravoUrl = "https://github.com/globex/bravo/archive/S.tar.gz";
  // alpha is unchanged (recorded url+sha match what resolves); bravo bumps.
  const vf = vfile({ alpha: e("8.11.0", "alphasha", alphaUrl), bravo: e("0.9.8", "bravosha", bravoUrl) });
  try {
    const core = makeRecordingCore();
    let committed;
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": (_fn, args) =>
        args.repo === "alpha"
          ? asyncPagesOf([{ tag_name: "x", name: "8.11.0", prerelease: false, draft: false }])
          : asyncPagesOf([{ tag_name: "x", name: "0.10.0", prerelease: false, draft: false }]),
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async (args) => {
        committed = args;
        return {};
      },
      "pulls.create": async () => ({ data: { number: 1 } }),
    });

    const hash = makeFetchSha({ [bravoUrl]: "bravonew" });
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.deepEqual(hash.hashed, [bravoUrl], "only the changed dep (bravo) is downloaded/hashed");

    const written = JSON.parse(Buffer.from(committed.content, "base64").toString());
    // alpha carried forward verbatim (sha preserved, no re-download); bravo bumped.
    assert.deepEqual(written.alpha, { version: "8.11.0", url: alphaUrl, sha256: "alphasha" });
    assert.deepEqual(written.bravo, { version: "0.10.0", url: bravoUrl, sha256: "bravonew" });
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- commit-type dependency end to end ---

test("run records a commit-type dep at its SHA, hashes the archive, and notes it is locked", async () => {
  const sha = "d24655a708059d322633e361e2e204983e51f491";
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "wheel", repo: "acme/wheel", type: "commit", commit: sha }],
  });
  const vf = vfile({});
  try {
    const core = makeRecordingCore();
    let committed;
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async (args) => {
        committed = args;
        return {};
      },
      "pulls.create": async () => ({ data: { number: 1 } }),
    });

    const url = `https://github.com/acme/wheel/archive/${sha}.tar.gz`;
    const hash = makeFetchSha({ [url]: "wheelsha" });
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    // No release/tag pagination for a commit pin.
    assert.ok(!calls.some((c) => c.method === "paginate.iterator"), "commit type does not paginate");
    const written = JSON.parse(Buffer.from(committed.content, "base64").toString());
    assert.deepEqual(written.wheel, { version: sha, url, sha256: "wheelsha", locked: true });
    const notices = core.calls.filter((c) => c.level === "notice").map((c) => c.args[0]);
    assert.ok(
      notices.some((m) => new RegExp(`wheel is locked to ${sha}`).test(m)),
      `expected lock notice for commit dep; got ${JSON.stringify(notices)}`,
    );
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

test("run records a newly-locked dep once with the locked flag", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [
      { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true, lock: "8.10.1" },
    ],
  });
  const vf = vfile({}); // not yet recorded
  try {
    const core = makeRecordingCore();
    let committed;
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": () =>
        asyncPagesOf([
          { tag_name: "x", name: "8.11.0", prerelease: false, draft: false },
          { tag_name: "x", name: "8.10.1", prerelease: false, draft: false },
        ]),
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => ({}),
      "repos.getContent": async () => {
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async (args) => {
        committed = args;
        return {};
      },
      "pulls.create": async () => ({ data: { number: 1 } }),
    });

    const url = "https://github.com/acme/alpha/archive/S.tar.gz";
    const hash = makeFetchSha({ [url]: "lockedsha" });
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    const written = JSON.parse(Buffer.from(committed.content, "base64").toString());
    assert.deepEqual(written.alpha, { version: "8.10.1", url, sha256: "lockedsha", locked: true });
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- deps sharing one repo are identified by name, not repo ---

test("run lists deps by name when several share a repo (rtorrent/libtorrent)", async () => {
  // rtorrent and libtorrent both scan rakshasa/rtorrent; labeling log lines by repo
  // would collapse them into two identical, ambiguous entries.
  const cfg = withTempFile("config.json", {
    dependencies: [
      {
        name: "rtorrent",
        repo: "rakshasa/rtorrent",
        pattern: "^v\\d+\\.\\d+(\\.\\d+)?$",
        stripPattern: "^v",
        assetPattern: "^rtorrent-\\d+\\.\\d+(\\.\\d+)?\\.tar\\.gz$",
      },
      {
        name: "libtorrent",
        repo: "rakshasa/rtorrent",
        pattern: "^v\\d+\\.\\d+(\\.\\d+)?$",
        stripPattern: "^v",
        assetPattern: "^libtorrent-\\d+\\.\\d+(\\.\\d+)?\\.tar\\.gz$",
      },
    ],
  });
  // Already up to date, so no PR plumbing is exercised; the listing still prints.
  const vf = vfile({
    rtorrent: e("0.16.14", "rt", "https://dl/rt"),
    libtorrent: e("0.16.14", "lt", "https://dl/lt"),
  });
  try {
    const core = makeRecordingCore();
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async () => {
        throw httpError(404, "Not Found");
      },
      "paginate.iterator": () =>
        asyncPagesOf([
          {
            tag_name: "v0.16.14",
            prerelease: false,
            draft: false,
            assets: [
              { name: "rtorrent-0.16.14.tar.gz", browser_download_url: "https://dl/rt" },
              { name: "libtorrent-0.16.14.tar.gz", browser_download_url: "https://dl/lt" },
            ],
          },
        ]),
    });

    const hash = makeFetchSha({}); // unchanged -> must not be called
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    const infos = core.calls.filter((c) => c.level === "info").map((c) => c.args[0]);
    assert.ok(
      infos.some((m) => /^ {2}- rtorrent: 0\.16\.14$/.test(m)),
      "lists rtorrent by name",
    );
    assert.ok(
      infos.some((m) => /^ {2}- libtorrent: 0\.16\.14$/.test(m)),
      "lists libtorrent by name",
    );
    assert.ok(
      !infos.some((m) => /^ {2}- rakshasa\/rtorrent:/.test(m)),
      "must not label a dependency by its (shared) repo",
    );
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});

// --- existing-PR path uses branch state for "what's new" ---

test("run reads bot-branch versions when an existing PR is open", async () => {
  const cfg = withTempFile("config.json", {
    dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true }],
  });
  const vf = vfile({ alpha: e("8.10.1") });
  try {
    const core = makeRecordingCore();
    let updatedPR;
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [{ number: 42 }] }),
      "repos.getContent": async () => ({
        data: { content: Buffer.from(JSON.stringify({ alpha: e("8.10.5") })).toString("base64") },
      }),
      "repos.getCommit": async () => ({ data: { sha: "S" } }),
      "paginate.iterator": () =>
        asyncPagesOf([{ tag_name: "irrelevant", name: "8.11.0", prerelease: false, draft: false }]),
      "repos.createOrUpdateFileContents": async () => ({}),
      "pulls.update": async (args) => {
        updatedPR = args;
        return {};
      },
    });

    const url = "https://github.com/acme/alpha/archive/S.tar.gz";
    const hash = makeFetchSha({ [url]: "newsha" });
    await run({ github, context: ctx(), core, configPath: cfg.path, versionFilePath: vf.path, hash });

    assert.equal(core.calls.filter((c) => c.level === "setFailed").length, 0);
    assert.ok(updatedPR, "PR should be updated");
    assert.match(updatedPR.body, /Updated alpha from 8\.10\.1 to 8\.11\.0/);
    assert.ok(
      calls.some((c) => c.method === "repos.getContent" && c.args[0].ref === BRANCH_NAME),
      "should read version file from the bot branch",
    );
  } finally {
    cfg.cleanup();
    vf.cleanup();
  }
});
