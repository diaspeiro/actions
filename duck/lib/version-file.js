const fs = require("node:fs").promises;

const VERSION_FILE = ".github/dependency-versions";

function parseVersionFileContent(content) {
  return Object.fromEntries(
    content
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const [key, value] = line.split("=");
        return [key.replace(/_VERSION$/, "").toLowerCase(), value];
      }),
  );
}

function buildVersionFileContent(dependencies, updates, currentVersions) {
  return [
    "# Dependency versions. DO NOT EDIT MANUALLY.",
    ...dependencies.map((dep) => `${dep.name.toUpperCase()}_VERSION=${updates[dep.name] || currentVersions[dep.name]}`),
  ].join("\n");
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

    return parseVersionFileContent(content);
  } catch (error) {
    if (error.code !== "ENOENT" && error.status !== 404) throw error;
    core.info(`No version file at ${ref || "checkout"}, treating as empty baseline`);
    return {};
  }
}

module.exports = { getDependencyVersions, parseVersionFileContent, buildVersionFileContent, VERSION_FILE };
