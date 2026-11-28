export interface PairingRequest { serviceUrl: string; code: string }
export interface UpdateStatus { available: boolean; version?: string }

export interface LocalAgentDaemon {
  baseUrl: string;
  autostart: boolean;
  ensure(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  pairingCode(): Promise<string>;
}

export type DesktopSelectionKind = "directory" | "file";
export interface DesktopSelection { session: string; name: string }

export interface Shell {
  readonly agentDaemon: LocalAgentDaemon;
  readonly desktopTools?: { choose(kind: DesktopSelectionKind): Promise<DesktopSelection | null> } | undefined;
  readonly service: {
    baseUrl(): string;
    deviceToken(): string | undefined;
    status(): { error?: string | undefined; revoked: boolean };
    certificateUntrusted(origin: string): Promise<boolean>;
    store(baseUrl: string, token: string): Promise<void>;
    clear(): Promise<void>;
  };
  readonly pairing: { onRequest(listener: (request: PairingRequest) => void): () => void };
  readonly browser: { open(url: string): Promise<void> };
  readonly attachments: { save(url: string, filename: string): Promise<string> };
  readonly updates: {
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    restart(): Promise<void>;
  };
}

// The app installs __OMARCHY_BOT_SHELL__ before the Web UI bundle loads.
declare global {
  var __OMARCHY_BOT_SHELL__: Shell | undefined;
}
export function getShell(): Shell {
  const shell = globalThis.__OMARCHY_BOT_SHELL__;
  if (!shell) throw new Error("The native shell is unavailable.");
  return shell;
}
