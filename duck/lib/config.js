const fs = require("node:fs").promises;

const CONFIG_FILE = ".github/duck.json";
const TYPES = ["release", "tag", "commit"];

async function loadConfiguration({ core }, configPath = CONFIG_FILE) {
  core.info("Loading configuration");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!Array.isArray(config.dependencies) || config.dependencies.length === 0) {
    throw new Error("Config must declare a non-empty 'dependencies' array.");
  }
  return config.dependencies.map((dep) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(dep.name)) {
      throw new Error(
        `Invalid dep name "${dep.name}": must be a valid shell identifier (letter or underscore, then letters/digits/underscores).`,
      );
    }
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(dep.repo)) {
      throw new Error(`Invalid dep.repo "${dep.repo}": must be "owner/name".`);
    }

    const type = dep.type ?? "release";
    if (!TYPES.includes(type)) {
      throw new Error(`Invalid type "${dep.type}" for dep "${dep.name}": must be one of ${TYPES.join(", ")}.`);
    }

    const compile = (field, source) => {
      try {
        return new RegExp(source);
      } catch (e) {
        throw new Error(`Invalid regex for dep "${dep.name}" ${field}: ${e.message}`);
      }
    };

    if (type === "commit") {
      // A commit-pinned dep tracks a fixed SHA: no upstream version search, so no pattern.
      if (!/^[0-9a-f]{7,40}$/i.test(dep.commit ?? "")) {
        throw new Error(`Dep "${dep.name}" has type "commit" but no valid commit SHA (7-40 hex chars).`);
      }
    } else if (typeof dep.pattern !== "string") {
      throw new Error(`Dep "${dep.name}" (type "${type}") requires a string "pattern".`);
    }

    // Only release deps select an asset; tag and commit deps have none, so an
    // assetPattern there is dead config — reject it loudly rather than ignore it.
    if (dep.assetPattern !== undefined && type !== "release") {
      throw new Error(`Dep "${dep.name}" sets "assetPattern" but type is "${type}"; only "release" deps have assets.`);
    }

    return {
      ...dep,
      type,
      pattern: type === "commit" ? null : compile("pattern", dep.pattern),
      stripPattern: compile("stripPattern", dep.stripPattern ?? ""),
      assetPattern: dep.assetPattern === undefined ? null : compile("assetPattern", dep.assetPattern),
    };
  });
}

module.exports = { loadConfiguration };
