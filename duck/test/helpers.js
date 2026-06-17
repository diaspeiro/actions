const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function withTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content));
  return {
    path: filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const noopCore = {
  info: () => {},
  warning: () => {},
  notice: () => {},
};

function makeGithub(overrides = {}) {
  const calls = [];
  const noop = async () => ({ data: {} });
  const defaultIterator = async function* () {
    /* yields nothing */
  };
  const wrap = (name) => {
    const fn = overrides[name] || noop;
    return async (...args) => {
      calls.push({ method: name, args });
      return fn(...args);
    };
  };
  const github = {
    rest: {
      pulls: {
        list: wrap("pulls.list"),
        create: wrap("pulls.create"),
        update: wrap("pulls.update"),
      },
      repos: {
        getContent: wrap("repos.getContent"),
        createOrUpdateFileContents: wrap("repos.createOrUpdateFileContents"),
        getCommit: wrap("repos.getCommit"),
        // Referenced (not called) by upstream when handing a fn to paginate.iterator.
        listReleases: function listReleases() {},
        listTags: function listTags() {},
      },
      git: {
        getRef: wrap("git.getRef"),
        createRef: wrap("git.createRef"),
        deleteRef: wrap("git.deleteRef"),
      },
    },
    paginate: {
      iterator: (fn, args) => {
        calls.push({ method: "paginate.iterator", args: [fn, args] });
        const factory = overrides["paginate.iterator"] || defaultIterator;
        return factory(fn, args);
      },
    },
  };
  return { github, calls };
}

function makeRecordingCore() {
  const calls = [];
  const make =
    (level) =>
    (...args) =>
      calls.push({ level, args });
  return {
    info: make("info"),
    warning: make("warning"),
    notice: make("notice"),
    error: make("error"),
    setFailed: make("setFailed"),
    setOutput: make("setOutput"),
    calls,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A deterministic stub for the injected hasher: maps url -> sha256, and records
// every url it was asked to hash so tests can assert which artifacts downloaded.
function makeFetchSha(map = {}) {
  const hashed = [];
  const fn = async (url) => {
    hashed.push(url);
    if (!(url in map)) throw new Error(`unexpected hash url ${url}`);
    return map[url];
  };
  fn.hashed = hashed;
  return fn;
}

module.exports = {
  withTempFile,
  noopCore,
  makeGithub,
  makeRecordingCore,
  httpError,
  makeFetchSha,
};
