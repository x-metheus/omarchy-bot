import { useCallback, useEffect, useState } from "react";
import { pairService } from "./pairing.ts";
import type { LocalAgentDaemon } from "./shell.ts";

export interface LocalDaemonController {
  baseUrl: string;
  autostart: boolean;
  ready: boolean;
  checking: boolean;
  pairing: boolean;
  error: string;
  check: () => Promise<void>;
  pairLocal: () => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<void>;
}

export function useLocalDaemon(
  daemon: LocalAgentDaemon,
  { paired, baseUrl }: { paired: boolean; baseUrl: string },
): LocalDaemonController {
  const [autostart, setAutostartState] = useState(daemon.autostart);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pairing, setPairing] = useState(false);

  const check = useCallback(async () => {
    setError("");
    setChecking(true);
    try {
      setReady(await daemon.ensure());
    } catch (cause) {
      setReady(false);
      setError(typeof cause === "string" ? cause : "Could not reach the local Agent Daemon.");
    } finally {
      setChecking(false);
    }
  }, [daemon]);

  useEffect(() => {
    if (!paired || baseUrl === daemon.baseUrl) void check();
  }, [baseUrl, check, daemon.baseUrl, paired]);

  const setAutostart = useCallback(async (enabled: boolean) => {
    await daemon.setAutostart(enabled);
    setAutostartState(enabled);
  }, [daemon]);

  const pairLocal = useCallback(async () => {
    setPairing(true);
    setError("");
    try {
      const code = await daemon.pairingCode();
      if (code) await pairService({ serviceUrl: daemon.baseUrl, code });
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Could not pair the local Agent Daemon.");
    } finally {
      setPairing(false);
    }
  }, [daemon]);

  return {
    baseUrl: daemon.baseUrl,
    autostart,
    ready,
    checking,
    pairing,
    error,
    check,
    pairLocal,
    setAutostart,
  };
}
