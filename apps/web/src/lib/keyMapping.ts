type KeyState = "pressed" | "released";
type Modifiers = { control: boolean; alt: boolean; shift: boolean; meta: boolean };
type SendKey = (code: string, state: KeyState, modifiers: Modifiers) => boolean;

/** Tracks physical keys so remapped modifiers have balanced remote transitions. */
export class MacOSKeyMapping {
  readonly #held = new Map<string, string>();

  clear(): void { this.#held.clear(); }

  transition(code: string, state: KeyState, metaSendsSuper: boolean, send: SendKey): boolean {
    const previous = this.#held.get(code);
    if (state === "pressed" && previous !== undefined) return true;
    if (state === "released" && previous === undefined) return false;
    const remote = previous ?? (code.startsWith("Meta") && !metaSendsSuper
      ? code.replace("Meta", "Control")
      : code.startsWith("Alt") ? code.replace("Alt", "Meta") : code);
    let matching = 0;
    for (const value of this.#held.values()) if (value === remote) matching += 1;
    if (state === "pressed") this.#held.set(code, remote);
    else this.#held.delete(code);
    const held = (key: string): boolean => {
      for (const value of this.#held.values()) if (value === key) return true;
      return false;
    };
    const duplicate = state === "pressed" ? matching > 0 : matching > 1;
    if (duplicate) return true;
    if (send(remote, state, {
      control: held("ControlLeft") || held("ControlRight"),
      alt: false,
      shift: held("ShiftLeft") || held("ShiftRight"),
      meta: held("MetaLeft") || held("MetaRight"),
    })) {
      // macOS can omit ordinary keyup events while Command is held.
      if (state === "pressed" && (this.#held.has("MetaLeft") || this.#held.has("MetaRight"))
        && !/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) {
        this.transition(code, "released", metaSendsSuper, send);
      }
      return true;
    }
    if (previous === undefined) this.#held.delete(code);
    else this.#held.set(code, previous);
    return false;
  }
}
