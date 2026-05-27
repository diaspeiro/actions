const fs = require("node:fs").promises;

const CONFIG_FILE = ".github/duck.json";

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
    const compile = (field, source) => {
      try {
        return new RegExp(source);
      } catch (e) {
        throw new Error(`Invalid regex for dep "${dep.name}" ${field}: ${e.message}`);
      }
    };
    return {
      ...dep,
      pattern: compile("pattern", dep.pattern),
      stripPattern: compile("stripPattern", dep.stripPattern ?? ""),
    };
  });
}

module.exports = { loadConfiguration };
