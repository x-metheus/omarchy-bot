import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ColorMode = "system" | "light" | "dark";
export type ResolvedColorMode = "light" | "dark";

const storageKey = "omarchy-bot.appearance";

export function isColorMode(value: unknown): value is ColorMode {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveColorMode(mode: ColorMode, prefersDark: boolean): ResolvedColorMode {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

function readStoredMode(): ColorMode {
  try {
    const saved = localStorage.getItem(storageKey);
    return isColorMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

function readSystemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export interface AppearanceContextValue {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(readSystemDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const resolvedMode = resolveColorMode(mode, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedMode === "dark");
    root.style.colorScheme = resolvedMode;
  }, [resolvedMode]);

  const setMode = useCallback((next: ColorMode) => {
    setModeState(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Preference still applies for the active session.
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider.");
  return value;
}
