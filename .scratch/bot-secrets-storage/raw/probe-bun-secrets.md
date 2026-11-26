# Local probe: Bun.secrets behaviour

Evidence class: **direct, first-hand**, measured on this workstation (Linux, Bun 1.4.5,
`bun --version`). Not a published source — cite it as "measured locally, 2026-11-25".

Scope limit: the probe only created, read back and deleted its own throwaway items under a
random `service` name (`omarchy-bot-probe-<random>`). It did not read any pre-existing
keychain item. All probe items were deleted at the end of the run.

## 1. Presence

```
$ bun --version
1.4.5
$ bun -e 'console.log(typeof Bun.secrets, Object.keys(Bun.secrets))'
object [ "get", "set", "delete" ]
```

So `Bun.secrets` is present in Bun 1.4.5 with exactly three methods.

## 2. Round-trip and error semantics

Probe body (summarised):

```
await Bun.secrets.set({ service, name: "a", value: small });
(await Bun.secrets.get({ service, name: "a" })) === small      // exact
await Bun.secrets.set({ service, name: "a", value: "second" });
(await Bun.secrets.get({ service, name: "a" })) === "second"   // replaces
await Bun.secrets.get({ service, name: "nope" })                // → null
await Bun.secrets.delete({ service, name: "a" })                // → true
await Bun.secrets.delete({ service, name: "a" })                // → false
```

Observed output:

```
small roundtrip exact: true
replace wins: true
missing item: null
2048 bytes -> stored len 2048 exact
4096 bytes -> stored len 4096 exact
8192 bytes -> stored len 8192 exact
delete present: true
delete absent: false
```

Consequences for `SecretBackend` (see `apps/daemon/src/modules/runtime/secrets.ts`):

- `get()` → `null` means absent; the adapter must map `null` to `undefined`, because the
  store treats a `string | undefined` and throws its own `"Unable to read secret"` only when
  the backend throws.
- `delete()` → `false` for an absent account must be swallowed. The branch's interface doc
  says "Deleting an absent account succeeds", so `false` must not throw.
- `set()` replaced the value exactly once in this probe, and read-back was byte-identical,
  which is what the migration's read-back verification requires.

## 3. Size ceiling

The documented limit is "typically 2048-4096 bytes". On this machine an 8192-byte value
round-tripped exactly. So the documented cap is soft and platform-dependent, and it is not
a reason to reject Bun.secrets for provider keys or OAuth tokens. It *is* a reason not to
store large blobs there without a fallback (envelope encryption would remove the concern).

## 4. Headless behaviour — the important one

With the session bus available:

```
$ bun -e 'Bun.secrets.get({service:"omarchy-bot-probe-nonexistent",name:"probe"})…'
resolved: null
```

With no session bus and no runtime dir:

```
$ env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR bun -e 'Bun.secrets.get(…)'
rejected: Error Error spawning command line
  "dbus-launch --autolaunch=c90990e1… --binary-syntax --close-stderr":
  Child process exited with code 1 (code: 1)
```

Findings:

1. A missing Secret Service is a **rejected promise**, not `null`. `null` unambiguously means
   "no such item", so the two cases are distinguishable — the backend can map "no keychain"
   to a keychain→file fallback decision and "no such item" to `undefined`.
2. Bun shells out to `dbus-launch --autolaunch` when there is no session bus. So on a headless
   host Bun's Linux path does more than a D-Bus connect: it attempts an autolaunch, which
   needs a working `dbus-launch` binary and an X11 autolaunch address. On a server it fails,
   and it fails as an ordinary error rather than hanging.
3. Because the failure surfaces as a thrown error, a capability probe at startup (an
   inexpensive `get` for a sentinel name) is enough to choose keychain vs file, and the
   store already treats a throwing backend as "cannot use".
4. The probe cannot tell us what a *locked* keyring does. Bun's docs say it "may prompt for
   unlock"; a prompt on a headless or systemd unit would block, and this was not exercised.

## Not tested

- Locked keyring (prompt vs error vs block).
- Windows and macOS paths — no such host was available; those claims rest on Bun's docs and
  the platform documentation gathered separately.
- `bun build --compile` binaries (the daemon is run from source today).
