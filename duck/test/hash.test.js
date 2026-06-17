const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { fetchSha256 } = require("../lib/hash");

// Swap in a fake global fetch for the duration of fn, then restore.
async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("fetchSha256 returns the hex sha256 of the downloaded bytes", async () => {
  const bytes = Buffer.from("hello rtorrent");
  const expected = crypto.createHash("sha256").update(bytes).digest("hex");
  let requestedUrl;
  await withFetch(
    async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    },
    async () => {
      const sha = await fetchSha256("https://example/file.tar.gz");
      assert.equal(sha, expected);
      assert.equal(requestedUrl, "https://example/file.tar.gz");
    },
  );
});

test("fetchSha256 follows redirects", async () => {
  let opts;
  await withFetch(
    async (_url, o) => {
      opts = o;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("x") };
    },
    async () => {
      await fetchSha256("https://example/file.tar.gz");
      assert.equal(opts.redirect, "follow");
    },
  );
});

test("fetchSha256 throws on a non-ok response", async () => {
  await withFetch(
    async () => ({ ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => Buffer.from("") }),
    async () => {
      await assert.rejects(fetchSha256("https://example/missing.tar.gz"), /Download failed \(404 Not Found\)/);
    },
  );
});
