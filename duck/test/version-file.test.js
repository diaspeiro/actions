const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildVersionFileContent,
  getDependencyVersions,
  entryChanged,
  entriesEqual,
  VERSION_FILE,
} = require("../lib/version-file");
const { withTempFile, noopCore } = require("./helpers");

const entry = (version, sha = "aa", url = `https://x/${version}.tgz`, extra = {}) => ({
  version,
  url,
  sha256: sha,
  ...extra,
});

test("buildVersionFileContent uses updates when present, currentVersions otherwise, in dep order", () => {
  const cases = [
    {
      label: "single dep, updated",
      deps: [{ name: "alpha" }],
      updates: { alpha: entry("8.11.0") },
      current: { alpha: entry("8.10.1") },
      expected: { alpha: entry("8.11.0") },
    },
    {
      label: "single dep, no update -> falls back to current",
      deps: [{ name: "alpha" }],
      updates: {},
      current: { alpha: entry("8.10.1") },
      expected: { alpha: entry("8.10.1") },
    },
    {
      label: "two deps, partial update",
      deps: [{ name: "alpha" }, { name: "bravo" }],
      updates: { alpha: entry("8.11.0") },
      current: { alpha: entry("8.10.1"), bravo: entry("0.9.8") },
      expected: { alpha: entry("8.11.0"), bravo: entry("0.9.8") },
    },
    {
      label: "dep present in neither updates nor current is omitted",
      deps: [{ name: "alpha" }, { name: "ghost" }],
      updates: {},
      current: { alpha: entry("8.10.1") },
      expected: { alpha: entry("8.10.1") },
    },
  ];
  for (const { label, deps, updates, current, expected } of cases) {
    const content = buildVersionFileContent(deps, updates, current);
    assert.equal(content.endsWith("\n"), true, `${label}: trailing newline`);
    assert.deepEqual(JSON.parse(content), expected, label);
  }
});

test("buildVersionFileContent serializes in dependency order", () => {
  const deps = [{ name: "b" }, { name: "a" }, { name: "c" }];
  const content = buildVersionFileContent(deps, {}, { a: entry("1"), b: entry("2"), c: entry("3") });
  assert.deepEqual(Object.keys(JSON.parse(content)), ["b", "a", "c"]);
});

test("buildVersionFileContent emits valid JSON that round-trips", () => {
  const deps = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const current = { a: entry("0"), b: entry("2"), c: entry("0") };
  const updates = { a: entry("1"), c: entry("3", "ff", "https://x/3.tgz", { locked: true }) };
  const built = buildVersionFileContent(deps, updates, current);
  assert.deepEqual(JSON.parse(built), {
    a: entry("1"),
    b: entry("2"),
    c: entry("3", "ff", "https://x/3.tgz", { locked: true }),
  });
});

test("entryChanged detects version/url moves and ignores sha-only differences", () => {
  const prev = entry("1.0.0", "aa", "https://x/1.0.0.tgz");
  assert.equal(entryChanged(undefined, prev), true, "missing prev -> changed");
  assert.equal(entryChanged(prev, entry("1.0.0", "aa", "https://x/1.0.0.tgz")), false, "identical -> unchanged");
  assert.equal(entryChanged(prev, entry("1.0.0", "bb", "https://x/1.0.0.tgz")), false, "sha-only diff -> unchanged");
  assert.equal(entryChanged(prev, entry("1.0.1", "aa", "https://x/1.0.0.tgz")), true, "version move -> changed");
  assert.equal(entryChanged(prev, entry("1.0.0", "aa", "https://y/1.0.0.tgz")), true, "url move -> changed");
});

test("entriesEqual compares version, url, sha256, and the locked flag", () => {
  const a = entry("1.0.0", "aa", "https://x/1.0.0.tgz");
  assert.equal(entriesEqual(a, entry("1.0.0", "aa", "https://x/1.0.0.tgz")), true);
  assert.equal(entriesEqual(a, undefined), false);
  assert.equal(entriesEqual(a, entry("1.0.0", "bb", "https://x/1.0.0.tgz")), false, "sha differs");
  assert.equal(entriesEqual(a, entry("1.0.0", "aa", "https://x/1.0.0.tgz", { locked: true })), false, "lock toggled");
});

test("getDependencyVersions reads the local JSON file when no ref is given", async () => {
  const cases = [
    { label: "empty", content: "{}", expected: {} },
    {
      label: "single entry",
      content: JSON.stringify({ bravo: entry("0.9.8") }),
      expected: { bravo: entry("0.9.8") },
    },
    {
      label: "many entries",
      content: JSON.stringify({ bravo: entry("0.9.8"), alpha: entry("8.10.1") }),
      expected: { bravo: entry("0.9.8"), alpha: entry("8.10.1") },
    },
  ];
  for (const { label, content, expected } of cases) {
    const fixture = withTempFile("versions.json", content);
    try {
      const versions = await getDependencyVersions(
        { github: null, context: null, core: noopCore },
        { localPath: fixture.path },
      );
      assert.deepEqual(versions, expected, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test("getDependencyVersions returns empty object when local file is missing", async () => {
  const versions = await getDependencyVersions(
    { github: null, context: null, core: noopCore },
    { localPath: "/nonexistent/dir/versions.json" },
  );
  assert.deepEqual(versions, {});
});

test("getDependencyVersions reads from the API when a ref is given", async () => {
  const cases = [
    { label: "branch ref", ref: "main", map: { bravo: entry("0.9.8") } },
    { label: "feature branch ref", ref: "feature/x", map: { alpha: entry("8.10.1"), bravo: entry("0.9.8") } },
    { label: "empty content", ref: "empty-branch", map: {} },
  ];
  for (const { label, ref, map } of cases) {
    let capturedArgs;
    const github = {
      rest: {
        repos: {
          getContent: async (args) => {
            capturedArgs = args;
            return { data: { content: Buffer.from(JSON.stringify(map)).toString("base64") } };
          },
        },
      },
    };
    const context = { repo: { owner: "o", repo: "r" } };

    const versions = await getDependencyVersions({ github, context, core: noopCore }, { ref });

    assert.deepEqual(versions, map, `${label}: parsed`);
    assert.equal(capturedArgs.owner, "o", `${label}: owner`);
    assert.equal(capturedArgs.repo, "r", `${label}: repo`);
    assert.equal(capturedArgs.ref, ref, `${label}: ref`);
    assert.equal(capturedArgs.path, VERSION_FILE, `${label}: path`);
  }
});

test("getDependencyVersions returns empty object on a 404 from the API", async () => {
  const github = {
    rest: {
      repos: {
        getContent: async () => {
          const err = new Error("Not Found");
          err.status = 404;
          throw err;
        },
      },
    },
  };
  const context = { repo: { owner: "o", repo: "r" } };
  const versions = await getDependencyVersions({ github, context, core: noopCore }, { ref: "any" });
  assert.deepEqual(versions, {});
});

test("getDependencyVersions propagates non-404 errors from the API", async () => {
  const cases = [
    { label: "401 unauthorized", status: 401, message: "Unauthorized" },
    { label: "500 server error", status: 500, message: "Server error" },
    { label: "error without status", status: undefined, message: "ECONNRESET" },
  ];
  for (const { label, status, message } of cases) {
    const github = {
      rest: {
        repos: {
          getContent: async () => {
            const err = new Error(message);
            if (status !== undefined) err.status = status;
            throw err;
          },
        },
      },
    };
    const context = { repo: { owner: "o", repo: "r" } };
    await assert.rejects(
      getDependencyVersions({ github, context, core: noopCore }, { ref: "any" }),
      new RegExp(message),
      label,
    );
  }
});
