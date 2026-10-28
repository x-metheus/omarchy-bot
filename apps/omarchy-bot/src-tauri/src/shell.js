function installNativeShell(initial) {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  let connection = initial.connection;
  let metaSendsSuper = false;
  try { metaSendsSuper = localStorage.getItem("omarchy-bot.meta-sends-super") === "true"; } catch { /* Connection storage remains the OS keychain. */ }
  let pending = initial.pairing;
  const listeners = new Set();
  let sidecarStatus = { running: false };
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
  const fetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const requestedUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (initial.error && requestedUrl.pathname === "/api/pairing/exchange") throw new Error(initial.error);
    try { return await fetch(input, options); }
    catch (error) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = options?.method ?? (input instanceof Request ? input.method : "GET");
      const connecting = url.pathname === "/api/pairing/exchange" && method === "POST"
        || url.pathname === "/api/health" && connection?.baseUrl === url.origin;
      if (url.protocol === "https:" && connecting) {
        const untrusted = await invoke("certificate_untrusted", { origin: url.origin }).catch(() => false);
        if (untrusted) {
          const certificateError = new Error("The Service TLS certificate is not trusted. Install a publicly trusted certificate, or connect through an SSH tunnel to loopback.");
          certificateError.name = "TlsCertificateError";
          throw certificateError;
        }
      }
      throw error;
    }
  };
  window.__OMARCHY_BOT_SHELL__ = {
    service: {
      baseUrl: () => connection?.baseUrl ?? initial.revoked ?? "http://127.0.0.1:7321",
      deviceToken: () => connection?.token,
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
    browser: { open: value => invoke("open_browser", { value }) },
    updates: {
      async check() { return { available: false }; },
      async download() { throw new Error("Signed app updates are not configured for this build."); },
      restart: () => invoke("restart_app"),
    },
    localSidecar: {
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
      platform: () => "linux",
      metaSendsSuper: () => metaSendsSuper,
      async setMetaSendsSuper(value) {
        localStorage.setItem("omarchy-bot.meta-sends-super", String(value));
        metaSendsSuper = value;
      },
    },
  };
  function showNotice(message) {
    let notice = document.getElementById("omarchy-shell-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "omarchy-shell-notice";
      notice.setAttribute("role", "status");
      document.body.prepend(notice);
    }
    notice.textContent = message;
  }
  document.addEventListener("click", event => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    if (!/^https?:$/.test(url.protocol)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const attachment = connection && url.origin === connection.baseUrl && /^\/api\/attachments\/att_[0-9a-f]{32}$/.test(url.pathname);
    if (attachment) {
      void (async () => {
        const response = await window.fetch(url.href, { redirect: "error" });
        if (!response.ok) throw new Error("The attachment could not be downloaded. Check the Service connection and try again.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        const filename = anchor.closest("[data-attachment-name]")?.dataset.attachmentName ?? "attachment";
        const saved = await invoke("save_attachment", { filename, bytes: Array.from(bytes) });
        showNotice(`Attachment saved to ${saved}`);
      })().catch(error => showNotice(error instanceof Error ? error.message : String(error)));
    } else {
      if (url.searchParams.has("access_token")) { showNotice("An authenticated Service link cannot be opened in the system browser."); return; }
      void window.__OMARCHY_BOT_SHELL__.browser.open(url.href).catch(error => showNotice(String(error)));
    }
  }, true);
  const notice = initial.error ?? (initial.revoked ? "This device was revoked. Pair again with a new code from the Service Host." : null);
  if (notice) window.addEventListener("DOMContentLoaded", () => {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = notice;
    document.body.prepend(message);
  }, { once: true });
}
