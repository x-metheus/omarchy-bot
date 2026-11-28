function installNativeShell(initial) {
  if (typeof window.__TAURI_INTERNALS__?.invoke !== "function") return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  let connection = initial.connection;
  let pending = initial.pairing;
  const listeners = new Set();
  async function receivePairing() {
    const request = await invoke("take_pairing_request");
    if (!request) return;
    if (listeners.size === 0) pending = request;
    else for (const listener of listeners) listener(request);
  }
  window.addEventListener("metheus-pair", () => { void receivePairing(); });

  window.__METHEUS_SHELL__ = {
    service: {
      baseUrl: () => connection?.baseUrl ?? initial.revoked ?? initial.localDaemon.baseUrl,
      deviceToken: () => connection?.token,
      status: () => ({ error: initial.error ?? undefined, revoked: Boolean(initial.revoked) }),
      certificateUntrusted: origin => invoke("certificate_untrusted", { origin }),
      async store(baseUrl, token) {
        if (initial.error) throw new Error(initial.error);
        await invoke("store_connection", { baseUrl, token });
        connection = { baseUrl, token };
      },
      async clear() {
        await invoke("clear_connection");
        connection = null;
      },
    },
    agentDaemon: {
      baseUrl: initial.localDaemon.baseUrl,
      autostart: initial.localDaemon.autostart,
      ensure: () => invoke("ensure_local_daemon"),
      setAutostart: enabled => invoke("set_daemon_autostart", { enabled }),
      pairingCode: () => invoke("local_daemon_pairing_code"),
    },
    desktopTools: connection ? { choose: kind => invoke("choose_desktop_path", { kind }) } : undefined,
    pairing: {
      onRequest(listener) {
        listeners.add(listener);
        void receivePairing();
        if (pending) {
          const request = pending;
          pending = null;
          queueMicrotask(() => { if (listeners.has(listener)) listener(request); });
        }
        return () => listeners.delete(listener);
      },
    },
    browser: { async open(value) {
      if (new URL(value).searchParams.has("access_token")) throw new Error("An authenticated Service link cannot be opened in the system browser.");
      await invoke("open_browser", { value });
    } },
    attachments: { async save(value, filename) {
      const url = new URL(value, connection?.baseUrl ?? initial.localDaemon.baseUrl);
      const allowedPath = /^\/bots\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}$/;
      if (!connection?.token || url.origin !== connection.baseUrl || !allowedPath.test(url.pathname) || url.search || url.hash || url.username || url.password) {
        throw new Error("Attachments must come from the paired Service.");
      }
      const response = await window.fetch(url.href, { headers: { authorization: `Bearer ${connection.token}` }, redirect: "error", cache: "no-store" });
      if (!response.ok) throw new Error("The attachment could not be downloaded. Check the Service connection and try again.");
      return invoke("save_attachment", { filename, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) });
    } },
    updates: {
      async check() {
        const version = await invoke("check_update");
        return version ? { available: true, version } : { available: false };
      },
      download: () => invoke("install_update"),
      restart: () => invoke("restart_app"),
    },
  };
}
