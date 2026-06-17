const crypto = require("node:crypto");

// Download a URL and return the hex SHA-256 of its bytes. Release-asset and
// /archive/<sha>.tar.gz URLs 302 to a CDN, so redirects are followed.
async function fetchSha256(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = { fetchSha256 };
