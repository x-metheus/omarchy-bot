function installNativeShell(initial) {
  if (typeof window.__TAURI_INTERNALS__?.invoke !== "function") return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  let connection = initial.connection;
  let metaSendsSuper = false;
  try { metaSendsSuper = localStorage.getItem(initial.defaults.metaSendsSuperKey) === "true"; } catch { /* Connection storage remains the OS keychain. */ }
  let pending = initial.pairing;
  const listeners = new Set();
  let sidecarStatus = { running: false };
  let sidecarStart;
  const approvalListeners = new Set();
  const approvalDismissListeners = new Set();
  const activeApprovals = new Set();
  const approvals = [];
  async function receiveSidecar() {
    try {
      const events = await invoke("sidecar_events");
      sidecarStatus = events.status;
      for (const approval of events.approvals) {
        if (approval.type === "ask.dismiss") {
          activeApprovals.delete(approval.jobId);
          for (let index = approvals.length - 1; index >= 0; index--) {
            if (approvals[index].jobId === approval.jobId) approvals.splice(index, 1);
          }
          for (const listener of approvalDismissListeners) listener(approval.jobId);
        } else {
          activeApprovals.add(approval.jobId);
          if (approvalListeners.size === 0) approvals.push(approval);
          else for (const listener of approvalListeners) listener(approval);
        }
      }
      if (!sidecarStatus.running) {
        for (const jobId of activeApprovals) for (const listener of approvalDismissListeners) listener(jobId);
        activeApprovals.clear();
        approvals.length = 0;
      }
    } catch { sidecarStatus = { running: false }; }
  }
  window.addEventListener("omarchy-sidecar", () => { void receiveSidecar(); });
  void receiveSidecar();
  async function receivePairing() {
    const request = await invoke("take_pairing_request");
    if (!request) return;
    if (listeners.size === 0) pending = request;
    else for (const listener of listeners) listener(request);
  }
  window.addEventListener("omarchy-pair", () => { void receivePairing(); });

  window.__OMARCHY_BOT_SHELL__ = {
    service: {
      baseUrl: () => connection?.baseUrl ?? initial.revoked ?? initial.defaults.serviceUrl,
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
      const url = new URL(value, connection?.baseUrl ?? initial.defaults.serviceUrl);
      if (!connection?.token || url.origin !== connection.baseUrl || !/^\/api\/attachments\/att_[0-9a-f]{32}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
        throw new Error("Attachments must come from the paired Service.");
      }
      const response = await window.fetch(url.href, { headers: { authorization: `Bearer ${connection.token}` }, redirect: "error" });
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
    localSidecar: {
      start: () => sidecarStart ??= (async () => {
        if (!connection) return;
        try {
          // macOS and Windows never run a Service.
          if (initial.platform === "linux") {
            const response = await window.fetch(new URL("/api/host-identity", connection.baseUrl), {
              headers: { authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error("The Service host identity is unavailable.");
            const identity = await response.json();
            if (!identity || typeof identity.salt !== "string" || typeof identity.digest !== "string"
              || !/^[0-9a-f]{64}$/.test(identity.salt) || !/^[0-9a-f]{64}$/.test(identity.digest)) {
              throw new Error("The Service returned an invalid host identity.");
            }
            const digest = await invoke("host_digest", { salt: identity.salt });
            if (digest === identity.digest) return;
          }
          await invoke("sidecar_start");
          await receiveSidecar();
        } catch (error) {
          throw new Error(`Local actions are unavailable because this machine could not be verified with the Service. ${error instanceof Error ? error.message : String(error)} Check the connection and reopen Omarchy Bot to retry.`);
        }
      })(),
      status: () => ({ ...sidecarStatus }),
      onApproval(listener) {
        approvalListeners.add(listener);
        const pending = approvals.splice(0);
        queueMicrotask(() => {
          if (approvalListeners.has(listener)) for (const approval of pending) {
            if (activeApprovals.has(approval.jobId)) listener(approval);
          }
          else approvals.unshift(...pending);
        });
        return () => approvalListeners.delete(listener);
      },
      onApprovalDismiss(listener) {
        approvalDismissListeners.add(listener);
        return () => approvalDismissListeners.delete(listener);
      },
      decide: (jobId, decision) => invoke("sidecar_decide", { jobId, decision }),
    },
    keyMapping: {
      platform: () => initial.platform,
      metaSendsSuper: () => metaSendsSuper,
      async setMetaSendsSuper(value) {
        localStorage.setItem(initial.defaults.metaSendsSuperKey, String(value));
        metaSendsSuper = value;
      },
    },
  };

}
