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

module.exports = {
  withTempFile,
  noopCore,
  makeGithub,
  makeRecordingCore,
  httpError,
};
