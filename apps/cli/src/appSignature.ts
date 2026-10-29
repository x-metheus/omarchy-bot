import { createHash, createPublicKey, verify } from "node:crypto";

export function updaterPublicKey(encoded: string) {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] ?? "", "base64");
  if (!lines[0]?.startsWith("untrusted comment: ") || packet.length !== 42 || packet.subarray(0, 2).toString() !== "Ed") throw new Error("Invalid release public key");
  return {
    id: packet.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), packet.subarray(10)]), format: "der", type: "spki" }),
  };
}

export function verifyAppSignature(data: Uint8Array, encodedSignature: string, encodedPublicKey: string): void {
  const { id, key } = updaterPublicKey(encodedPublicKey);
  const lines = Buffer.from(encodedSignature.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] ?? "", "base64");
  const globalSignature = Buffer.from(lines[3] ?? "", "base64");
  if (lines.length !== 4 || !lines[0]?.startsWith("untrusted comment: ") || !lines[2]?.startsWith("trusted comment: ") || packet.length !== 74 || globalSignature.length !== 64 || packet.subarray(0, 2).toString() !== "ED") throw new Error("Invalid AppImage updater signature");
  if (!id.equals(packet.subarray(2, 10))) throw new Error("AppImage updater signature does not match the release public key");
  const signature = packet.subarray(10);
  const digest = createHash("blake2b512").update(data).digest();
  if (!verify(null, digest, key, signature) || !verify(null, Buffer.concat([signature, Buffer.from(lines[2].slice("trusted comment: ".length))]), key, globalSignature)) throw new Error("AppImage updater signature verification failed");
}
