const { buildVersionFileContent, entriesEqual, VERSION_FILE } = require("./version-file");

const BRANCH_NAME = "bot/dependency-updates";

async function findExistingPR({ github, context, core }) {
  const { data: openPulls } = await github.rest.pulls.list({
    ...context.repo,
    state: "open",
    head: `${context.repo.owner}:${BRANCH_NAME}`,
  });

  if (openPulls.length > 0) {
    core.info(`Found existing open PR #${openPulls[0].number}`);
    return openPulls[0];
  }

  try {
    await github.rest.git.deleteRef({
      ...context.repo,
      ref: `heads/${BRANCH_NAME}`,
    });
    core.info(`Deleted orphaned branch ${BRANCH_NAME}`);
  } catch ({ status, message }) {
    if (status === 404 || (status === 422 && /Reference does not exist/i.test(message))) {
      core.info("No orphaned branch found");
    } else {
      core.warning(`Failed to delete orphaned branch: ${message}`);
    }
  }

  return null;
}

async function commitVersions({ github, context, core }, dependencies, updates, currentVersions, branchName) {
  const versionFileContent = buildVersionFileContent(dependencies, updates, currentVersions);

  let existing;
  try {
    const { data } = await github.rest.repos.getContent({
      ...context.repo,
      path: VERSION_FILE,
      ref: branchName,
    });
    existing = { sha: data.sha, content: Buffer.from(data.content, "base64").toString() };
  } catch (error) {
    if (error.status !== 404) throw error;
    core.info("No existing version file found, I will create one");
  }

  if (existing?.content === versionFileContent) {
    core.info("Version file unchanged, skipping commit");
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    ...context.repo,
    path: VERSION_FILE,
    message: "chore: Update dependency versions [skip ci]",
    content: Buffer.from(versionFileContent).toString("base64"),
    sha: existing?.sha,
    branch: branchName,
  });
  core.info("Successfully updated version file");
}

async function createOrUpdatePR(deps, dependencies, updates, baseVersions, branchVersions, existingPR, baseBranch) {
  const { github, context, core } = deps;

  // Body describes the cumulative diff vs the base branch, not vs the bot branch.
  const allUpdates = dependencies
    .map((dep) => {
      const final = updates[dep.name] || branchVersions[dep.name];
      const base = baseVersions[dep.name];
      if (!final || entriesEqual(final, base)) return null;
      const lock = final.locked ? " (locked)" : "";
      if (!base) return `- Added ${dep.name} version ${final.version}${lock}`;
      if (base.version === final.version) return `- Re-pinned ${dep.name} at ${final.version}${lock}`;
      return `- Updated ${dep.name} from ${base.version} to ${final.version}${lock}`;
    })
    .filter(Boolean);

  // Net diff vs base is empty (e.g. base was bumped directly and upstream now matches).
  // Close any open PR and delete the bot branch so we don't leave a stale diff for reviewers.
  if (allUpdates.length === 0) {
    if (existingPR) {
      core.warning(`Bot branch is in sync with base: closing PR #${existingPR.number} and deleting branch.`);
      await github.rest.pulls.update({
        ...context.repo,
        pull_number: existingPR.number,
        state: "closed",
      });
      await github.rest.git.deleteRef({
        ...context.repo,
        ref: `heads/${BRANCH_NAME}`,
      });
    } else {
      core.info("All upstream values match base: nothing to PR.");
    }
    return;
  }

  if (!existingPR) {
    try {
      const {
        data: {
          object: { sha },
        },
      } = await github.rest.git.getRef({
        ...context.repo,
        ref: `heads/${baseBranch}`,
      });
      await github.rest.git.createRef({
        ...context.repo,
        ref: `refs/heads/${BRANCH_NAME}`,
        sha,
      });
    } catch (error) {
      if (error.status !== 422 || !/Reference already exists/i.test(error.message)) throw error;
    }
  }

  await commitVersions(deps, dependencies, updates, branchVersions, BRANCH_NAME);

  const prBody = [
    "## Dependency Updates\n",
    ...allUpdates,
    "\n## Action Required\n",
    "- [ ] Review changes",
    "- [ ] Test with updated dependencies",
    "- [ ] Update build configuration if needed",
    "- [ ] Merge when ready",
  ].join("\n");

  if (existingPR) {
    await github.rest.pulls.update({
      ...context.repo,
      pull_number: existingPR.number,
      body: prBody,
    });
    core.info(`Successfully updated PR #${existingPR.number}`);
  } else {
    const { data: pr } = await github.rest.pulls.create({
      ...context.repo,
      title: "chore: Update dependencies",
      head: BRANCH_NAME,
      base: baseBranch,
      body: prBody,
    });
    core.info(`Successfully created PR #${pr.number}`);
  }
}

module.exports = { findExistingPR, commitVersions, createOrUpdatePR, BRANCH_NAME };
