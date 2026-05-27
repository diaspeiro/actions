const test = require("node:test");
const assert = require("node:assert/strict");

const { getLatestVersion, timeboxedMatch } = require("../lib/upstream");
const { noopCore } = require("./helpers");

// --- iterator helpers ---

function makePaginate(pages, counter) {
  return async function* () {
    for (const p of pages) {
      if (counter) counter.yielded++;
      yield { data: p };
    }
  };
}

function makeGithub(pages, { counter } = {}) {
  let calledFn, calledArgs;
  const github = {
    rest: {
      repos: {
        listTags: function listTags() {},
        listReleases: function listReleases() {},
      },
    },
    paginate: {
      iterator: (fn, args) => {
        calledFn = fn;
        calledArgs = args;
        return makePaginate(pages, counter)();
      },
    },
  };
  return { github, calledFn: () => calledFn, calledArgs: () => calledArgs };
}

const baseDep = {
  name: "x",
  repo: "owner/repo",
  pattern: /^v\d+\.\d+\.\d+$/,
  stripPattern: /^v/,
};

// --- timeboxedMatch ---

test("timeboxedMatch returns true when the pattern matches", () => {
  assert.equal(timeboxedMatch(/^v\d/, "v1"), true);
});

test("timeboxedMatch returns false when the pattern does not match", () => {
  assert.equal(timeboxedMatch(/^v\d/, "x1"), false);
});

test("timeboxedMatch returns false when the regex execution times out", () => {
  // Catastrophic backtracking: with 30 a's followed by '!', /^(a+)+$/ explores
  // ~2^30 groupings before giving up. Far exceeds the 100ms timeout.
  const evil = /^(a+)+$/;
  const input = `${"a".repeat(30)}!`;
  const t0 = Date.now();
  const result = timeboxedMatch(evil, input);
  const elapsed = Date.now() - t0;
  assert.equal(result, false);
  assert.ok(elapsed < 1000, `should bail out fast; took ${elapsed}ms`);
});

// --- getLatestVersion: happy path & version field selection ---

test("getLatestVersion picks the highest matching release by semver and strips the prefix", async () => {
  // 1.10.0 is the semver max; alphabetically it's < v1.2.0.
  // test fails if the impl falls back to lexicographic sorting.
  const { github } = makeGithub([
    [
      { tag_name: "v1.2.0", prerelease: false, draft: false },
      { tag_name: "v1.10.0", prerelease: false, draft: false },
      { tag_name: "v1.9.0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result, "1.10.0");
});

test("getLatestVersion uses item.name when useName is set", async () => {
  const { github } = makeGithub([[{ tag_name: "ignored", name: "v2.0.0", prerelease: false, draft: false }]]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, useName: true });
  assert.equal(result, "2.0.0");
});

test("getLatestVersion uses listTags + item.name when matchTag is set", async () => {
  const { github, calledFn, calledArgs } = makeGithub([[{ name: "v3.0.0" }, { name: "v3.1.0" }]]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, matchTag: true });
  assert.equal(result, "3.1.0");
  // Sequence-ish: the listTags fn was the one passed to paginate.iterator
  // (vs listReleases). Args: the same iterator call carried owner/repo derived
  // from baseDep.repo ("owner/repo").
  assert.equal(calledFn(), github.rest.repos.listTags);
  const args = calledArgs();
  assert.equal(args.owner, "owner");
  assert.equal(args.repo, "repo");
});

test("getLatestVersion calls the iterator with the split owner+name and per_page=100", async () => {
  // Distinct owner and repo so a swap or full-string regression is detectable.
  const { github, calledArgs } = makeGithub([[{ tag_name: "v1.0.0", prerelease: false, draft: false }]]);
  await getLatestVersion({ github, core: noopCore }, { ...baseDep, repo: "globex/bravo" });
  const args = calledArgs();
  assert.equal(args.owner, "globex");
  assert.equal(args.repo, "bravo");
  assert.equal(args.per_page, 100);
});

// --- getLatestVersion: filtering ---

test("getLatestVersion filters prereleases and drafts in releases mode", async () => {
  const { github } = makeGithub([
    [
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.5.0", prerelease: true, draft: false }, // would be highest
      { tag_name: "v1.4.0", prerelease: false, draft: true }, // would be 2nd
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result, "1.0.0");
});

test("getLatestVersion considers prerelease versions when the pattern admits them", async () => {
  // semver.maxSatisfying with range "*" excludes prereleases by default; the
  // includePrerelease flag is what lets a -rc tag win when the pattern allows it.
  // Without the flag, "1.1.0-rc1" would lose to "1.0.0".
  const dep = { ...baseDep, pattern: /^v\d+\.\d+\.\d+(-rc\d+)?$/ };
  const { github } = makeGithub([
    [
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-rc1", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result, "1.1.0-rc1");
});

test("getLatestVersion bypasses the prerelease/draft filter when matchTag is set", async () => {
  const { github } = makeGithub([
    [
      { name: "v1.0.0", prerelease: true },
      { name: "v2.0.0", draft: true },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, matchTag: true });
  assert.equal(result, "2.0.0");
});

// --- getLatestVersion: pagination ---

test("getLatestVersion stops paginating after the first page that yields a match", async () => {
  const counter = { yielded: 0 };
  const { github } = makeGithub(
    [
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v9.9.9", prerelease: false, draft: false }],
    ],
    { counter },
  );
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result, "1.0.0");
  assert.equal(counter.yielded, 1, "should not consume page 2");
});

test("getLatestVersion gives up after MAX_PAGES (3) of no matches and warns", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const counter = { yielded: 0 };
  const { github } = makeGithub(
    [
      [{ tag_name: "rc-1", prerelease: false, draft: false }],
      [{ tag_name: "rc-2", prerelease: false, draft: false }],
      [{ tag_name: "rc-3", prerelease: false, draft: false }],
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }], // would match, should not be reached
    ],
    { counter },
  );
  const result = await getLatestVersion({ github, core }, baseDep);
  assert.equal(result, null);
  assert.equal(counter.yielded, 3, "should cap at MAX_PAGES");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No matching versions/);
});

// --- getLatestVersion: semver edge cases ---

test("getLatestVersion ignores items whose post-strip value is not valid semver", async () => {
  // The invalid candidate "9.0.0.0" is deliberately chosen so it would WIN if it
  // were silently coerced (semver.coerce("9.0.0.0") → "9.0.0", > 1.2.3). Asserting
  // 1.2.3 wins proves the invalid value was actually dropped, not rescued.
  // (Note: X.Y values like "1.0" don't reach this filter -- they get normalized
  // to X.Y.0 first; see "short-version normalization" below.)
  const dep = { ...baseDep, pattern: /^v\d+\.\d+\.\d+(\.\d+)?$/ };
  const { github } = makeGithub([
    [
      { tag_name: "v1.2.3", prerelease: false, draft: false },
      { tag_name: "v9.0.0.0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result, "1.2.3");
});

// --- getLatestVersion: short-version normalization ---

test("getLatestVersion normalizes X.Y names to X.Y.0 so they participate in semver max", async () => {
  // Real-world case: curl's 8.20 release was named "8.20" (no trailing .0). Without
  // normalization, semver.valid("8.20") is null and it gets silently dropped, leaving
  // 8.19.0 as the apparent winner.
  const dep = { ...baseDep, pattern: /^\d+\.\d+(\.\d+)?$/, stripPattern: /^$/, useName: true };
  const { github } = makeGithub([
    [
      { tag_name: "x", name: "8.20", prerelease: false, draft: false },
      { tag_name: "x", name: "8.19.0", prerelease: false, draft: false },
      { tag_name: "x", name: "8.18.0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result, "8.20.0");
});

test("getLatestVersion does NOT coerce underscore-separated values (avoids silently picking the wrong major)", async () => {
  // Guard rail against using semver.coerce() unconditionally: coerce("8_20_0") returns
  // "8.0.0", which would silently rescue a misconfigured pattern with a wrong answer.
  // Underscored values must stay invalid and get dropped, so a misconfig fails loudly.
  const dep = { ...baseDep, pattern: /^\d+_\d+_\d+$/, stripPattern: /^$/, useName: true };
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const { github } = makeGithub([
    [
      { tag_name: "x", name: "8_20_0", prerelease: false, draft: false },
      { tag_name: "x", name: "8_19_0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core }, dep);
  assert.equal(result, null, "should not produce a fake 8.0.0 from coercion");
});

test("getLatestVersion does NOT normalize bare integers like '8'", async () => {
  // Same rationale as underscores: only X.Y is the documented real-world case.
  // A bare integer is too ambiguous to invent two components for; stay invalid + drop.
  const dep = { ...baseDep, pattern: /^\d+$/, stripPattern: /^$/, useName: true };
  const { github } = makeGithub([[{ tag_name: "x", name: "8", prerelease: false, draft: false }]]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result, null);
});

// --- getLatestVersion: error handling ---

test("getLatestVersion returns null and warns when the API throws", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const github = {
    rest: { repos: { listTags() {}, listReleases() {} } },
    paginate: {
      // Manual async iterator (vs. a generator) so the rejection pattern
      // doesn't trip the "generator must contain yield" lint rule.
      iterator: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("boom")) }),
      }),
    },
  };
  const result = await getLatestVersion({ github, core }, baseDep);
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Error fetching releases for owner\/repo: boom/);
});
