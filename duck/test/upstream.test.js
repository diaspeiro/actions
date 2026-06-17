const test = require("node:test");
const assert = require("node:assert/strict");

const { getLatestVersion, matchesPattern, normalizeVersion } = require("../lib/upstream");
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

// pages: array of release/tag arrays. commitSha: what repos.getCommit resolves a
// tag to (for the archive fallback). getCommitCalls records the refs requested.
function makeGithub(pages, { counter, commitSha = "c0ffee" } = {}) {
  let calledFn, calledArgs;
  const getCommitCalls = [];
  const github = {
    rest: {
      repos: {
        listTags: function listTags() {},
        listReleases: function listReleases() {},
        getCommit: async (args) => {
          getCommitCalls.push(args);
          return { data: { sha: commitSha } };
        },
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
  return { github, calledFn: () => calledFn, calledArgs: () => calledArgs, getCommitCalls };
}

const baseDep = {
  name: "x",
  repo: "owner/repo",
  type: "release",
  pattern: /^v\d+\.\d+\.\d+$/,
  stripPattern: /^v/,
  assetPattern: null,
};

// --- matchesPattern ---

test("matchesPattern returns true when the pattern matches", () => {
  assert.equal(matchesPattern(/^v\d/, "v1"), true);
});

test("matchesPattern returns false when the pattern does not match", () => {
  assert.equal(matchesPattern(/^v\d/, "x1"), false);
});

// --- normalizeVersion ---

test("normalizeVersion strips the prefix and pads X.Y to X.Y.0", () => {
  assert.equal(normalizeVersion("v1.2.3", /^v/), "1.2.3");
  assert.equal(normalizeVersion("8.20", /^$/), "8.20.0");
  assert.equal(normalizeVersion("openssl-3.0.0", /^openssl-/), "3.0.0");
  assert.equal(normalizeVersion("8", /^$/), "8", "bare integer is left untouched");
});

// --- getLatestVersion: happy path & version field selection ---

test("getLatestVersion picks the highest matching release and resolves the archive URL", async () => {
  const { github, calledFn, getCommitCalls } = makeGithub(
    [
      [
        { tag_name: "v1.2.0", prerelease: false, draft: false },
        { tag_name: "v1.10.0", prerelease: false, draft: false },
        { tag_name: "v1.9.0", prerelease: false, draft: false },
      ],
    ],
    { commitSha: "deadbeef" },
  );
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result.version, "1.10.0");
  assert.equal(result.tag, "v1.10.0");
  assert.equal(result.commit, "deadbeef");
  assert.equal(result.url, "https://github.com/owner/repo/archive/deadbeef.tar.gz");
  assert.equal(calledFn(), github.rest.repos.listReleases, "release type queries the releases endpoint");
  // Archive fallback resolves the winning tag -> commit exactly once.
  assert.equal(getCommitCalls.length, 1);
  assert.equal(getCommitCalls[0].ref, "v1.10.0");
});

test("getLatestVersion uses item.name when matchReleaseName is set", async () => {
  const { github } = makeGithub([[{ tag_name: "ignored", name: "v2.0.0", prerelease: false, draft: false }]]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, matchReleaseName: true });
  assert.equal(result.version, "2.0.0");
});

test("getLatestVersion uses listTags + item.commit.sha when type is tag", async () => {
  const { github, calledFn, calledArgs, getCommitCalls } = makeGithub([
    [
      { name: "v3.0.0", commit: { sha: "aaa" } },
      { name: "v3.1.0", commit: { sha: "bbb" } },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, type: "tag" });
  assert.equal(result.version, "3.1.0");
  assert.equal(result.commit, "bbb");
  assert.equal(result.url, "https://github.com/owner/repo/archive/bbb.tar.gz");
  // Tags carry their commit sha inline, so no extra getCommit call.
  assert.equal(getCommitCalls.length, 0);
  assert.equal(calledFn(), github.rest.repos.listTags);
  const args = calledArgs();
  assert.equal(args.owner, "owner");
  assert.equal(args.repo, "repo");
});

test("getLatestVersion resolves a commit-type dep to the SHA with no upstream lookup", async () => {
  const { github, calledArgs, getCommitCalls } = makeGithub([]);
  const result = await getLatestVersion(
    { github, core: noopCore },
    { ...baseDep, type: "commit", commit: "abc1234", pattern: null },
  );
  assert.equal(result.version, "abc1234", "version is the commit SHA");
  assert.equal(result.commit, "abc1234");
  // The pinned SHA is authoritative: no pagination and no tag->commit resolution.
  assert.equal(result.url, "https://github.com/owner/repo/archive/abc1234.tar.gz");
  assert.equal(calledArgs(), undefined, "no pagination for commit type");
  assert.equal(getCommitCalls.length, 0, "commit SHA is used directly, not re-resolved");
});

test("getLatestVersion calls the iterator with the split owner+name and per_page=100", async () => {
  const { github, calledArgs } = makeGithub([[{ tag_name: "v1.0.0", prerelease: false, draft: false }]]);
  await getLatestVersion({ github, core: noopCore }, { ...baseDep, repo: "globex/bravo" });
  const args = calledArgs();
  assert.equal(args.owner, "globex");
  assert.equal(args.repo, "bravo");
  assert.equal(args.per_page, 100);
});

// --- getLatestVersion: asset selection ---

const assetDep = { ...baseDep, assetPattern: /-x86_64-.*\.tar\.gz$/ };

test("getLatestVersion selects the asset whose filename matches and uses its download URL", async () => {
  const { github, getCommitCalls } = makeGithub([
    [
      {
        tag_name: "v1.0.0",
        prerelease: false,
        draft: false,
        assets: [
          { name: "tool-v1.0.0-aarch64-linux.tar.gz", browser_download_url: "https://dl/arm.tar.gz" },
          { name: "tool-v1.0.0-x86_64-linux.tar.gz", browser_download_url: "https://dl/x86.tar.gz" },
        ],
      },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, assetDep);
  assert.equal(result.version, "1.0.0");
  assert.equal(result.url, "https://dl/x86.tar.gz");
  assert.equal(result.commit, undefined, "asset path needs no commit resolution");
  assert.equal(getCommitCalls.length, 0);
});

test("getLatestVersion excludes signature/checksum siblings via the .tar.gz anchor", async () => {
  // Real releases (curl, openssl, ...) ship foo.tar.gz alongside foo.tar.gz.asc /
  // .sha256 / .tar.xz. A matcher anchored on \.tar\.gz$ must select exactly the
  // gzip tarball, not its siblings.
  const dep = { ...baseDep, assetPattern: /^tool-\d+\.\d+\.\d+\.tar\.gz$/ };
  const { github } = makeGithub([
    [
      {
        tag_name: "v1.0.0",
        prerelease: false,
        draft: false,
        assets: [
          { name: "tool-1.0.0.tar.gz.asc", browser_download_url: "https://dl/sig" },
          { name: "tool-1.0.0.tar.gz.sha256", browser_download_url: "https://dl/sum" },
          { name: "tool-1.0.0.tar.xz", browser_download_url: "https://dl/xz" },
          { name: "tool-1.0.0.tar.gz", browser_download_url: "https://dl/gz" },
        ],
      },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result.url, "https://dl/gz");
});

test("getLatestVersion picks the right artifact when one release ships several (decoupled repo/asset)", async () => {
  // The rakshasa/rtorrent release ships BOTH libtorrent-X.tar.gz and
  // rtorrent-X.tar.gz; two deps scan the same repo but select different assets.
  const release = [
    {
      tag_name: "v0.16.14",
      prerelease: false,
      draft: false,
      assets: [
        { name: "libtorrent-0.16.14.tar.gz", browser_download_url: "https://dl/libtorrent" },
        { name: "rtorrent-0.16.14.tar.gz", browser_download_url: "https://dl/rtorrent" },
      ],
    },
  ];
  const dep = { ...baseDep, stripPattern: /^v/, pattern: /^v\d+\.\d+\.\d+$/ };

  const lt = await getLatestVersion(
    { github: makeGithub([release]).github, core: noopCore },
    { ...dep, name: "libtorrent", assetPattern: /^libtorrent-\d+\.\d+\.\d+\.tar\.gz$/ },
  );
  const rt = await getLatestVersion(
    { github: makeGithub([release]).github, core: noopCore },
    { ...dep, name: "rtorrent", assetPattern: /^rtorrent-\d+\.\d+\.\d+\.tar\.gz$/ },
  );
  assert.equal(lt.version, "0.16.14");
  assert.equal(lt.url, "https://dl/libtorrent");
  assert.equal(rt.url, "https://dl/rtorrent");
});

test("getLatestVersion fails loud (null + warning) when no asset matches", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const { github } = makeGithub([
    [
      {
        tag_name: "v1.0.0",
        prerelease: false,
        draft: false,
        assets: [{ name: "tool-v1.0.0-aarch64-linux.tar.gz", browser_download_url: "https://dl/arm.tar.gz" }],
      },
    ],
  ]);
  const result = await getLatestVersion({ github, core }, assetDep);
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No asset matching/);
});

test("getLatestVersion fails loud (null + warning) when more than one asset matches", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const { github } = makeGithub([
    [
      {
        tag_name: "v1.0.0",
        prerelease: false,
        draft: false,
        assets: [
          { name: "tool-v1.0.0-x86_64-linux.tar.gz", browser_download_url: "https://dl/a.tar.gz" },
          { name: "tool-v1.0.0-x86_64-musl.tar.gz", browser_download_url: "https://dl/b.tar.gz" },
        ],
      },
    ],
  ]);
  const result = await getLatestVersion({ github, core }, assetDep);
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Ambiguous asset match/);
});

// --- getLatestVersion: filtering ---

test("getLatestVersion filters prereleases and drafts in releases mode", async () => {
  const { github } = makeGithub([
    [
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.5.0", prerelease: true, draft: false },
      { tag_name: "v1.4.0", prerelease: false, draft: true },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result.version, "1.0.0");
});

test("getLatestVersion considers prerelease versions when the pattern admits them", async () => {
  const dep = { ...baseDep, pattern: /^v\d+\.\d+\.\d+(-rc\d+)?$/ };
  const { github } = makeGithub([
    [
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-rc1", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result.version, "1.1.0-rc1");
});

test("getLatestVersion bypasses the prerelease/draft filter when type is tag", async () => {
  const { github } = makeGithub([
    [
      { name: "v1.0.0", prerelease: true, commit: { sha: "a" } },
      { name: "v2.0.0", draft: true, commit: { sha: "b" } },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, type: "tag" });
  assert.equal(result.version, "2.0.0");
});

// --- getLatestVersion: pagination ---

test("getLatestVersion scans up to MAX_PAGES and picks the global max, not the first page's match", async () => {
  // A higher version on a later page must win. GitHub's tag ordering isn't a
  // documented semver sort, so stopping at the first matching page could miss it.
  const counter = { yielded: 0 };
  const { github } = makeGithub(
    [
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v9.9.9", prerelease: false, draft: false }],
    ],
    { counter },
  );
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result.version, "9.9.9", "picks the max across all scanned pages");
  assert.equal(counter.yielded, 2, "scans both pages — doesn't stop at the first match");
});

test("getLatestVersion caps scanning at MAX_PAGES even when later pages hold higher matches", async () => {
  // The cost cap is deliberate: a higher version beyond MAX_PAGES is intentionally
  // missed. Real repos list newest-first, so the true max sits on early pages; this
  // pins the tradeoff (bound cost, take the global max of what was scanned).
  const counter = { yielded: 0 };
  const { github } = makeGithub(
    [
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v2.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v3.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v9.9.9", prerelease: false, draft: false }],
    ],
    { counter },
  );
  const result = await getLatestVersion({ github, core: noopCore }, baseDep);
  assert.equal(result.version, "3.0.0", "max of the first MAX_PAGES pages, not the beyond-cap v9.9.9");
  assert.equal(counter.yielded, 3, "stops at MAX_PAGES despite a higher match on page 4");
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
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }],
    ],
    { counter },
  );
  const result = await getLatestVersion({ github, core }, baseDep);
  assert.equal(result, null);
  assert.equal(counter.yielded, 3, "should cap at MAX_PAGES");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No matching versions/);
});

// --- getLatestVersion: locking ---

test("getLatestVersion selects the locked version, not the max, scanning past MAX_PAGES", async () => {
  // The locked version sits on page 5 — beyond the normal MAX_PAGES cap of 3.
  // A non-locked lookup would have stopped at MAX_PAGES (3); a locked lookup must
  // keep going until it finds 1.0.0, proving the deeper cap.
  const counter = { yielded: 0 };
  const { github } = makeGithub(
    [
      [{ tag_name: "v2.0.0", prerelease: false, draft: false }],
      [{ tag_name: "v1.9.0", prerelease: false, draft: false }],
      [{ tag_name: "v1.8.0", prerelease: false, draft: false }],
      [{ tag_name: "v1.7.0", prerelease: false, draft: false }],
      [{ tag_name: "v1.0.0", prerelease: false, draft: false }],
    ],
    { counter, commitSha: "locked" },
  );
  const result = await getLatestVersion({ github, core: noopCore }, { ...baseDep, lock: "1.0.0" });
  assert.equal(result.version, "1.0.0", "returns the locked version, not the max (2.0.0)");
  assert.equal(result.url, "https://github.com/owner/repo/archive/locked.tar.gz");
  assert.equal(counter.yielded, 5, "scanned past MAX_PAGES (3) to reach the locked version");
});

test("getLatestVersion selects the locked release's asset (lock + assetPattern combine)", async () => {
  // Locking and asset selection are independent: the locked (older) release's
  // matching asset must be chosen, not the latest release's.
  const { github } = makeGithub([
    [
      {
        tag_name: "v2.0.0",
        prerelease: false,
        draft: false,
        assets: [{ name: "tool-2.0.0-x86_64.tar.gz", browser_download_url: "https://dl/new" }],
      },
      {
        tag_name: "v1.0.0",
        prerelease: false,
        draft: false,
        assets: [{ name: "tool-1.0.0-x86_64.tar.gz", browser_download_url: "https://dl/old" }],
      },
    ],
  ]);
  const result = await getLatestVersion(
    { github, core: noopCore },
    { ...baseDep, lock: "1.0.0", assetPattern: /-x86_64\.tar\.gz$/ },
  );
  assert.equal(result.version, "1.0.0");
  assert.equal(result.url, "https://dl/old", "asset comes from the locked release");
});

test("getLatestVersion fails loud when the locked version is never found", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const { github } = makeGithub([[{ tag_name: "v2.0.0", prerelease: false, draft: false }]]);
  const result = await getLatestVersion({ github, core }, { ...baseDep, lock: "9.9.9" });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Locked version "9\.9\.9"/);
});

// --- getLatestVersion: semver edge cases ---

test("getLatestVersion ignores items whose post-strip value is not valid semver", async () => {
  const dep = { ...baseDep, pattern: /^v\d+\.\d+\.\d+(\.\d+)?$/ };
  const { github } = makeGithub([
    [
      { tag_name: "v1.2.3", prerelease: false, draft: false },
      { tag_name: "v9.0.0.0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result.version, "1.2.3");
});

test("getLatestVersion normalizes X.Y names to X.Y.0 so they participate in semver max", async () => {
  const dep = { ...baseDep, pattern: /^\d+\.\d+(\.\d+)?$/, stripPattern: /^$/, matchReleaseName: true };
  const { github } = makeGithub([
    [
      { tag_name: "x", name: "8.20", prerelease: false, draft: false },
      { tag_name: "x", name: "8.19.0", prerelease: false, draft: false },
      { tag_name: "x", name: "8.18.0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result.version, "8.20.0");
});

test("getLatestVersion does NOT coerce underscore-separated values", async () => {
  const dep = { ...baseDep, pattern: /^\d+_\d+_\d+$/, stripPattern: /^$/, matchReleaseName: true };
  const { github } = makeGithub([
    [
      { tag_name: "x", name: "8_20_0", prerelease: false, draft: false },
      { tag_name: "x", name: "8_19_0", prerelease: false, draft: false },
    ],
  ]);
  const result = await getLatestVersion({ github, core: noopCore }, dep);
  assert.equal(result, null, "should not produce a fake 8.0.0 from coercion");
});

// --- getLatestVersion: error handling ---

test("getLatestVersion returns null and warns when the API throws", async () => {
  const warnings = [];
  const core = { ...noopCore, warning: (m) => warnings.push(m) };
  const github = {
    rest: { repos: { listTags() {}, listReleases() {}, getCommit: async () => ({ data: {} }) } },
    paginate: {
      iterator: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("boom")) }),
      }),
    },
  };
  const result = await getLatestVersion({ github, core }, baseDep);
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Error resolving owner\/repo: boom/);
});
