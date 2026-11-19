# Linux Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Packaged Linux builds spawn the agent with a bundled official Node binary instead of Electron-as-Node, which removes the GLib conflict that crashes sharp.

**Architecture:** `resolveVendorPaths` learns the platform and returns `nodeBin` for packaged Linux; `buildPiLaunch` uses that binary (without `ELECTRON_RUN_AS_NODE`) when it exists and falls back to the Electron binary otherwise. `scripts/bundle-agent.mjs` downloads, verifies and extracts the pinned Node into `vendor/node/` on Linux.

**Tech Stack:** Electron 45, Node 24.22.2 official tarball, node:test via tsx, electron-builder 26.

**Spec:** `docs/superpowers/specs/2026-11-19-linux-node-runtime-design.md`

## Global Constraints

- `"nodeRuntimeVersion": "24.22.2"` in `package.json` (sibling of `piVersion`); the bundler reads it, nothing is hardcoded elsewhere.
- Packaged Linux: `nodeBin = <resourcesPath>/vendor/node/bin/node`. Any other case: `nodeBin` undefined.
- Launcher: with an existing `nodeBin` → `bin = nodeBin` and **no** `ELECTRON_RUN_AS_NODE` key in `env`; otherwise exactly today's behaviour (`bin = execPath`, `ELECTRON_RUN_AS_NODE: "1"`). Everything else in args/env unchanged.
- Bundler, Linux: download URL `https://nodejs.org/dist/v<V>/node-v<V>-linux-<arch>.tar.xz`, SHA-256 verified against `https://nodejs.org/dist/v<V>/SHASUMS256.txt` (fail hard on mismatch or missing entry); cache dir `<appRoot>/.cache/node/`; extract only `bin/node` and `LICENSE` to `vendor/node/`; `vendor/node/bin/node` must be executable and `--version` must print `v<V>`; `LICENSE` → `resources/licenses/node.txt`. Non-Linux: `rmSync(vendor/node)`.
- Commits: author Lorenz Hufe <lorenz.hufe@posteo.de>, no Co-Authored-By trailers (`git -c user.name="Lorenz Hufe" -c user.email="lorenz.hufe@posteo.de" commit …`). `npm run typecheck` clean before every commit touching `src/`.
- Pre-existing flake: `test/agent-host.test.ts` "collection message is stored and rediscoverSources re-selects all sources" may fail under the full `npm test`; it passes alone. Note it, do not chase it.

## Review Focus

1. A packaged Linux build whose `vendor/node` is missing (e.g. a bundler run on another OS copied over) must still start the agent, via Electron-as-Node, and say so in the log. (Task 1 test "falls back to Electron when nodeBin is missing")
2. The Node binary must keep its executable bit through electron-builder's extraResources copy into the .deb and the AppImage. (Task 3 check on the built .deb)
3. A corrupted or truncated cached tarball must not be used: the hash check runs on the cached file too. (Task 2 self-check by corrupting the cache)
4. The agent's `.env`/skills handling is untouched: workspace keys still cannot override the launcher's own vars. (Task 1 existing tests keep passing)
5. The app log must show which runtime the agent runs on, so a user report tells us at once. (Task 1 `main.ts` log line)

---

### Task 1: Runtime selection in paths and the launcher

**Files:**
- Modify: `src/main/paths.ts`, `src/main/pi-launcher.ts`, `src/main/main.ts` (the `[chronos] pi cli:` log line in `whenReady` and the `buildPiLaunch` call), `package.json` (add `nodeRuntimeVersion`)
- Test: `test/pi-launcher.test.ts`

**Interfaces:**
- Produces: `VendorPaths { piCli: string; agentDir: string; nodeBin?: string }`; `resolveVendorPaths(opts: { isPackaged: boolean; resourcesPath: string; appRoot: string; platform?: NodeJS.Platform })` (default `process.platform`); `buildPiLaunch` unchanged in signature, reads `opts.vendor.nodeBin`.

- [ ] **Step 1: Write the failing tests** — extend the existing `resolveVendorPaths packaged vs dev` test (the packaged expectation gains `platform: "darwin"` → no `nodeBin`; add a `platform: "linux"` case expecting `nodeBin: join("/res","vendor","node","bin","node")`; dev on linux → no `nodeBin`), and add:

```ts
test("uses the bundled node when nodeBin exists, without ELECTRON_RUN_AS_NODE", () => {
  const dir = mkdtempSync(join(tmpdir(), "chronos-node-"));
  try {
    const nodeBin = join(dir, "node"); writeFileSync(nodeBin, "");
    const l = buildPiLaunch({ vendor: { piCli: "/x/cli.js", agentDir: "/a", nodeBin }, workspaceDir: "/w", userDataDir: "/u", httpPort: 1, execPath: "/e" });
    assert.equal(l.bin, nodeBin);
    assert.equal("ELECTRON_RUN_AS_NODE" in l.env, false);
    assert.equal(l.env.CHRONOS_HTTP_PORT, "1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("falls back to Electron when nodeBin is missing", () => {
  const l = buildPiLaunch({ vendor: { piCli: "/x/cli.js", agentDir: "/a", nodeBin: "/nope/node" }, workspaceDir: "/w", userDataDir: "/u", httpPort: 1, execPath: "/e" });
  assert.equal(l.bin, "/e");
  assert.equal(l.env.ELECTRON_RUN_AS_NODE, "1");
});
```

- [ ] **Step 2: Run** `node --import tsx --test test/pi-launcher.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. In `main.ts`, extend the existing startup line to `[chronos] pi cli: … (agent: …, runtime: <nodeBin or "electron">)`, and when `nodeBin` is set but does not exist log `[chronos] bundled node missing at <path>; running the agent under Electron` (warn level). Add `"nodeRuntimeVersion": "24.22.2"` under `piVersion` in `package.json`.
- [ ] **Step 4: Run** the launcher tests and `npm run typecheck` — expected: PASS / clean. Run `npm test` once.
- [ ] **Step 5: Commit** `fix(v2): spawn the agent with a bundled node on packaged Linux`

---

### Task 2: Vendor the Node runtime in the bundler

**Files:**
- Modify: `scripts/bundle-agent.mjs`, `.gitignore` (add `.cache/` if not present), `README.md` ("The `vendor/` rule" and "Building installers": say Linux builds bundle Node `nodeRuntimeVersion` for the agent and why), `CLAUDE.md` (line about `ELECTRON_RUN_AS_NODE` in the main-process bullet)
- Test: manual run of the bundler + checks below (no unit-test runner covers this script)

**Interfaces:**
- Consumes: `nodeRuntimeVersion` from `package.json` (Task 1).
- Produces: `vendor/node/bin/node`, `vendor/node/LICENSE`, `resources/licenses/node.txt` on Linux.

- [ ] **Step 1: Implement** a `// --- node runtime (Linux) ---` section after the agent section: skip with `rmSync(join(vendor,"node"), {recursive:true, force:true})` unless `process.platform === "linux"`; map `process.arch` `x64`→`x64`, `arm64`→`arm64`, else throw; download with `fetch` (Node 22+) into `.cache/node/`; parse `SHASUMS256.txt` for the tarball's line; compare with `createHash("sha256")` of the file; on mismatch delete the cached file and throw; extract with `execSync("tar -xJf <tar> --strip-components=1 -C vendor/node node-v<V>-linux-<arch>/bin/node node-v<V>-linux-<arch>/LICENSE")`; `chmodSync(…, 0o755)`; assert `execSync("<vendor/node/bin/node> --version").toString().trim() === "v<V>"`; `copyLicense(join(vendor,"node","LICENSE"), "node")`. Log one line `vendored node v<V> (linux-<arch>) -> vendor/node/bin/node`.
- [ ] **Step 2: Verify** — `node scripts/bundle-agent.mjs` (several minutes; it also rebuilds the agent). Then: `vendor/node/bin/node --version` prints `v24.22.2`; `ldd vendor/node/bin/node | grep -c -E "libglib|libgobject|libgtk"` prints `0`; `ls -l resources/licenses/node.txt` exists. Corrupt the cache (`truncate -s 1000 .cache/node/node-v24.22.2-linux-x64.tar.xz`) and run the bundler again — expected: it fails with the hash message and removes the bad file; run once more — expected: success (fresh download).
- [ ] **Step 3: Docs** as listed in Files.
- [ ] **Step 4: Commit** `build(v2): vendor the pinned Node runtime for the agent on Linux`

---

### Task 3: Verification on a built package (controller)

- [ ] `npm run dist -- --linux deb --publish never`; `dpkg-deb -c dist/chronos_*.deb | grep vendor/node/bin/node` shows mode `-rwxr-xr-x`.
- [ ] Extract the .deb; `ldd x/opt/Chronos/resources/vendor/node/bin/node | grep -c -E "libglib|libgobject"` prints 0; run the sharp decode self-test under that node with a real page PNG — expected: `ok …` and **no** `GLib-GObject-CRITICAL` line (contrast: the same test under `x/opt/Chronos/chronos` with `ELECTRON_RUN_AS_NODE=1` prints the CRITICAL line).
- [ ] Launch `x/opt/Chronos/chronos --workspace <workspace>`; the app log's `starting pi:` line names `…/vendor/node/bin/node`.
