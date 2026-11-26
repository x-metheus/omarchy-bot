# Native keychain libraries

1. **`@napi-rs/keyring` is a napi-rs binding of the Rust `keyring-rs` crate, MIT-licensed, latest 2.1.2 published 2026-10-19.** Package created 2023-02-25; 2.x cadence was roughly weekly in Sept–Oct 2026 (2.0.0 → 2026-08-31, 2.1.0 → 2026-09-13, 2.1.1 → 2026-10-10, 2.1.2 → 2026-10-19). License MIT at the JS package level, but note finding 3. URL: https://registry.npmjs.org/@napi-rs/keyring [direct, high]

2. **Prebuilt binaries cover 12 platform targets via `optionalDependencies`, so no Rust toolchain is needed.** Targets: darwin-x64/arm64, linux-x64-gnu/musl, linux-arm64-gnu/musl, linux-arm-gnueabihf, linux-riscv64-gnu, freebsd-x64, win32-x64/ia32/arm64-msvc. Binaries are built `--locked` from a committed `Cargo.lock` with `cargo auditable`, and each platform package ships `LICENSE.third-party.md`. No `os`/`cpu` fields on the root package. URL: https://registry.npmjs.org/@napi-rs/keyring/latest [direct, high]

3. **On Linux the binaries statically link `libdbus` (vendored via `libdbus-sys`) and talk D-Bus to the Secret Service — they do not link `libsecret`.** README note: "the Linux binaries statically link `libdbus` (built from the sources vendored by `libdbus-sys`), which is licensed under `AFL-2.1 OR GPL-2.0-or-later` rather than the crate's own `MIT OR Apache-2.0`." Practical consequence: no `libsecret-1-dev` build dependency at install time, but a GPL/AFL-2.1 component in the Linux binaries. URL: https://www.npmjs.com/package/@napi-rs/keyring [direct, high]

4. **API shape: `Entry` (sync) and `AsyncEntry` classes with a keytar-like surface, plus a Linux store selector.** Usage shown: `new Entry('my_service', 'my_name')`, `entry.setPassword(...)`, `entry.getPassword()`, `entry.deletePassword()`, `Entry.withTarget(...)`, and a Linux options bag `{ linux: { store: 'secret-service' | 'keyutils' } }`. URL: https://www.npmjs.com/package/@napi-rs/keyring [direct, high]

5. **Linux backend: Secret Service (`dbus-secret-service-keyring-store`) is tried first, with silent fallback to the kernel keyutils keyring when no Secret Service daemon is present.** Pinning a store with the `linux.store` option throws if that store is unavailable. keyutils is in-memory and does not persist across reboots; the README advises `secret-service` for credentials that must survive a restart. URL: https://github.com/Brooooooklyn/keyring-node [direct, high]

6. **`keyring-node` is actively maintained and self-describes as "100% compatible node-keytar alternative".** `archived: false`, `pushed_at` 2026-11-24, 4 open issues, 109 stars. URL: https://api.github.com/repos/Brooooooklyn/keyring-node [direct, high]

7. **`atom/node-keytar` is archived; last push 2022-12-12, 77 open issues, 1424 stars.** The API returns `"archived": true`; the README still carries no deprecation text of its own. Archive banner date was not capturable in this pass, but the last code push correlates with the archive. URL: https://api.github.com/repos/atom/node-keytar [direct (archived flag, push date) / interpretation (archive timing), medium]

8. **keytar on npm is at 7.9.0 (MIT) and is *not* formally marked deprecated in the registry; its install script is `prebuild-install || npm run build` with `node-addon-api ^4.3.0`.** Because there is no `deprecated` field and no README deprecation notice, the archive is a maintenance signal rather than an npm-level deprecation. Linux install requires libsecret dev headers: Debian/Ubuntu `libsecret-1-dev`, RHEL `libsecret-devel`, Arch `libsecret`. Prebuilt binaries exist for supported Node/Electron versions, with `node-gyp rebuild` as the compile fallback. URL: https://www.npmjs.com/package/keytar [direct, high]

9. **The ecosystem replacement is `@napi-rs/keyring` (keyring-node), which explicitly markets keytar API compatibility.** Combined with keytar's archive status, that is the drop-in path named by the successor project itself. URL: https://github.com/Brooooooklyn/keyring-node [direct (compat claim) / interpretation (that it is *the* replacement), medium]

10. **Yes — the Linux path still needs a running Secret Service daemon for persistence; the difference versus a CLI tool is that the library can fall back instead of failing.** A native library does change the headless story: instead of shelling out to `secret-tool` (which requires a live `org.freedesktop.secrets` provider such as gnome-keyring/KWallet), `@napi-rs/keyring` transparently degrades to kernel keyutils (in-memory, lost on reboot) or throws if you pin `secret-service`. URL: https://github.com/Brooooooklyn/keyring-node [interpretation, high]

11. **Bun loads prebuilt N-API addons: "Bun implements this interface from scratch, so most existing Node-API extensions work with Bun out of the box."** `require("./my-node-module.node")` and `process.dlopen(mod, "...")` both work. No specific N-API version number is stated on that page, and the qualifier is "most", not "all". URL: https://bun.com/docs/runtime/node-api [direct, high]

12. **`bun build --compile` has a documented, explicit story for `.node` addons: "You can embed `.node` files into executables."** Caveats: require the `.node` directly when using `@mapbox/node-pre-gyp` or it won't bundle; addons with sidecar shared libraries (sharp/libvips style) need `--asset` on the folder, and with `--aot` "an extra entry point is always compiled as code, so use `--asset` for these"; symlinks and empty dirs are skipped; embedded files are read-only (`EROFS`). Separately, `node:sea` is not implemented — use `bun build --compile`. URL: https://bun.com/docs/compiler/executables [direct, high]

13. **Other maintained options worth naming:** the upstream Rust `keyring` crate (`hwchen/keyring-rs`) directly if you have a Rust build step — it exposes more store backends than the Node binding surfaces; `bun:ffi` (or a small Rust/N-API shim) calling Security.framework on macOS and `libsecret`/D-Bus on Linux to avoid a dependency entirely; and CLI fallbacks (`security` on macOS, `secret-tool` on Linux, PowerShell CredentialManager on Windows) that keep the zero-dependency property at the cost of a subprocess and a daemon requirement. URL: https://github.com/hwchen/keyring-rs [interpretation, medium]

## Unverified

- **Weekly download counts** for `@napi-rs/keyring` and `keytar`: the npm page extraction did not surface them; no download figures are claimed here.
- **Exact date node-keytar flipped to archived** (only `pushed_at` 2022-12-12 is confirmed; the archive likely followed within weeks).
- **Bun's implemented N-API version number**: the Node-API doc page asserts compatibility without naming a version; `process.versions.napi` on a real Bun build would settle it.
- **Bun.secrets / a Bun-native keychain API**: a plausible first-party option, but it was not fetched in this pass (10-call budget) and must not be treated as verified.
- **Whether keyring-rs's non-secret-service stores** (e.g. encrypted-file) are reachable through `@napi-rs/keyring`: the binding documents only `secret-service` and `keyutils`.
- **macOS/Windows backends of keyring-node**: not described in the fetched README text; by upstream crate behavior they should be Keychain and Credential Manager, but that is inference.
- **Source validation**: `source_check` was unavailable by instruction (rate-limited provider), so claims rest on direct page/registry/API extraction only.
