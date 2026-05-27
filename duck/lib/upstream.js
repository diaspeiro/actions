const semver = require("semver");
const vm = require("node:vm");

const MAX_PAGES = 3;

const timeboxedMatch = (pattern, input) => {
  try {
    return vm.runInNewContext("p.test(i)", { p: pattern, i: input }, { timeout: 100 });
  } catch {
    return false;
  }
};

async function getLatestVersion({ github, core }, dep) {
  const [owner, repoName] = dep.repo.split("/");
  // listTags items only have .name. listReleases items have both .tag_name and .name.
  const versionField = (item) => (dep?.matchTag || dep?.useName ? item.name : item.tag_name);

  try {
    const versions = [];
    let pages = 0;
    const iterator = github.paginate.iterator(
      dep?.matchTag ? github.rest.repos.listTags : github.rest.repos.listReleases,
      { owner, repo: repoName, per_page: 100 },
    );
    for await (const { data: items } of iterator) {
      for (const item of items) {
        if (!dep?.matchTag && (item.prerelease || item.draft)) continue;
        const v = versionField(item);
        if (!timeboxedMatch(dep.pattern, v)) continue;
        // Normalize a missing trailing .0 (eg curl's 8.20 release)
        const stripped = v.replace(dep.stripPattern, "");
        versions.push(/^\d+\.\d+$/.test(stripped) ? `${stripped}.0` : stripped);
      }
      if (versions.length > 0 || ++pages >= MAX_PAGES) break;
    }

    const result = semver.maxSatisfying(versions, "*", { includePrerelease: true });
    if (result === null) core.warning(`No matching versions for ${dep.repo} after scanning ${MAX_PAGES} pages.`);
    return result;
  } catch (error) {
    core.warning(`Error fetching releases for ${dep.repo}: ${error.message}`);
    return null;
  }
}

module.exports = { getLatestVersion, timeboxedMatch };
