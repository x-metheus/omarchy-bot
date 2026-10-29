import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export function appSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const packet = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]);
  return {
    publicKey: Buffer.from(`untrusted comment: disposable updater key\n${packet.toString("base64")}\n`).toString("base64"),
    signature(data: string) {
      const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
      const signed = Buffer.concat([Buffer.from("ED"), id, signature]);
      const comment = "timestamp:1\tfile:app.AppImage\tversion:1.2.3";
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return Buffer.from(`untrusted comment: signature from disposable updater key\n${signed.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
    },
  };
}
