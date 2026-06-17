const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfiguration } = require("../lib/config");
const { withTempFile, noopCore } = require("./helpers");

function withConfig(content) {
  return withTempFile("config.json", content);
}

test("loadConfiguration parses valid configs and compiles regexes", async () => {
  // Vary cardinality, type permutations (matchReleaseName / type:tag / default release),
  // and value diversity (mixed-case repo, hyphens, dots, underscores).
  const cases = [
    {
      label: "single dep, stripPattern mode",
      dependencies: [{ name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" }],
    },
    {
      label: "single dep, matchReleaseName mode",
      dependencies: [{ name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true }],
    },
    {
      label: "single dep, type:tag mode",
      dependencies: [
        { name: "echo", repo: "initech/echo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v", type: "tag" },
      ],
    },
    {
      label: "single dep, assetPattern matcher",
      dependencies: [
        {
          name: "fd",
          repo: "sharkdp/fd",
          pattern: "^v\\d+\\.\\d+\\.\\d+$",
          assetPattern: "^fd-.*-x86_64-.*\\.tar\\.gz$",
        },
      ],
    },
    {
      label: "five deps mixed",
      dependencies: [
        { name: "alpha", repo: "acme/alpha", pattern: "^\\d+\\.\\d+\\.\\d+$", matchReleaseName: true },
        { name: "bravo", repo: "globex/bravo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
        { name: "charlie", repo: "acme/charlie", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v" },
        { name: "delta", repo: "acme/delta", pattern: "^delta-\\d+\\.\\d+\\.\\d+$", stripPattern: "^delta-" },
        { name: "echo", repo: "initech/echo", pattern: "^v\\d+\\.\\d+\\.\\d+$", stripPattern: "^v", type: "tag" },
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
        assert.equal(actual.type, expected.type ?? "release", `${label}: type[${i}]`);
        assert.ok(actual.pattern instanceof RegExp, `${label}: pattern[${i}] is RegExp`);
        assert.equal(actual.pattern.source, expected.pattern, `${label}: pattern.source[${i}]`);
        assert.ok(actual.stripPattern instanceof RegExp, `${label}: stripPattern[${i}] is RegExp`);
        if (expected.assetPattern) {
          assert.ok(actual.assetPattern instanceof RegExp, `${label}: assetPattern[${i}] is RegExp`);
          assert.equal(actual.assetPattern.source, expected.assetPattern, `${label}: assetPattern.source[${i}]`);
        } else {
          assert.equal(actual.assetPattern, null, `${label}: assetPattern[${i}] null when absent`);
        }
        if (expected.matchReleaseName) assert.equal(actual.matchReleaseName, true, `${label}: matchReleaseName[${i}]`);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration defaults type to release and passes lock through", async () => {
  const fixture = withConfig({
    dependencies: [{ name: "x", repo: "a/b", pattern: ".", lock: "1.2.3" }],
  });
  try {
    const [dep] = await loadConfiguration({ core: noopCore }, fixture.path);
    assert.equal(dep.type, "release");
    assert.equal(dep.lock, "1.2.3");
  } finally {
    fixture.cleanup();
  }
});

test("loadConfiguration accepts type:commit with a valid SHA and skips pattern", async () => {
  const cases = ["d24655a708059d322633e361e2e204983e51f491", "aca6269", "ABCDEF1234"];
  for (const commit of cases) {
    const fixture = withConfig({
      dependencies: [{ name: "wheel", repo: "o/r", type: "commit", commit }],
    });
    try {
      const [dep] = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(dep.type, "commit");
      assert.equal(dep.commit, commit);
      assert.equal(dep.pattern, null, "commit deps need no pattern");
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects an unknown type", async () => {
  for (const type of ["branch", "latest", "Release", ""]) {
    const fixture = withConfig({ dependencies: [{ name: "x", repo: "a/b", pattern: ".", type }] });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /Invalid type/,
        `expected rejection for type=${JSON.stringify(type)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects type:commit without a valid SHA", async () => {
  for (const commit of [
    undefined,
    "",
    "abc123", // 6 valid hex chars: one short of the 7-char minimum
    "nothex",
    "g1234567", // non-hex character
    "abc123def456abc123def456abc123def456abc1234", // 43 chars: one over the 40-char maximum
  ]) {
    const fixture = withConfig({ dependencies: [{ name: "x", repo: "a/b", type: "commit", commit }] });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /no valid commit SHA/,
        `expected rejection for commit=${JSON.stringify(commit)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects release/tag deps without a string pattern", async () => {
  for (const dep of [
    { name: "x", repo: "a/b" },
    { name: "x", repo: "a/b", pattern: 123 },
    { name: "x", repo: "a/b", type: "tag" },
  ]) {
    const fixture = withConfig({ dependencies: [dep] });
    try {
      await assert.rejects(loadConfiguration({ core: noopCore }, fixture.path), /requires a string "pattern"/);
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects an assetPattern on non-release deps (tag and commit)", async () => {
  const deps = [
    { name: "x", repo: "a/b", pattern: ".", type: "tag", assetPattern: "^x.*$" },
    { name: "x", repo: "a/b", type: "commit", commit: "abc1234", assetPattern: "^x.*$" },
  ];
  for (const dep of deps) {
    const fixture = withConfig({ dependencies: [dep] });
    try {
      await assert.rejects(
        loadConfiguration({ core: noopCore }, fixture.path),
        /only "release" deps have assets/,
        `expected rejection for type=${dep.type}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("loadConfiguration rejects an invalid assetPattern regex and names the field", async () => {
  const fixture = withConfig({ dependencies: [{ name: "x", repo: "a/b", pattern: ".", assetPattern: "[" }] });
  try {
    await assert.rejects(
      loadConfiguration({ core: noopCore }, fixture.path),
      /Invalid regex for dep "x" assetPattern:/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("loadConfiguration accepts valid shell-identifier names", async () => {
  const validNames = ["bravo", "_underscore", "Snake_case", "fooBar123", "x", "_", "ABC", "a_b_1_2"];
  for (const name of validNames) {
    const fixture = withConfig({ dependencies: [{ name, repo: "a/b", pattern: "." }] });
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
    "Owner/Repo",
    "ALL-CAPS/repo",
    "with-hyphens/and-more",
    "with.dots/and.more",
    "user_name/repo_name",
    "abc123/repo456",
  ];
  for (const repo of validRepos) {
    const fixture = withConfig({ dependencies: [{ name: "x", repo, pattern: "." }] });
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
    const fixture = withConfig({ dependencies: [{ name: badName, repo: "x/y", pattern: "." }] });
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
    const fixture = withConfig({ dependencies: [{ name: "x", repo: badRepo, pattern: "." }] });
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
      label: "invalid quantifier in pattern",
      dep: { name: "x", repo: "a/b", pattern: "*" },
      match: /Invalid regex for dep "x" pattern:/,
    },
    {
      label: "unterminated character class in stripPattern",
      dep: { name: "x", repo: "a/b", pattern: ".", stripPattern: "[" },
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
      assert.equal("v8.10.1".replace(deps[0].stripPattern, ""), "v8.10.1", `${label}: 'v' not stripped`);
    } finally {
      fixture.cleanup();
    }
  }

  const stripCases = [
    { label: "strip 'v' prefix", stripPattern: "^v", input: "v8.10.1", expected: "8.10.1" },
    { label: "strip 'delta-' prefix", stripPattern: "^delta-", input: "delta-3.0.0", expected: "3.0.0" },
  ];
  for (const { label, stripPattern, input, expected } of stripCases) {
    const fixture = withConfig({ dependencies: [{ name: "x", repo: "a/b", pattern: ".", stripPattern }] });
    try {
      const deps = await loadConfiguration({ core: noopCore }, fixture.path);
      assert.equal(input.replace(deps[0].stripPattern, ""), expected, label);
    } finally {
      fixture.cleanup();
    }
  }
});
