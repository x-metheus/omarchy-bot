import "../helpers/headless-keychain.ts";
import { installDurableCrashProvider } from "../../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { CredentialStore } from "../../../apps/daemon/src/modules/runtime/credentials.ts";
import { SecretStore } from "../../../apps/daemon/src/modules/runtime/secrets.ts";
import { FakeBotScreenRuntimeAdapter } from "../../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { getSetting, setSetting } from "../../../apps/daemon/src/persistence/settings.ts";
import path from "node:path";

installDurableCrashProvider();
const home = process.env.OMARCHY_BOT_HOME!;
const state = process.env.OMARCHY_BOT_STATE!;
const credentials = await CredentialStore.open(state, new SecretStore(home));
if (!credentials.getForRuntime("fake")) await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
const { main } = await import("../../../apps/daemon/src/bootstrap/main.ts");
const daemon = await main({
  useHostApplicationUnits: false,
  botScreenAdapter: new FakeBotScreenRuntimeAdapter(),
  botScreenRuntimeDir: path.join(home, "r"),
  onMailboxDispatchControls({ pauseDispatch, resumeDispatch }) {
    if (process.env.OMARCHY_TEST_PEER_MAIL_HOLD !== "queued") return;
    pauseDispatch();
    process.once("message", (message: unknown) => {
      if (message === "resume-mailbox-dispatch") resumeDispatch();
    });
  },
});
if (getSetting(daemon.svc.db, "default_model") === null) setSetting(daemon.svc.db, "default_model", "fake/fake-model");
console.log(JSON.stringify({ event: "ready", port: daemon.port, pid: process.pid }));
process.removeAllListeners("SIGTERM");
process.on("SIGTERM", () => { void daemon.disconnectForRestart().then(() => process.exit(0)); });
await new Promise(() => {});
