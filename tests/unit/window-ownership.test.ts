import { expect, test } from "bun:test";
import { WindowOwnership } from "../../apps/daemon/src/modules/computer/windowOwnership.ts";

const A = "surf_a";
const B = "surf_b";

test("a Sway window is routed to one Surface only", () => {
  const ownership = new WindowOwnership();
  expect(ownership.claim(A, "30")).toBe(true);
  // A repeated claim by the owning Screen is not a conflict.
  expect(ownership.claim(A, "30")).toBe(true);
  expect(ownership.claim(B, "30")).toBe(false);
  expect(ownership.ownerOfSwayWindow("30")).toBe(A);
  expect(ownership.ownerOfSwayWindow("31")).toBeUndefined();
});

test("a browser window and its target are registered on the owning Surface's window", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11, "target-a");
  expect(ownership.ownerOfBrowserWindow(11)).toEqual({
    surfaceId: A,
    swayWindowId: "30",
    browserWindowId: 11,
    targetId: "target-a",
  });
  expect(ownership.windowsFor(A)).toEqual([{
    surfaceId: A,
    swayWindowId: "30",
    browserWindowId: 11,
    targetId: "target-a",
  }]);
  // Registering the same pairing again is idempotent, as a second snapshot does.
  ownership.register(A, "30", 11, "target-a");
  expect(ownership.windowsFor(A)).toHaveLength(1);
});

test("a browser window already owned by a Screen cannot be bound by another", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11, "target-a");
  expect(() => ownership.register(B, "31", 11, "target-b")).toThrow("another Screen");
  expect(ownership.ownerOfBrowserWindow(11)?.surfaceId).toBe(A);
  expect(ownership.windowsFor(B)).toEqual([]);
});

test("a Sway window routed to one Screen cannot be bound by another", () => {
  const ownership = new WindowOwnership();
  ownership.claim(A, "30");
  expect(() => ownership.register(B, "30", 11, "target-b")).toThrow("another Screen");
  expect(ownership.ownerOfSwayWindow("30")).toBe(A);
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
});

test("releasing a window requires the owning Surface and forgets both identities", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11);
  expect(() => ownership.releaseWindow(B, "30")).toThrow("does not belong to this Screen");
  expect(() => ownership.releaseWindow(A, "31")).toThrow("does not belong to this Screen");
  expect(ownership.windowsFor(A)).toHaveLength(1);
  ownership.releaseWindow(A, "30");
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
  expect(ownership.ownerOfSwayWindow("30")).toBeUndefined();
  expect(ownership.windowsFor(A)).toEqual([]);
  // The window is no Screen's now, and releasing it twice is not a licence to guess.
  expect(() => ownership.releaseWindow(A, "30")).toThrow("does not belong to this Screen");
});

test("releasing a Surface leaves other Screens untouched", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11, "target-a");
  ownership.claim(A, "31");
  ownership.recordPendingTarget(A, "popup-a", 1_000);
  ownership.register(B, "40", 21, "target-b");
  ownership.recordPendingTarget(B, "popup-b", 2_000);
  ownership.releaseSurface(A);
  expect(ownership.windowsFor(A)).toEqual([]);
  expect(ownership.ownerOfSwayWindow("30")).toBeUndefined();
  expect(ownership.ownerOfSwayWindow("31")).toBeUndefined();
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
  expect(ownership.pendingTargets()).toEqual([{ surfaceId: B, targetId: "popup-b", createdAt: 2_000 }]);
  expect(ownership.windowsFor(B)).toHaveLength(1);
});

test("an unowned window belongs to no Screen and no Screen may bind it", () => {
  const ownership = new WindowOwnership();
  ownership.markUnowned("30");
  expect(ownership.isUnowned("30")).toBe(true);
  expect(ownership.isUnowned("31")).toBe(false);
  expect(ownership.claim(A, "30")).toBe(false);
  expect(() => ownership.register(A, "30", 11, "target-a")).toThrow("unowned");
  expect(ownership.ownerOfSwayWindow("30")).toBeUndefined();
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
  expect(ownership.windowsFor(A)).toEqual([]);
});

test("marking an owned window unowned releases the ownership it had", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11);
  ownership.markUnowned("30");
  expect(ownership.ownerOfSwayWindow("30")).toBeUndefined();
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
  expect(ownership.windowsFor(A)).toEqual([]);
  expect(ownership.isUnowned("30")).toBe(true);
});

test("pending targets preserve first identity and time without selecting by age or count", () => {
  const ownership = new WindowOwnership();
  const a = ownership.recordPendingTarget(A, "target-a", 1_000);
  expect(ownership.recordPendingTarget(A, "target-a", 1_400)).toBe(a);
  ownership.recordPendingTarget(B, "target-b", 1_200);
  expect(ownership.pendingTargets()).toEqual([
    { surfaceId: A, targetId: "target-a", createdAt: 1_000 },
    { surfaceId: B, targetId: "target-b", createdAt: 1_200 },
  ]);
  expect(() => ownership.recordPendingTarget(B, "target-a")).toThrow("another Screen");
  ownership.removePendingTarget("target-a");
  expect(ownership.hasPendingTarget(a)).toBe(false);
  expect(ownership.pendingTargets()).toEqual([{ surfaceId: B, targetId: "target-b", createdAt: 1_200 }]);
});

test("a restarted Bot Computer forgets every window, pop-up and unowned mark", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11, "target-a");
  ownership.markUnowned("31");
  ownership.recordPendingTarget(A, "popup-a", 1_000);
  ownership.reset();
  expect(ownership.windowsFor(A)).toEqual([]);
  expect(ownership.ownerOfSwayWindow("30")).toBeUndefined();
  expect(ownership.ownerOfBrowserWindow(11)).toBeUndefined();
  expect(ownership.isUnowned("31")).toBe(false);
  expect(ownership.pendingTargets()).toEqual([]);
  // A fresh Sway session may reuse neither id nor mark.
  expect(ownership.claim(A, "30")).toBe(true);
  expect(ownership.claim(A, "31")).toBe(true);
});

test("lookups hand out copies, so a caller cannot rewrite ownership", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11, "target-a");
  const [entry] = ownership.windowsFor(A);
  entry!.swayWindowId = "99";
  entry!.surfaceId = B;
  expect(ownership.ownerOfSwayWindow("30")).toBe(A);
  expect(ownership.ownerOfSwayWindow("99")).toBeUndefined();
  expect(ownership.ownerOfBrowserWindow(11)?.swayWindowId).toBe("30");
  ownership.recordPendingTarget(A, "popup-a", 1_000);
  const pending = ownership.pendingTargets()[0]!;
  expect(Object.isFrozen(pending)).toBe(true);
  expect(ownership.pendingTargets()[0]!.targetId).toBe("popup-a");
});

test("a parked window permits only guarded stamp completion, never an ordinary launch claim", () => {
  const ownership = new WindowOwnership();
  ownership.markParked("30");
  const candidate = ownership.recordPendingTarget(A, "page");
  expect(ownership.claim(A, "30")).toBe(false);
  expect(() => ownership.register(A, "30", 11)).toThrow("parked");
  expect(() => ownership.completePendingTarget({ ...candidate }, "30", 11)).toThrow("no longer pending");
  expect(ownership.completePendingTarget(candidate, "30", 11)).toMatchObject({ surfaceId: A, swayWindowId: "30", browserWindowId: 11 });
  expect(ownership.isParked("30")).toBe(false);
  expect(ownership.hasPendingTarget(candidate)).toBe(false);
  expect(() => ownership.completePendingTarget(candidate, "30", 11)).toThrow("no longer pending");
});

test("release and reset invalidate candidates and signals even before Browser Tool scoping", () => {
  const ownership = new WindowOwnership();
  const a = ownership.recordPendingTarget(A, "a");
  const b = ownership.recordPendingTarget(B, "b");
  const aSignal = ownership.surfaceSignal(A);
  const bSignal = ownership.surfaceSignal(B);
  ownership.markParked("30");
  ownership.releaseSurface(A);
  expect(aSignal.aborted).toBe(true);
  expect(bSignal.aborted).toBe(false);
  expect(() => ownership.completePendingTarget(a, "30", 11)).toThrow("no longer pending");
  const newA = ownership.recordPendingTarget(A, "a");
  expect(newA).not.toBe(a);
  expect(ownership.surfaceSignal(A).aborted).toBe(false);
  ownership.reset();
  expect(bSignal.aborted).toBe(true);
  expect(ownership.hasPendingTarget(b)).toBe(false);
  expect(ownership.hasPendingTarget(newA)).toBe(false);
  expect(ownership.isParked("30")).toBe(false);
});

test("failed stamp registration retains parked state and pending identity without corrupting indexes", () => {
  const ownership = new WindowOwnership();
  ownership.register(B, "40", 11, "b");
  ownership.markParked("30");
  const a = ownership.recordPendingTarget(A, "a");
  expect(() => ownership.completePendingTarget(a, "30", 11)).toThrow("another Screen");
  expect(ownership.isParked("30")).toBe(true);
  expect(ownership.hasPendingTarget(a)).toBe(true);
  expect(ownership.ownerOfBrowserWindow(11)?.surfaceId).toBe(B);
  expect(ownership.windowsFor(A)).toEqual([]);
  ownership.markUnowned("30");
  expect(() => ownership.completePendingTarget(a, "30", 12)).toThrow("temporarily parked");
});

test("a registered Sway identity cannot silently change Chromium windows", () => {
  const ownership = new WindowOwnership();
  ownership.register(A, "30", 11);
  expect(() => ownership.register(A, "30", 12)).toThrow("another browser window");
  expect(ownership.ownerOfBrowserWindow(11)?.swayWindowId).toBe("30");
  expect(ownership.ownerOfBrowserWindow(12)).toBeUndefined();
});
