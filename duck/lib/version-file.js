const fs = require("node:fs").promises;

const VERSION_FILE = ".github/dependency-versions.json";

// Serialize in config order so the file stays stable/diff-friendly. Each dep's
// entry is taken from updates if present, otherwise carried forward unchanged.
function buildVersionFileContent(dependencies, updates, currentEntries) {
  const map = {};
  for (const dep of dependencies) {
    const entry = updates[dep.name] ?? currentEntries[dep.name];
    if (entry) map[dep.name] = entry;
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}

// True when a resolved entry differs materially from the prior one (so a re-hash
// is required). sha256 is intentionally excluded: it is derived from url+content,
// and we only re-download when version or url actually moves.
function entryChanged(prev, next) {
  return !prev || prev.version !== next.version || prev.url !== next.url;
}

// True when two fully-formed entries are identical (used to decide whether a write
// or PR is needed). Considers the locked flag so a lock toggle is a real change.
function entriesEqual(a, b) {
  return (
    !!a &&
    !!b &&
    a.version === b.version &&
    a.url === b.url &&
    a.sha256 === b.sha256 &&
    Boolean(a.locked) === Boolean(b.locked)
  );
}

async function getDependencyVersions({ github, context, core }, { ref = null, localPath = VERSION_FILE } = {}) {
  try {
    const content =
      ref === null
        ? await fs.readFile(localPath, "utf8")
        : Buffer.from(
            (
              await github.rest.repos.getContent({
                ...context.repo,
                path: VERSION_FILE,
                ref,
              })
            ).data.content,
            "base64",
          ).toString();

    // The file is a flat JSON map of lowercase dep name -> { version, url, sha256, locked? }.
    return JSON.parse(content);
  } catch (error) {
    if (error.code !== "ENOENT" && error.status !== 404) throw error;
    core.info(`No version file at ${ref || "checkout"}, treating as empty baseline`);
    return {};
  }
}

module.exports = {
  getDependencyVersions,
  buildVersionFileContent,
  entryChanged,
  entriesEqual,
  VERSION_FILE,
};
