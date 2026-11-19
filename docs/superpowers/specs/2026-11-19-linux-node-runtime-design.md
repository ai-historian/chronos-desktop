# Linux agent runtime — design

**Problem.** The agent (pi + the chronos pi-package) runs inside Electron's own binary
started as Node (`ELECTRON_RUN_AS_NODE=1`). On Linux that binary is dynamically linked
against the system GLib/GObject/GTK, so those libraries are in the process before sharp
loads. sharp's prebuilt libvips carries a private GLib; its `g_object_unref` calls resolve
to the system copy instead. With GLib 2.80 (Ubuntu 24.04) that logs
`GLib-GObject-CRITICAL: g_object_unref: assertion 'G_IS_OBJECT (object)' failed` on every
decode; with the newer GLib of Ubuntu 26.04 it is a SIGSEGV in `g_object_unref` (crash
report from a tester, 2026-11-17). sharp documents it as a known Electron-on-Linux
conflict (electron#46323, open). Under a plain Node binary the same decode is clean.

**Fix.** On Linux, packaged builds ship an official Node binary and spawn the agent with
it. macOS and Windows keep Electron-as-Node (no GLib there). Dev mode (`npm run dev`) is
unchanged.

| | runtime for the agent |
|---|---|
| packaged, Linux | `resources/vendor/node/bin/node` (official nodejs.org build) |
| packaged, macOS / Windows | Electron binary with `ELECTRON_RUN_AS_NODE=1` (as today) |
| dev, any OS | Electron binary with `ELECTRON_RUN_AS_NODE=1` (as today) |
| packaged, Linux, but `vendor/node/bin/node` missing | Electron-as-Node, with a warning in the app log |

**Version.** `package.json` gains `"nodeRuntimeVersion": "24.22.2"`, the Node that
Electron 45 embeds, so pi runs on the same Node line either way. pi requires ≥ 22.19.

**Bundling.** `scripts/bundle-agent.mjs`, on Linux only, downloads
`https://nodejs.org/dist/v<V>/node-v<V>-linux-<arch>.tar.xz` (arch = `process.arch`,
`x64` or `arm64`) and `SHASUMS256.txt`, verifies the tarball's SHA-256 against the list,
and extracts only `bin/node` and `LICENSE` into `vendor/node/`. The tarball is cached in
`<repo>/.cache/node/` (gitignored like the Electron caches) and re-verified, not
re-downloaded, when present. On macOS/Windows the bundler removes any stale `vendor/node`.
`vendor/` already ships whole as `resources/vendor/` (extraResources), so no
electron-builder change is needed. Node's LICENSE is copied to
`resources/licenses/node.txt`.

**Size.** +32 MB compressed, +120 MB unpacked, Linux installers only.

**Out of scope.** Switching macOS/Windows to a real Node; dev mode; Linux arm64 installers
(the bundler handles the arch, CI builds x64 only).
