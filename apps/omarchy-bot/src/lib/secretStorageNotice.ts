import type { ApiClient } from "@omarchy-bot/api-client";

type SecretStorageStatus = Awaited<ReturnType<ApiClient["secretStorageStatus"]>>;
type SecretStorageNotice =
  | { kind: "banner"; status: "warning" | "error"; role: "status" | "alert"; title: string; description: string }
  | { kind: "text"; text: string };

export function secretStorageNotice(storage: SecretStorageStatus | undefined, requestFailed = false): SecretStorageNotice {
  if (requestFailed || storage?.backend === "unavailable") {
    return {
      kind: "banner",
      status: "error",
      role: "alert",
      title: "Unable to access secret storage",
      description: (requestFailed ? undefined : storage?.reason) ?? "The Service could not report secret storage status.",
    };
  }
  if (storage?.backend === "file") {
    return {
      kind: "banner",
      status: "warning",
      role: "status",
      title: "No OS keychain is available.",
      description: "Secrets are stored in a private plaintext file readable by your user, including commands run by a Bot. Protection from other OS users is enforced on POSIX; it is unverified on Windows. POSIX directory/file permissions are 0700/0600.",
    };
  }
  if (storage?.backend === "keychain") {
    return { kind: "text", text: "Commands run by a Bot as your user may be able to access the keychain." };
  }
  return { kind: "text", text: "Checking secret storage…" };
}
