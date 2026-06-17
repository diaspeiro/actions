const semver = require("semver");

const MAX_PAGES = 3;
// A locked dep may target an older version that sits beyond the first few pages,
// so locked lookups are allowed to scan deeper before giving up.
const MAX_PAGES_LOCKED = 10;

// Patterns come from the repo's own trusted duck.json and inputs are short GitHub
// tag/asset strings, so a plain test is sufficient — no ReDoS sandbox needed.
const matchesPattern = (pattern, input) => pattern.test(input);

// Normalize a missing trailing .0 (eg curl's 8.20 release) after stripping the prefix.
function normalizeVersion(value, stripPattern) {
  const stripped = value.replace(stripPattern, "");
  return /^\d+\.\d+$/.test(stripped) ? `${stripped}.0` : stripped;
}

const archiveUrl = (repo, sha) => `https://github.com/${repo}/archive/${sha}.tar.gz`;

// Pick the release asset whose filename matches dep.assetPattern. Fail loud on
// zero or multiple matches so a misconfigured matcher never silently grabs the
// wrong artifact (eg the wrong architecture).
function selectAsset(dep, item) {
  const matches = (item.assets || []).filter((a) => matchesPattern(dep.assetPattern, a.name));
  if (matches.length === 0) {
    throw new Error(`No asset matching ${dep.assetPattern} in release "${item.tag_name}" of ${dep.repo}.`);
  }
  if (matches.length > 1) {
    const names = matches.map((a) => a.name).join(", ");
    throw new Error(
      `Ambiguous asset match (${names}) for ${dep.assetPattern} in release "${item.tag_name}" of ${dep.repo}.`,
    );
  }
  return matches[0];
}

// Resolve a tag (lightweight or annotated) to its target commit SHA. Only commit
// archives are guaranteed byte-stable, so the fallback download URL pins a commit.
async function resolveTagCommit({ github }, repo, tag) {
  const [owner, repoName] = repo.split("/");
  const { data } = await github.rest.repos.getCommit({ owner, repo: repoName, ref: tag });
  return data.sha;
}

// Resolve a dependency to { version, tag?, commit?, url }. The sha256 of the
// downloaded artifact is computed by the orchestrator, not here, so this stays
// free of large download side-effects. Returns null on any failure (the caller's
// partial-write guard then refuses to write an incomplete version file).
async function getLatestVersion(deps, dep) {
  const { github, core } = deps;
  const [owner, repoName] = dep.repo.split("/");

  // A commit-pinned dep is fully determined by config: no upstream search.
  if (dep.type === "commit") {
    return { version: dep.commit, commit: dep.commit, url: archiveUrl(dep.repo, dep.commit) };
  }

  const isTag = dep.type === "tag";
  // listTags items only have .name. listReleases items have both .tag_name and .name.
  const versionField = (item) => (isTag || dep.matchReleaseName ? item.name : item.tag_name);
  const maxPages = dep.lock ? MAX_PAGES_LOCKED : MAX_PAGES;

  try {
    const candidates = new Map(); // normalized version -> upstream item
    let pages = 0;
    const iterator = github.paginate.iterator(isTag ? github.rest.repos.listTags : github.rest.repos.listReleases, {
      owner,
      repo: repoName,
      per_page: 100,
    });
    for await (const { data: items } of iterator) {
      for (const item of items) {
        if (!isTag && (item.prerelease || item.draft)) continue;
        const raw = versionField(item);
        if (!matchesPattern(dep.pattern, raw)) continue;
        const version = normalizeVersion(raw, dep.stripPattern);
        if (!candidates.has(version)) candidates.set(version, item);
      }
      pages += 1;
      // Scan up to maxPages and pick the global max, rather than stopping at the
      // first page with any match: GitHub's tag ordering isn't a documented semver
      // sort, and backport releases can push the true max past a page boundary.
      // Locked lookups can stop early, the moment the pinned version turns up.
      if (pages >= maxPages || (dep.lock && candidates.has(dep.lock))) break;
    }

    let version;
    if (dep.lock) {
      if (!candidates.has(dep.lock)) {
        core.warning(`Locked version "${dep.lock}" for ${dep.repo} not found after scanning ${pages} page(s).`);
        return null;
      }
      version = dep.lock;
    } else {
      version = semver.maxSatisfying([...candidates.keys()], "*", { includePrerelease: true });
      if (version === null) {
        core.warning(`No matching versions for ${dep.repo} after scanning ${MAX_PAGES} pages.`);
        return null;
      }
    }

    const item = candidates.get(version);
    const tag = isTag ? item.name : item.tag_name;

    if (dep.assetPattern) {
      return { version, tag, url: selectAsset(dep, item).browser_download_url };
    }
    const commit = isTag ? item.commit.sha : await resolveTagCommit(deps, dep.repo, tag);
    return { version, tag, commit, url: archiveUrl(dep.repo, commit) };
  } catch (error) {
    core.warning(`Error resolving ${dep.repo}: ${error.message}`);
    return null;
  }
}

module.exports = { getLatestVersion, matchesPattern, normalizeVersion };
