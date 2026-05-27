const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfiguration } = require("../lib/config");
const { withTempFile, noopCore } = require("./helpers");

function withConfig(content) {
  return withTempFile("config.json", content);
}

test("loadConfiguration parses valid configs and compiles regexes", async () => {
  // Vary cardinality (1/2/5 deps), mode permutations (useName/matchTag/default),
  // and value diversity (mixed-case repo, hyphens, dots, underscores).
  const cases = [
    {
      label: "single dep, stripPattern mode",
      dependencies: [{ name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" }],
    },
    {
      label: "single dep, useName mode",
      dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true }],
    },
    {
      label: "single dep, matchTag mode",
      dependencies: [
        { name: "echo", repo: "initech/echo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v", matchTag: true },
      ],
    },
    {
      label: "two deps, mixed modes",
      dependencies: [
        { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true },
        { name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
      ],
    },
    {
      label: "five deps mixed",
      dependencies: [
        { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", useName: true },
        { name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
        { name: "charlie", repo: "acme/charlie", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
        {
          name: "delta",
          repo: "acme/delta",
          pattern: "^delta-\\d+\\.\\d+\\.\\d+$",
          stripPattern: "^delta-",
        },
        { name: "echo", repo: "initech/echo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v", matchTag: true },
      ],
    },
    {
      label: "mixed-case repo (case-insensitive validation)",
      dependencies: [{ name: "myDep", repo: "OwNeR/RePo", pattern: "^v\\d+$", stripPattern: "^v" }],
    },
  ];

  for (const { label, dependencies } of cases) {
    const fixture = withConfig({ dependencies });
    try {
      const result = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(result.length, dependencies.length, `${label}: dep count`);
      for (let i = 0; i < dependencies.length; i++) {
        const expected = dependencies[i];
        const actual = result[i];
        assert.equal(actual.name, expected.name, `${label}: name[${i}]`);
        assert.equal(actual.repo, expected.repo, `${label}: repo[${i}]`);
        assert.ok(actual.pattern instanceof RegExp, `${label}: pattern[${i}] is RegExp`);
        assert.equal(actual.pattern.source, expected.pattern, `${label}: pattern.source[${i}]`);
        assert.ok(actual.stripPattern instanceof RegExp, `${label}: stripPattern[${i}] is RegExp`);
        // Optional flags should pass through unchanged.
        if (expected.useName) assert.equal(actual.useName, true, `${label}: useName[${i}]`);
        if (expected.matchTag) assert.equal(actual.matchTag, true, `${label}: matchTag[${i}]`);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration accepts valid shell-identifier names", async () => {
  const validNames = [
    "bravo", // simple lowercase
    "_underscore", // leading underscore
    "Snake_case", // mixed case
    "fooBar123", // letters + digits
    "x", // single char
    "_", // single underscore
    "ABC", // all caps
    "a_b_1_2", // underscores and digits
  ];
  for (const name of validNames) {
    const fixture = withConfig({
      dependencies: [{ name, repo: "a/b", pattern: "." }],
    });
    try {
      const deps = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(deps[0].name, name, `name=${JSON.stringify(name)} should be accepted`);
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration accepts valid owner/name repo strings", async () => {
  const validRepos = [
    "owner/repo",
    "Owner/Repo", // mixed case (case-insensitive regex)
    "ALL-CAPS/repo",
    "with-hyphens/and-more",
    "with.dots/and.more",
    "user_name/repo_name",
    "abc123/repo456",
  ];
  for (const repo of validRepos) {
    const fixture = withConfig({
      dependencies: [{ name: "x", repo, pattern: "." }],
    });
    try {
      const deps = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(deps[0].repo, repo, `repo=${JSON.stringify(repo)} should be accepted`);
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects names that aren't shell identifiers", async () => {
  for (const badName of ["has-hyphen", "1leading-digit", "has.dot", "has space", ""]) {
    const fixture = withConfig({
      dependencies: [{ name: badName, repo: "x/y", pattern: "." }],
    });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /Invalid dep name/,
        `expected rejection for name=${JSON.stringify(badName)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects repos without an owner/name shape", async () => {
  for (const badRepo of ["norepo", "/leading", "trailing/", "too/many/slashes"]) {
    const fixture = withConfig({
      dependencies: [{ name: "x", repo: badRepo, pattern: "." }],
    });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /Invalid dep\.repo/,
        `expected rejection for repo=${JSON.stringify(badRepo)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects configs whose 'dependencies' field is empty, missing, or non-array", async () => {
  const cases = [
    { label: "empty array", body: { dependencies: [] } },
    { label: "missing key", body: {} },
    { label: "null", body: { dependencies: null } },
    { label: "string instead of array", body: { dependencies: "bravo,alpha" } },
    { label: "object instead of array", body: { dependencies: { bravo: {} } } },
  ];
  for (const { label, body } of cases) {
    const fixture = withConfig(body);
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /non-empty 'dependencies' array/,
        `expected rejection for ${label}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects deps with invalid regexes and names which field broke", async () => {
  const cases = [
    {
      label: "unterminated character class in pattern",
      dep: { name: "x", repo: "a/b", pattern: "[" },
      match: /Invalid regex for dep "x" pattern:/,
    },
    {
      label: "unterminated group in pattern",
      dep: { name: "x", repo: "a/b", pattern: "(abc" },
      match: /Invalid regex for dep "x" pattern:/,
    },
    {
      label: "invalid quantifier in pattern",
      dep: { name: "x", repo: "a/b", pattern: "*" },
      match: /Invalid regex for dep "x" pattern:/,
    },
    {
      label: "unterminated character class in stripPattern",
      dep: { name: "x", repo: "a/b", pattern: ".", stripPattern: "[" },
      match: /Invalid regex for dep "x" stripPattern:/,
    },
    {
      label: "unterminated group in stripPattern",
      dep: { name: "x", repo: "a/b", pattern: ".", stripPattern: "(abc" },
      match: /Invalid regex for dep "x" stripPattern:/,
    },
  ];
  for (const { label, dep, match } of cases) {
    const fixture = withConfig({ dependencies: [dep] });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        match,
        `expected rejection for ${label}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration handles stripPattern variants", async () => {
  // Known-true: "absent" forms should all default to a no-op.
  const noOpCases = [
    { label: "missing key", dep: { name: "x", repo: "a/b", pattern: "." } },
    { label: "explicit null", dep: { name: "x", repo: "a/b", pattern: ".", stripPattern: null } },
    { label: "empty string", dep: { name: "x", repo: "a/b", pattern: ".", stripPattern: "" } },
  ];
  for (const { label, dep } of noOpCases) {
    const fixture = withConfig({ dependencies: [dep] });
    try {
      const deps = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.ok(deps[0].stripPattern instanceof RegExp, `${label}: instanceof RegExp`);
      // Inputs with candidate prefixes: non-empty defaults would modify them.
      assert.equal("v8.10.1".replace(deps[0].stripPattern, ""), "v8.10.1", `${label}: 'v' not stripped`);
      assert.equal("delta-3.0.0".replace(deps[0].stripPattern, ""), "delta-3.0.0", `${label}: 'delta-' not stripped`);
    } finally {
      fixture.cleanup();
    }
  }

  // Known-false: explicit non-no-op stripPatterns should actually strip.
  const stripCases = [
    { label: "strip 'v' prefix", stripPattern: "^v", input: "v8.10.1", expected: "8.10.1" },
    { label: "strip 'delta-' prefix", stripPattern: "^delta-", input: "delta-3.0.0", expected: "3.0.0" },
    { label: "strip trailing '-rc1'", stripPattern: "-rc1$", input: "1.2.3-rc1", expected: "1.2.3" },
  ];
  for (const { label, stripPattern, input, expected } of stripCases) {
    const fixture = withConfig({
      dependencies: [{ name: "x", repo: "a/b", pattern: ".", stripPattern }],
    });
    try {
      const deps = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(input.replace(deps[0].stripPattern, ""), expected, label);
    } finally {
      fixture.cleanup();
    }
  }
});
