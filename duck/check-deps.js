const { loadConfiguration } = require("./lib/config");
const { getDependencyVersions, entryChanged, entriesEqual } = require("./lib/version-file");
const { getLatestVersion } = require("./lib/upstream");
const { fetchSha256 } = require("./lib/hash");
const { findExistingPR, createOrUpdatePR, BRANCH_NAME } = require("./lib/pr");

const isLocked = (dep) => Boolean(dep.lock) || dep.type === "commit";

async function run({ github, context, core, configPath, versionFilePath, hash = fetchSha256 } = {}) {
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
    core.info(`  - ${dep.name}: ${branchVersions[dep.name]?.version || "(not set)"}`);
  }

  // Locked deps are held deliberately; surface a visible annotation every run so a
  // held-back version never rots silently.
  for (const dep of dependencies.filter(isLocked)) {
    const held = dep.lock ?? dep.commit;
    core.notice(`${dep.name} is locked to ${held} and will not be auto-updated.`);
  }

  core.info("\nResolving upstream artifacts...");
  const lookups = await Promise.all(
    dependencies.map(async (dep) => ({ dep, resolved: await getLatestVersion(deps, dep) })),
  );
  const failed = lookups.filter(({ resolved }) => resolved === null).map(({ dep }) => `${dep.name} (${dep.repo})`);
  if (failed.length > 0) {
    core.setFailed(`Upstream resolution failed for: ${failed.join(", ")}. Refusing to write a partial version file.`);
    return;
  }

  // Hash each artifact, reusing the recorded sha256 when version+url are unchanged.
  const entries = [];
  const hashFailures = [];
  for (const { dep, resolved } of lookups) {
    const prev = branchVersions[dep.name];
    try {
      let sha256;
      if (prev && !entryChanged(prev, resolved) && prev.sha256) {
        sha256 = prev.sha256;
      } else {
        core.info(`  - ${dep.name}: hashing ${resolved.url}`);
        sha256 = await hash(resolved.url);
      }
      const entry = { version: resolved.version, url: resolved.url, sha256 };
      if (isLocked(dep)) entry.locked = true;
      entries.push({ dep, entry });
    } catch (error) {
      core.warning(`Failed to hash ${dep.name} (${resolved.url}): ${error.message}`);
      hashFailures.push(`${dep.name} (${dep.repo})`);
    }
  }
  if (hashFailures.length > 0) {
    core.setFailed(`Hashing failed for: ${hashFailures.join(", ")}. Refusing to write a partial version file.`);
    return;
  }

  const updates = {};
  for (const { dep, entry } of entries) {
    if (!entriesEqual(branchVersions[dep.name], entry)) {
      updates[dep.name] = entry;
      core.info(`  - ${dep.name}: ${branchVersions[dep.name]?.version || "(not set)"} -> ${entry.version}`);
      core.setOutput(`${dep.name}_version`, entry.version);
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
