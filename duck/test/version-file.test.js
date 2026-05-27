const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVersionFileContent,
  buildVersionFileContent,
  getDependencyVersions,
  VERSION_FILE,
} = require("../lib/version-file");
const { withTempFile, noopCore } = require("./helpers");

test("parseVersionFileContent parses key=value lines, skipping comments and blanks", () => {
  const cases = [
    {
      label: "header only, empty result",
      content: "# header\n\n# another\n",
      expected: {},
    },
    {
      label: "single entry, no header",
      content: "BRAVO_VERSION=0.9.8",
      expected: { bravo: "0.9.8" },
    },
    {
      label: "many entries with header",
      content:
        "# Dependency versions. DO NOT EDIT MANUALLY.\nBRAVO_VERSION=0.9.8\nALPHA_VERSION=8.10.1\nCHARLIE_VERSION=1.34.0\n",
      expected: { bravo: "0.9.8", alpha: "8.10.1", charlie: "1.34.0" },
    },
    {
      label: "comments interspersed",
      content: "BRAVO_VERSION=0.9.8\n# mid-comment\nALPHA_VERSION=8.10.1",
      expected: { bravo: "0.9.8", alpha: "8.10.1" },
    },
    {
      label: "multiple consecutive blanks",
      content: "BRAVO_VERSION=0.9.8\n\n\nALPHA_VERSION=8.10.1",
      expected: { bravo: "0.9.8", alpha: "8.10.1" },
    },
  ];
  for (const { label, content, expected } of cases) {
    assert.deepEqual(parseVersionFileContent(content), expected, label);
  }
});

test("buildVersionFileContent uses updates when present, currentVersions otherwise", () => {
  const cases = [
    {
      label: "single dep, updated",
      deps: [{ name: "alpha" }],
      updates: { alpha: "8.11.0" },
      current: { alpha: "8.10.1" },
      expected: { alpha: "8.11.0" },
    },
    {
      label: "single dep, no update. falls back to current",
      deps: [{ name: "alpha" }],
      updates: {},
      current: { alpha: "8.10.1" },
      expected: { alpha: "8.10.1" },
    },
    {
      label: "two deps, partial update",
      deps: [{ name: "alpha" }, { name: "bravo" }],
      updates: { alpha: "8.11.0" },
      current: { alpha: "8.10.1", bravo: "0.9.8" },
      expected: { alpha: "8.11.0", bravo: "0.9.8" },
    },
    {
      label: "two deps, both updated",
      deps: [{ name: "alpha" }, { name: "bravo" }],
      updates: { alpha: "8.11.0", bravo: "0.10.0" },
      current: { alpha: "8.10.1", bravo: "0.9.8" },
      expected: { alpha: "8.11.0", bravo: "0.10.0" },
    },
    {
      label: "five deps, mix of updated and unchanged",
      deps: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }],
      updates: { a: "1", c: "3", e: "5" },
      current: { a: "0", b: "2", c: "0", d: "4", e: "0" },
      expected: { a: "1", b: "2", c: "3", d: "4", e: "5" },
    },
  ];
  for (const { label, deps, updates, current, expected } of cases) {
    const content = buildVersionFileContent(deps, updates, current);
    assert.match(content, /^# Dependency versions. DO NOT EDIT MANUALLY.$/m, `${label}: header`);
    for (const [name, version] of Object.entries(expected)) {
      const line = new RegExp(`^${name.toUpperCase()}_VERSION=${version.replace(/\./g, "\\.")}$`, "m");
      assert.match(content, line, `${label}: ${name}=${version}`);
    }
  }
});

test("buildVersionFileContent and parseVersionFileContent round-trip", () => {
  const cases = [
    {
      label: "single dep",
      deps: [{ name: "alpha" }],
      updates: {},
      current: { alpha: "8.10.1" },
      expected: { alpha: "8.10.1" },
    },
    {
      label: "two deps with update",
      deps: [{ name: "alpha" }, { name: "bravo" }],
      updates: { alpha: "8.11.0" },
      current: { alpha: "8.10.1", bravo: "0.9.8" },
      expected: { alpha: "8.11.0", bravo: "0.9.8" },
    },
    {
      label: "five deps mixed",
      deps: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }],
      updates: { a: "1", c: "3", e: "5" },
      current: { a: "0", b: "2", c: "0", d: "4", e: "0" },
      expected: { a: "1", b: "2", c: "3", d: "4", e: "5" },
    },
  ];
  for (const { label, deps, updates, current, expected } of cases) {
    const built = buildVersionFileContent(deps, updates, current);
    assert.deepEqual(parseVersionFileContent(built), expected, label);
  }
});

test("getDependencyVersions reads the local file when no ref is given", async () => {
  const cases = [
    {
      label: "header only",
      content: "# header\n",
      expected: {},
    },
    {
      label: "single entry",
      content: "BRAVO_VERSION=0.9.8",
      expected: { bravo: "0.9.8" },
    },
    {
      label: "many entries with comments",
      content: "# header\nBRAVO_VERSION=0.9.8\n# mid\nALPHA_VERSION=8.10.1\nCHARLIE_VERSION=1.34.0",
      expected: { bravo: "0.9.8", alpha: "8.10.1", charlie: "1.34.0" },
    },
    {
      label: "trailing newline",
      content: "BRAVO_VERSION=0.9.8\nALPHA_VERSION=8.10.1\n",
      expected: { bravo: "0.9.8", alpha: "8.10.1" },
    },
  ];
  for (const { label, content, expected } of cases) {
    const fixture = withTempFile("versions", content);
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
    { localPath: "/nonexistent/dir/version-file" },
  );
  assert.deepEqual(versions, {});
});

test("getDependencyVersions reads from the API when a ref is given", async () => {
  const cases = [
    {
      label: "branch ref",
      ref: "main",
      content: "BRAVO_VERSION=0.9.8",
      expected: { bravo: "0.9.8" },
    },
    {
      label: "feature branch ref",
      ref: "feature/x",
      content: "ALPHA_VERSION=8.10.1\nBRAVO_VERSION=0.9.8",
      expected: { alpha: "8.10.1", bravo: "0.9.8" },
    },
    {
      label: "sha ref",
      ref: "abc123def456",
      content: "ECHO_VERSION=1.3.1",
      expected: { echo: "1.3.1" },
    },
    {
      label: "empty content",
      ref: "empty-branch",
      content: "",
      expected: {},
    },
  ];
  for (const { label, ref, content, expected } of cases) {
    let capturedArgs;
    const github = {
      rest: {
        repos: {
          getContent: async (args) => {
            capturedArgs = args;
            return { data: { content: Buffer.from(content).toString("base64") } };
          },
        },
      },
    };
    const context = { repo: { owner: "o", repo: "r" } };

    const versions = await getDependencyVersions({ github, context, core: noopCore }, { ref });

    assert.deepEqual(versions, expected, `${label}: parsed`);
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
    { label: "403 forbidden", status: 403, message: "Forbidden" },
    { label: "500 server error", status: 500, message: "Server error" },
    { label: "502 bad gateway", status: 502, message: "Bad gateway" },
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
