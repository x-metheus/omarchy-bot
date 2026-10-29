import { expect, test } from "bun:test";
import { MacOSKeyMapping } from "./keyMapping.ts";

test("macOS Command and Option send balanced Linux Ctrl and Super shortcuts", () => {
  const mapping = new MacOSKeyMapping();
  const messages: unknown[] = [];
  const send = (code: string, state: string, modifiers: unknown) => {
    messages.push({ code, state, modifiers });
    return true;
  };
  mapping.transition("MetaLeft", "pressed", false, send);
  mapping.transition("KeyC", "pressed", false, send);
  mapping.transition("KeyC", "released", false, send);
  mapping.transition("MetaLeft", "released", false, send);
  mapping.transition("AltRight", "pressed", false, send);
  mapping.transition("KeyX", "pressed", false, send);
  mapping.transition("KeyX", "released", false, send);
  mapping.transition("AltRight", "released", false, send);
  expect(messages).toEqual([
    { code: "ControlLeft", state: "pressed", modifiers: { control: true, alt: false, shift: false, meta: false } },
    { code: "KeyC", state: "pressed", modifiers: { control: true, alt: false, shift: false, meta: false } },
    { code: "KeyC", state: "released", modifiers: { control: true, alt: false, shift: false, meta: false } },
    { code: "ControlLeft", state: "released", modifiers: { control: false, alt: false, shift: false, meta: false } },
    { code: "MetaRight", state: "pressed", modifiers: { control: false, alt: false, shift: false, meta: true } },
    { code: "KeyX", state: "pressed", modifiers: { control: false, alt: false, shift: false, meta: true } },
    { code: "KeyX", state: "released", modifiers: { control: false, alt: false, shift: false, meta: true } },
    { code: "MetaRight", state: "released", modifiers: { control: false, alt: false, shift: false, meta: false } },
  ]);
});

test.each([false, true])("overlapping modifiers keep their remote key held with Super override %s", (override) => {
  const mapping = new MacOSKeyMapping();
  const messages: Array<{ code: string; state: string; modifiers: unknown }> = [];
  const send = (code: string, state: "pressed" | "released", modifiers: unknown) => {
    messages.push({ code, state, modifiers });
    return true;
  };
  const physical = override ? "AltLeft" : "ControlLeft";
  const remote = override ? "MetaLeft" : "ControlLeft";
  mapping.transition("MetaLeft", "pressed", override, send);
  mapping.transition(physical, "pressed", override, send);
  mapping.transition("MetaLeft", "released", !override, send);
  mapping.transition("KeyC", "pressed", !override, send);
  mapping.transition("KeyC", "released", !override, send);
  mapping.transition(physical, "released", !override, send);
  expect(messages.map(({ code, state }) => ({ code, state }))).toEqual([
    { code: remote, state: "pressed" },
    { code: "KeyC", state: "pressed" },
    { code: "KeyC", state: "released" },
    { code: remote, state: "released" },
  ]);
  expect(messages[1]?.modifiers).toEqual({ control: !override, alt: false, shift: false, meta: override });
  expect(messages[3]?.modifiers).toEqual({ control: false, alt: false, shift: false, meta: false });
});

test("keys retain the mapping from keydown through keyup when the override changes", () => {
  const mapping = new MacOSKeyMapping();
  const messages: unknown[] = [];
  const send = (code: string, state: string, modifiers: unknown) => { messages.push({ code, state, modifiers }); return true; };
  mapping.transition("MetaRight", "pressed", false, send);
  mapping.transition("ShiftLeft", "pressed", true, send);
  mapping.transition("MetaRight", "released", true, send);
  mapping.transition("ShiftLeft", "released", true, send);
  expect(messages).toEqual([
    { code: "ControlRight", state: "pressed", modifiers: { control: true, alt: false, shift: false, meta: false } },
    { code: "ShiftLeft", state: "pressed", modifiers: { control: true, alt: false, shift: true, meta: false } },
    { code: "ControlRight", state: "released", modifiers: { control: false, alt: false, shift: true, meta: false } },
    { code: "ShiftLeft", state: "released", modifiers: { control: false, alt: false, shift: false, meta: false } },
  ]);
});

test("rejected keys, repeats and release-all cannot leave phantom held modifiers", () => {
  const mapping = new MacOSKeyMapping();
  const messages: unknown[] = [];
  const send = (code: string, state: string, modifiers: unknown) => { messages.push({ code, state, modifiers }); return true; };
  expect(mapping.transition("MetaLeft", "pressed", false, () => false)).toBe(false);
  expect(mapping.transition("MetaLeft", "released", false, send)).toBe(false);
  expect(mapping.transition("MetaLeft", "pressed", true, send)).toBe(true);
  expect(mapping.transition("MetaLeft", "pressed", true, send)).toBe(true);
  mapping.clear();
  expect(mapping.transition("MetaLeft", "released", true, send)).toBe(false);
  mapping.transition("KeyA", "pressed", false, send);
  expect(messages).toEqual([
    { code: "MetaLeft", state: "pressed", modifiers: { control: false, alt: false, shift: false, meta: true } },
    { code: "KeyA", state: "pressed", modifiers: { control: false, alt: false, shift: false, meta: false } },
  ]);
});

test("macOS Command shortcuts release ordinary keys even when the OS omits their keyup", () => {
  const mapping = new MacOSKeyMapping();
  const messages: Array<{ code: string; state: string }> = [];
  const send = (code: string, state: "pressed" | "released") => { messages.push({ code, state }); return true; };
  mapping.transition("MetaLeft", "pressed", false, send);
  mapping.transition("KeyC", "pressed", false, send);
  mapping.transition("KeyC", "pressed", false, send);
  mapping.transition("MetaLeft", "released", false, send);
  expect(messages).toEqual([
    { code: "ControlLeft", state: "pressed" },
    { code: "KeyC", state: "pressed" },
    { code: "KeyC", state: "released" },
    { code: "KeyC", state: "pressed" },
    { code: "KeyC", state: "released" },
    { code: "ControlLeft", state: "released" },
  ]);
});
