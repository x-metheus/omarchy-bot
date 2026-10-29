import { startApp } from "./app.tsx";
import { getShell } from "./lib/shell.ts";

try {
  const shell = getShell();
  for (const [capability, methods] of [
    [shell.service, ["baseUrl", "deviceToken", "store", "clear"]],
    [shell.pairing, ["onRequest"]],
    [shell.browser, ["open"]],
    [shell.updates, ["check", "download", "restart"]],
    [shell.localSidecar, ["status", "onApproval", "onApprovalDismiss", "decide"]],
    [shell.keyMapping, ["platform", "metaSendsSuper", "setMetaSendsSuper"]],
  ] as const) {
    if (!capability || methods.some(method => typeof Reflect.get(capability, method) !== "function")) {
      throw new Error("The native shell is broken.");
    }
  }
  shell.service.baseUrl();
  shell.service.deviceToken();
  startApp();
} catch {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "Omarchy Bot could not start because its native shell is unavailable or broken. Close and reopen the app. If the problem continues, reinstall Omarchy Bot.";
  document.getElementById("root")!.replaceChildren(message);
}
