import assert from "node:assert/strict";

const version = process.env.APP_VERSION ?? "0.1.0";
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "APP_VERSION must be stable X.Y.Z");
const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const pubkey = process.env.TAURI_UPDATER_PUBKEY;
assert.ok(!signed || pubkey, "Signed builds require TAURI_UPDATER_PUBKEY");
const endpoint = new URL(process.env.TAURI_UPDATER_ENDPOINT ?? "https://github.com/XMethues/omarchy-bot/releases/download/app-latest/latest.json");
const smoke = process.env.OMARCHY_BOT_UPDATER_SMOKE === "1";
assert.ok(endpoint.protocol === "https:" || (smoke && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"), "Updater endpoint must use HTTPS (private smoke permits loopback HTTP)");
console.log(JSON.stringify({
  version,
  bundle: { createUpdaterArtifacts: signed },
  plugins: { updater: {
    ...(pubkey ? { pubkey } : {}),
    endpoints: [endpoint.href],
    requireSignedVersion: true,
    dangerousInsecureTransportProtocol: smoke,
  } },
}));
