import assert from "node:assert/strict";

// The Tauri CLI only warns about mismatched keys; refuse to publish that build.
const pubkey = Buffer.from(process.env.TAURI_UPDATER_PUBKEY ?? "", "base64").toString("utf8").split("\n");
const signature = Buffer.from((await Bun.file(process.argv[2]!).text()).trim(), "base64").toString("utf8").split("\n");
const publicPacket = Buffer.from(pubkey[1] ?? "", "base64");
const signedPacket = Buffer.from(signature[1] ?? "", "base64");
assert.equal(publicPacket.length, 42, "Invalid updater public key");
assert.equal(signedPacket.length, 74, "Invalid updater signature");
assert.ok(publicPacket.subarray(2, 10).equals(signedPacket.subarray(2, 10)), "Updater signature does not match embedded public key");
assert.ok(signature[2]?.endsWith(`\tversion:${process.argv[3]}`), "Updater signature does not bind the app version");
