const { loadConfiguration } = require("./lib/config");
const { getDependencyVersions } = require("./lib/version-file");
const { getLatestVersion } = require("./lib/upstream");
const { findExistingPR, createOrUpdatePR, BRANCH_NAME } = require("./lib/pr");

async function run({ github, context, core, configPath, versionFilePath } = {}) {
  const deps = { github, context, core };

  if (!context.ref.startsWith("refs/heads/")) {
    core.setFailed(`Expected branch ref, got ${context.ref}.`);
    return;
  }
  const baseBranch = context.ref.slice("refs/heads/".length);

  const dependencies = await loadConfiguration(deps, configPath);
  const existingPR = await findExistingPR(deps);
  // baseVersions: base branch state (for PR body diffs); read from the local checkout.
  // branchVersions: bot branch state (decides file writes and which bumps are new).
  const baseVersions = await getDependencyVersions(deps, { localPath: versionFilePath });
  const branchVersions = existingPR ? await getDependencyVersions(deps, { ref: BRANCH_NAME }) : baseVersions;

  core.info("Current dependency versions:");
  for (const dep of dependencies) {
    const version = branchVersions[dep.name] || "(not set)";
    core.info(`  - ${dep.repo}: ${version}`);
  }

  core.info("\nChecking for upstream updates...");
  const updates = {};

  const lookups = await Promise.all(
    dependencies.map(async (dep) => ({ dep, latest: await getLatestVersion(deps, dep) })),
  );
  const failed = lookups.filter(({ latest }) => latest === null).map(({ dep }) => dep.repo);
  if (failed.length > 0) {
    core.setFailed(`Upstream lookup failed for: ${failed.join(", ")}. Refusing to write a partial version file.`);
    return;
  }
  for (const { dep, latest } of lookups) {
    if (latest !== branchVersions[dep.name]) {
      updates[dep.name] = latest;
      core.info(`  - ${dep.repo}: ${branchVersions[dep.name] || "(not set)"} -> ${latest}`);
      core.setOutput(`${dep.name}_version`, latest);
    }
  }

  if (Object.keys(updates).length > 0) {
    core.notice(`Found ${Object.keys(updates).length} update(s): creating/updating PR...`);
    await createOrUpdatePR(deps, dependencies, updates, baseVersions, branchVersions, existingPR, baseBranch);
  } else {
    core.info("No updates found: all dependencies are up to date");
  }
}

module.exports = { run };
