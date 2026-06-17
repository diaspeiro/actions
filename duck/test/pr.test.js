const test = require("node:test");
const assert = require("node:assert/strict");

const { findExistingPR, commitVersions, createOrUpdatePR, BRANCH_NAME } = require("../lib/pr");
const { buildVersionFileContent, VERSION_FILE } = require("../lib/version-file");
const { noopCore, makeGithub, httpError } = require("./helpers");

const ctx = { repo: { owner: "o", repo: "r" } };

// Build a version entry the way the orchestrator does.
const e = (version, extra = {}) => ({ version, url: `https://x/${version}.tgz`, sha256: `sha-${version}`, ...extra });

// --- findExistingPR ---

test("findExistingPR returns the first open PR for the bot branch", async () => {
  let listArgs;
  const { github } = makeGithub({
    "pulls.list": async (args) => {
      listArgs = args;
      return { data: [{ number: 42, head: { ref: BRANCH_NAME } }] };
    },
  });
  const pr = await findExistingPR({ github, context: ctx, core: noopCore });
  assert.equal(pr.number, 42);
  assert.equal(listArgs.state, "open");
  assert.equal(listArgs.head, `${ctx.repo.owner}:${BRANCH_NAME}`);
});

test("findExistingPR deletes the orphan branch when no PR is open", async () => {
  let deleteArgs;
  const { github, calls } = makeGithub({
    "pulls.list": async () => ({ data: [] }),
    "git.deleteRef": async (args) => {
      deleteArgs = args;
      return {};
    },
  });
  const pr = await findExistingPR({ github, context: ctx, core: noopCore });
  assert.equal(pr, null);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["pulls.list", "git.deleteRef"],
  );
  assert.equal(deleteArgs.ref, `heads/${BRANCH_NAME}`);
});

test("findExistingPR is silent when there's no orphan branch", async () => {
  const cases = [
    { label: "404 Not Found", status: 404, message: "Not Found" },
    { label: "422 Reference does not exist", status: 422, message: "Reference does not exist" },
  ];
  for (const { label, status, message } of cases) {
    const warnings = [];
    const core = { ...noopCore, warning: (m) => warnings.push(m) };
    let deleteArgs;
    const { github, calls } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async (args) => {
        deleteArgs = args;
        throw httpError(status, message);
      },
    });
    const pr = await findExistingPR({ github, context: ctx, core });
    assert.equal(pr, null, `${label}: pr null`);
    assert.equal(warnings.length, 0, `${label}: no warning`);
    assert.ok(
      calls.some((c) => c.method === "git.deleteRef"),
      `${label}: deleteRef called`,
    );
    assert.equal(deleteArgs.ref, `heads/${BRANCH_NAME}`, `${label}: ref`);
  }
});

test("findExistingPR warns on unexpected errors from deleteRef", async () => {
  const cases = [
    { label: "401", status: 401, message: "Unauthorized" },
    { label: "500", status: 500, message: "boom" },
    { label: "422 other", status: 422, message: "Validation Failed" },
    { label: "no status", status: undefined, message: "ECONNRESET" },
  ];
  for (const { label, status, message } of cases) {
    const warnings = [];
    const core = { ...noopCore, warning: (m) => warnings.push(m) };
    let deleteArgs;
    const { github } = makeGithub({
      "pulls.list": async () => ({ data: [] }),
      "git.deleteRef": async (args) => {
        deleteArgs = args;
        const err = new Error(message);
        if (status !== undefined) err.status = status;
        throw err;
      },
    });
    const pr = await findExistingPR({ github, context: ctx, core });
    assert.equal(pr, null, `${label}: pr null`);
    assert.equal(warnings.length, 1, `${label}: one warning`);
    assert.match(warnings[0], /Failed to delete orphaned branch/, `${label}: warning prefix`);
    assert.match(warnings[0], new RegExp(message), `${label}: warning includes message`);
    assert.equal(deleteArgs.ref, `heads/${BRANCH_NAME}`, `${label}: ref`);
  }
});

// --- commitVersions ---

const dependencies = [{ name: "alpha" }, { name: "bravo" }];
const updates = { alpha: e("8.11.0") };
const currentVersions = { alpha: e("8.10.1"), bravo: e("0.9.8") };
const expectedContent = buildVersionFileContent(dependencies, updates, currentVersions);

test("commitVersions skips when remote content already matches", async () => {
  let readArgs;
  const { github, calls } = makeGithub({
    "repos.getContent": async (args) => {
      readArgs = args;
      return { data: { sha: "abc", content: Buffer.from(expectedContent).toString("base64") } };
    },
  });
  await commitVersions({ github, context: ctx, core: noopCore }, dependencies, updates, currentVersions, "bot/branch");
  assert.ok(
    !calls.some((c) => c.method === "repos.createOrUpdateFileContents"),
    "should not call createOrUpdateFileContents",
  );
  assert.equal(readArgs.path, VERSION_FILE);
  assert.equal(readArgs.ref, "bot/branch");
});

test("commitVersions commits with sha when content differs", async () => {
  let readArgs, committed;
  const { github, calls } = makeGithub({
    "repos.getContent": async (args) => {
      readArgs = args;
      return { data: { sha: "abc", content: Buffer.from("{}").toString("base64") } };
    },
    "repos.createOrUpdateFileContents": async (args) => {
      committed = args;
      return {};
    },
  });
  await commitVersions({ github, context: ctx, core: noopCore }, dependencies, updates, currentVersions, "bot/branch");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["repos.getContent", "repos.createOrUpdateFileContents"],
  );
  assert.equal(readArgs.path, VERSION_FILE);
  assert.equal(readArgs.ref, "bot/branch");
  assert.equal(committed.sha, "abc");
  assert.equal(committed.branch, "bot/branch");
  assert.equal(committed.path, VERSION_FILE);
  // [skip ci] is load-bearing. Without it the bot's commit retriggers CI.
  assert.match(committed.message, /\[skip ci\]/);
  assert.equal(Buffer.from(committed.content, "base64").toString(), expectedContent);
});

test("commitVersions commits without a sha when the file does not exist", async () => {
  let readArgs, committed;
  const { github, calls } = makeGithub({
    "repos.getContent": async (args) => {
      readArgs = args;
      throw httpError(404, "Not Found");
    },
    "repos.createOrUpdateFileContents": async (args) => {
      committed = args;
      return {};
    },
  });
  await commitVersions({ github, context: ctx, core: noopCore }, dependencies, updates, currentVersions, "bot/branch");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["repos.getContent", "repos.createOrUpdateFileContents"],
  );
  assert.equal(readArgs.path, VERSION_FILE);
  assert.equal(readArgs.ref, "bot/branch");
  assert.equal(committed.sha, undefined);
  assert.equal(committed.path, VERSION_FILE);
  assert.equal(committed.branch, "bot/branch");
  assert.equal(Buffer.from(committed.content, "base64").toString(), expectedContent);
});

test("commitVersions propagates non-404 errors from getContent", async () => {
  const cases = [
    { label: "401", status: 401, message: "Unauthorized" },
    { label: "500", status: 500, message: "Server error" },
    { label: "no status", status: undefined, message: "ECONNRESET" },
  ];
  for (const { label, status, message } of cases) {
    const { github } = makeGithub({
      "repos.getContent": async () => {
        const err = new Error(message);
        if (status !== undefined) err.status = status;
        throw err;
      },
    });
    await assert.rejects(
      commitVersions({ github, context: ctx, core: noopCore }, dependencies, updates, currentVersions, "bot/branch"),
      new RegExp(message),
      label,
    );
  }
});

// --- createOrUpdatePR ---

test("createOrUpdatePR composes 'Updated from', 'Added', and locked body lines", async () => {
  const cases = [
    {
      label: "all 'Added' (no base versions)",
      deps: [{ name: "a" }, { name: "b" }],
      baseVersions: {},
      updates: { a: e("1.0.0"), b: e("2.0.0") },
      expectMatch: [/^- Added a version 1\.0\.0$/m, /^- Added b version 2\.0\.0$/m],
      expectMiss: [/Updated a/, /Updated b/],
    },
    {
      label: "all 'Updated' (every dep has a base version)",
      deps: [{ name: "a" }, { name: "b" }],
      baseVersions: { a: e("0.9.0"), b: e("1.9.0") },
      updates: { a: e("1.0.0"), b: e("2.0.0") },
      expectMatch: [/^- Updated a from 0\.9\.0 to 1\.0\.0$/m, /^- Updated b from 1\.9\.0 to 2\.0\.0$/m],
      expectMiss: [/Added a/, /Added b/],
    },
    {
      label: "mixed: one updated, one added",
      deps: [{ name: "alpha" }, { name: "newdep" }],
      baseVersions: { alpha: e("8.10.1") },
      updates: { alpha: e("8.11.0"), newdep: e("1.0.0") },
      expectMatch: [/^- Updated alpha from 8\.10\.1 to 8\.11\.0$/m, /^- Added newdep version 1\.0\.0$/m],
      expectMiss: [/Added alpha/, /Updated newdep/],
    },
    {
      label: "locked dep is marked",
      deps: [{ name: "a" }],
      baseVersions: { a: e("0.9.0") },
      updates: { a: e("1.0.0", { locked: true }) },
      expectMatch: [/^- Updated a from 0\.9\.0 to 1\.0\.0 \(locked\)$/m],
      expectMiss: [/Added a/],
    },
    {
      // Same version but a new url/sha (e.g. upstream re-tagged or the asset URL
      // moved): reported as a re-pin, not a version bump.
      label: "re-pinned dep (same version, new sha)",
      deps: [{ name: "a" }],
      baseVersions: { a: e("1.0.0", { url: "https://x/old", sha256: "old" }) },
      updates: { a: e("1.0.0", { url: "https://x/new", sha256: "new" }) },
      expectMatch: [/^- Re-pinned a at 1\.0\.0$/m],
      expectMiss: [/Updated a/, /Added a/],
    },
  ];
  for (const { label, deps, baseVersions, updates: upd, expectMatch, expectMiss } of cases) {
    let prCreated;
    const sequence = [];
    const { github } = makeGithub({
      "git.getRef": async () => {
        sequence.push("getRef");
        return { data: { object: { sha: "abc" } } };
      },
      "git.createRef": async () => {
        sequence.push("createRef");
        return {};
      },
      "repos.getContent": async () => {
        sequence.push("getContent");
        throw httpError(404, "Not Found");
      },
      "repos.createOrUpdateFileContents": async () => {
        sequence.push("commit");
        return {};
      },
      "pulls.create": async (args) => {
        sequence.push("createPR");
        prCreated = args;
        return { data: { number: 7 } };
      },
    });
    await createOrUpdatePR(
      { github, context: ctx, core: noopCore },
      deps,
      upd,
      baseVersions,
      baseVersions,
      null,
      "main",
    );
    assert.deepEqual(sequence, ["getRef", "createRef", "getContent", "commit", "createPR"], `${label}: sequence`);
    for (const re of expectMatch) {
      assert.match(prCreated.body, re, `${label}: body should contain ${re}`);
    }
    for (const re of expectMiss) {
      assert.doesNotMatch(prCreated.body, re, `${label}: body should NOT contain ${re}`);
    }
    assert.equal(prCreated.head, BRANCH_NAME, `${label}: head`);
    assert.equal(prCreated.base, "main", `${label}: base`);
    assert.equal(prCreated.title, "chore: Update dependencies", `${label}: title`);
  }
});

test("createOrUpdatePR closes the PR and deletes the branch when net diff is empty", async () => {
  const deps = [{ name: "alpha" }];
  const baseVersions = { alpha: e("8.11.0") };
  const branchVersions = { alpha: e("8.11.0") };
  const upd = {};

  let closedPR, deletedRef;
  const { github, calls } = makeGithub({
    "pulls.update": async (args) => {
      closedPR = args;
      return {};
    },
    "git.deleteRef": async (args) => {
      deletedRef = args.ref;
      return {};
    },
  });

  await createOrUpdatePR(
    { github, context: ctx, core: noopCore },
    deps,
    upd,
    baseVersions,
    branchVersions,
    { number: 42 },
    "main",
  );

  assert.deepEqual(
    calls.map((c) => c.method),
    ["pulls.update", "git.deleteRef"],
  );
  assert.equal(closedPR.pull_number, 42);
  assert.equal(closedPR.state, "closed");
  assert.equal(deletedRef, `heads/${BRANCH_NAME}`);
});

test("createOrUpdatePR is a no-op when net diff is empty and no PR exists", async () => {
  const deps = [{ name: "alpha" }];
  const baseVersions = { alpha: e("8.11.0") };
  const branchVersions = { alpha: e("8.11.0") };

  const { github, calls } = makeGithub({});

  await createOrUpdatePR(
    { github, context: ctx, core: noopCore },
    deps,
    {},
    baseVersions,
    branchVersions,
    null,
    "main",
  );

  assert.equal(calls.length, 0, "no API calls should happen");
});

test("createOrUpdatePR creates branch, commits, and creates PR when no PR exists", async () => {
  const deps = [{ name: "alpha" }];
  const baseVersions = { alpha: e("8.10.1") };
  const upd = { alpha: e("8.11.0") };

  const sequence = [];
  let getRefArgs, createRefArgs, commitArgs;
  const { github } = makeGithub({
    "git.getRef": async (args) => {
      sequence.push("getRef");
      getRefArgs = args;
      return { data: { object: { sha: "abc" } } };
    },
    "git.createRef": async (args) => {
      sequence.push("createRef");
      createRefArgs = args;
      return {};
    },
    "repos.getContent": async () => {
      sequence.push("getContent");
      throw httpError(404, "Not Found");
    },
    "repos.createOrUpdateFileContents": async (args) => {
      sequence.push("commit");
      commitArgs = args;
      return {};
    },
    "pulls.create": async () => {
      sequence.push("createPR");
      return { data: { number: 1 } };
    },
  });

  await createOrUpdatePR({ github, context: ctx, core: noopCore }, deps, upd, baseVersions, baseVersions, null, "main");

  assert.deepEqual(sequence, ["getRef", "createRef", "getContent", "commit", "createPR"]);
  assert.equal(getRefArgs.ref, "heads/main");
  assert.equal(createRefArgs.ref, `refs/heads/${BRANCH_NAME}`);
  assert.equal(createRefArgs.sha, "abc");
  assert.equal(commitArgs.branch, BRANCH_NAME);
});

test("createOrUpdatePR updates an existing PR without re-creating the branch", async () => {
  const deps = [{ name: "alpha" }];
  const baseVersions = { alpha: e("8.10.1") };
  const upd = { alpha: e("8.11.0") };

  let updatedPR, commitArgs;
  const { github, calls } = makeGithub({
    "repos.getContent": async () => ({
      data: { sha: "x", content: Buffer.from("{}").toString("base64") },
    }),
    "repos.createOrUpdateFileContents": async (args) => {
      commitArgs = args;
      return {};
    },
    "pulls.update": async (args) => {
      updatedPR = args;
      return {};
    },
  });

  await createOrUpdatePR(
    { github, context: ctx, core: noopCore },
    deps,
    upd,
    baseVersions,
    baseVersions,
    { number: 42 },
    "main",
  );

  assert.ok(!calls.some((c) => c.method === "git.getRef"));
  assert.ok(!calls.some((c) => c.method === "git.createRef"));
  assert.equal(updatedPR.pull_number, 42);
  assert.match(updatedPR.body, /Updated alpha from 8\.10\.1 to 8\.11\.0/);
  assert.equal(commitArgs.branch, BRANCH_NAME);
});

test("createOrUpdatePR tolerates 422 'Reference already exists' on createRef and continues", async () => {
  const deps = [{ name: "alpha" }];
  const baseVersions = { alpha: e("8.10.1") };
  const upd = { alpha: e("8.11.0") };

  const sequence = [];
  let getRefArgs, createRefArgs;
  const { github } = makeGithub({
    "git.getRef": async (args) => {
      sequence.push("getRef");
      getRefArgs = args;
      return { data: { object: { sha: "abc" } } };
    },
    "git.createRef": async (args) => {
      sequence.push("createRef");
      createRefArgs = args;
      throw httpError(422, "Reference already exists");
    },
    "repos.getContent": async () => {
      sequence.push("getContent");
      throw httpError(404, "Not Found");
    },
    "repos.createOrUpdateFileContents": async () => {
      sequence.push("commit");
      return {};
    },
    "pulls.create": async () => {
      sequence.push("createPR");
      return { data: { number: 1 } };
    },
  });

  await createOrUpdatePR({ github, context: ctx, core: noopCore }, deps, upd, baseVersions, baseVersions, null, "main");

  assert.deepEqual(sequence, ["getRef", "createRef", "getContent", "commit", "createPR"]);
  assert.equal(getRefArgs.ref, "heads/main");
  assert.equal(createRefArgs.ref, `refs/heads/${BRANCH_NAME}`);
  assert.equal(createRefArgs.sha, "abc");
});

test("createOrUpdatePR propagates createRef errors that don't match the tolerated 422 case", async () => {
  const cases = [
    { label: "500", status: 500, message: "boom" },
    { label: "401", status: 401, message: "Unauthorized" },
    { label: "no status", status: undefined, message: "ECONNRESET" },
    { label: "422 with non-matching message", status: 422, message: "Validation Failed: ref must be unique" },
  ];
  for (const { label, status, message } of cases) {
    const { github } = makeGithub({
      "git.getRef": async () => ({ data: { object: { sha: "abc" } } }),
      "git.createRef": async () => {
        const err = new Error(message);
        if (status !== undefined) err.status = status;
        throw err;
      },
    });
    await assert.rejects(
      createOrUpdatePR(
        { github, context: ctx, core: noopCore },
        [{ name: "alpha" }],
        { alpha: e("8.11.0") },
        { alpha: e("8.10.1") },
        { alpha: e("8.10.1") },
        null,
        "main",
      ),
      new RegExp(message.split(":")[0]),
      label,
    );
  }
});
