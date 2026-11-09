# Auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chronos checks the public GitHub releases for a newer version, shows a banner, and on Windows and AppImage downloads and installs it; elsewhere it links to the download page.

**Architecture:** An Electron-free `UpdateHost` in main wraps an `electron-updater`-shaped object (`UpdaterLike`) and turns its events into one `update/status` message for the renderer plus `notify` toasts; `main.ts` instantiates it with the real `autoUpdater`, decides the mode with `updateMode`, and routes `update/*` renderer messages and two Help-menu items to it. The renderer keeps the status in `chronos-app` state and renders a banner. The automatic check is gated by a new boolean in the app settings.

**Tech Stack:** Electron 45, electron-builder 26 + electron-updater 6.8 (GitHub provider), Lit, node:test via tsx, Playwright `_electron` e2e.

**Spec:** `docs/superpowers/specs/2026-11-09-auto-update-design.md`

## Global Constraints

- `electron-updater` goes into `dependencies` (electron-builder ships production deps) and into esbuild's `external` list, like `mupdf`.
- Mode table from the spec, exactly: not packaged or `CHRONOS_E2E=1` → `off`; `win32` → `install`; `linux` with `APPIMAGE` set → `install`, without → `notify`; `darwin` → `notify`; anything else → `notify`.
- Banner copy verbatim from the spec table. Toasts: `Chronos <current> is up to date.`, `Update check failed: <message>`, `Update download failed: <message>`.
- `DOWNLOAD_PAGE = "https://hufe.info/chronos/"`.
- Automatic check: 15 000 ms after `whenReady`, only if `checkForUpdates` is true.
- Nothing installs while the app runs: `autoDownload = false`, `autoInstallOnAppQuit = true`; downloads start only from the Download button.
- Commits: author Lorenz Hufe <lorenz.hufe@posteo.de>, no Co-Authored-By trailers (`git -c user.name="Lorenz Hufe" -c user.email="lorenz.hufe@posteo.de" commit …`).
- Run `npm run typecheck` before every commit that touches `src/`; esbuild does not type-check.

## Review Focus

1. Manual check while a download is running: must be ignored, not restart the download or post a second banner. (Task 2 test "check is ignored while downloading")
2. Download fails half-way: status must return to `available` so Download can be retried, with one warning toast. (Task 2 test "download error returns to available and warns")
3. Automatic check fails (offline): must be silent apart from the log, no toast, no banner. (Task 2 test "automatic check error is logged only")
4. Main window closed and reopened after an update is ready: the banner must come back. (Task 2 test "repost re-sends the current status")
5. A .deb or macOS user clicks the banner button: must open exactly `DOWNLOAD_PAGE`, never try to download. (Task 2 test "notify mode: download is a no-op, openDownloadPage opens the page")

---

### Task 1: Settings flag

**Files:**
- Modify: `src/main/app-settings.ts`
- Test: `test/app-settings.test.ts`

**Interfaces:**
- Produces: `AppSettings { theme: "system" | "light" | "dark"; checkForUpdates: boolean }`, default `{ theme: "system", checkForUpdates: true }`. `readAppSettings`/`writeAppSettings` signatures unchanged.

- [ ] **Step 1: Write the failing tests** — extend the three existing tests so every expected object carries `checkForUpdates`, and add:

```ts
test("checkForUpdates round-trips and defaults to true", () => {
  const d = dir();
  writeAppSettings(d, { theme: "light", checkForUpdates: false });
  assert.deepEqual(readAppSettings(d), { theme: "light", checkForUpdates: false });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.deepEqual(readAppSettings(d), { theme: "dark", checkForUpdates: true });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ checkForUpdates: "no" }));
  assert.deepEqual(readAppSettings(d), { theme: "system", checkForUpdates: true });
});
```

- [ ] **Step 2: Run** `node --import tsx --test test/app-settings.test.ts` — expected: FAIL (type error / missing field).
- [ ] **Step 3: Implement** — add the field to `AppSettings` and `DEFAULTS`; in `readAppSettings` accept only a boolean, else the default.
- [ ] **Step 4: Run** the same command — expected: PASS.
- [ ] **Step 5: Commit** `feat(v2): checkForUpdates app setting`

---

### Task 2: Protocol types and UpdateHost

**Files:**
- Modify: `src/shared/webview-protocol.ts`
- Create: `src/main/update-host.ts`
- Test: `test/update-host.test.ts`

**Interfaces:**
- Produces in `webview-protocol.ts`:

```ts
export type UpdateStatus =
  | { kind: "none" }
  | { kind: "available"; version: string; mode: "install" | "notify" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string };
// ExtToWebview gains:   | { type: "update/status"; status: UpdateStatus }
// WebviewToExt gains:   | { type: "update/download" } | { type: "update/install" } | { type: "update/openDownloadPage" }
```

- Produces in `update-host.ts`:

```ts
export const DOWNLOAD_PAGE = "https://hufe.info/chronos/";
export type UpdateMode = "install" | "notify" | "off";
export function updateMode(o: { platform: NodeJS.Platform; isPackaged: boolean; env: NodeJS.ProcessEnv }): UpdateMode;

/** The slice of electron-updater's AppUpdater that UpdateHost uses (tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error", listener: (arg: any) => void): unknown;
}
export type ManualResult = { kind: "upToDate"; version: string } | { kind: "available"; version: string } | { kind: "error"; message: string };
export interface UpdateHostOptions {
  updater: UpdaterLike;
  mode: "install" | "notify";
  currentVersion: string;
  post: (msg: ExtToWebview) => void;        // to the main window; main makes it a no-op when there is none
  openExternal: (url: string) => void;
  log: (line: string) => void;
  onManualResult?: (r: ManualResult) => void; // main shows a dialog when no main window is open
}
export class UpdateHost {
  constructor(o: UpdateHostOptions);
  get status(): UpdateStatus;
  check(o: { manual: boolean }): Promise<void>;   // resolves when the updater's checkForUpdates settles; never rejects
  download(): void;
  install(): void;
  openDownloadPage(): void;
  repost(): void;                                  // posts update/status with the current status
  handleWebviewMessage(msg: WebviewToExt): boolean; // true when it consumed an update/* message
}
```

Behaviour to pin (the constructor sets `autoDownload = false`, `autoInstallOnAppQuit = true` and subscribes once):
- `update-available` → status `available` (with `o.mode`), post `update/status`; if the check was manual also `onManualResult({kind:"available"})`.
- `update-not-available` → if manual: post `notify` info `Chronos <currentVersion> is up to date.` and `onManualResult({kind:"upToDate"})`; otherwise nothing.
- `download-progress` → status `downloading` with `percent: Math.round(p.percent)`, post.
- `update-downloaded` → status `ready`, post.
- `error` while checking → log; if manual, post `notify` warning `Update check failed: <message>` and `onManualResult({kind:"error"})`. While downloading → status back to `available`, post, and `notify` warning `Update download failed: <message>`.
- `check` while a check or a download is in progress → no-op. The rejection of `checkForUpdates()` is swallowed (the `error` event already reported it).
- `download()` only when status is `available` and mode is `install`: status `downloading 0`, post, then `updater.downloadUpdate()` (rejection swallowed). `install()` only when `ready`: `quitAndInstall()`. `openDownloadPage()` → `openExternal(DOWNLOAD_PAGE)`.
- `handleWebviewMessage` maps `update/download` → `download()`, `update/install` → `install()`, `update/openDownloadPage` → `openDownloadPage()`; returns false for anything else.

- [ ] **Step 1: Write the failing tests** in `test/update-host.test.ts`. Use a `FakeUpdater` (EventEmitter-style `on`, records calls, `checkForUpdates`/`downloadUpdate` return promises you resolve or reject per test, `emit(event, arg)` helper). Tests:

```ts
test("updateMode table", () => {
  const env = {};
  assert.equal(updateMode({ platform: "win32", isPackaged: true, env }), "install");
  assert.equal(updateMode({ platform: "linux", isPackaged: true, env: { APPIMAGE: "/x/Chronos.AppImage" } }), "install");
  assert.equal(updateMode({ platform: "linux", isPackaged: true, env }), "notify");
  assert.equal(updateMode({ platform: "darwin", isPackaged: true, env }), "notify");
  assert.equal(updateMode({ platform: "win32", isPackaged: false, env }), "off");
  assert.equal(updateMode({ platform: "win32", isPackaged: true, env: { CHRONOS_E2E: "1" } }), "off");
});
test("constructor configures the updater", ...)            // autoDownload false, autoInstallOnAppQuit true
test("available posts a banner status (install mode)", ...) // posted[0] deepEquals { type:"update/status", status:{ kind:"available", version:"0.4.0", mode:"install" } }
test("manual check that finds nothing toasts and reports", ...) // notify info "Chronos 0.3.0 is up to date.", onManualResult upToDate
test("automatic check that finds nothing is silent", ...)   // posted.length === 0
test("automatic check error is logged only", ...)           // log called, posted.length === 0
test("manual check error warns", ...)                       // notify warning "Update check failed: boom", onManualResult error
test("download: progress then ready", ...)                  // statuses downloading 0 → downloading 42 → ready; downloadUpdate called once
test("download error returns to available and warns", ...)
test("check is ignored while downloading", ...)             // checkForUpdates called once in total
test("notify mode: download is a no-op, openDownloadPage opens the page", ...) // downloadUpdate never called; openExternal("https://hufe.info/chronos/")
test("install only when ready", ...)                        // quitAndInstall not called before update-downloaded, called after
test("repost re-sends the current status", ...)
test("handleWebviewMessage consumes only update messages", ...) // returns false for { type: "login" }
```

- [ ] **Step 2: Run** `node --import tsx --test test/update-host.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3: Add the protocol types**, then implement `src/main/update-host.ts` per the interface block. Keep a private `phase: "idle" | "checking" | "downloading"` plus `manual: boolean` for the current check.
- [ ] **Step 4: Run** the tests — expected: PASS. Then `npm run typecheck` — expected: clean (the renderer does not use the new types yet).
- [ ] **Step 5: Commit** `feat(v2): UpdateHost and update/* protocol messages`

---

### Task 3: Help-menu items

**Files:**
- Modify: `src/main/menu.ts`
- Test: `test/menu.test.ts`

**Interfaces:**
- Produces: `MenuActions` gains `checkForUpdates(): void; toggleUpdateCheck(): void;`. `MenuState` gains `updateCheck: boolean; updatesSupported: boolean`.
- Help submenu becomes, in order: Documentation, Discord, Report issue, separator, `Check for updates…` (enabled: `updatesSupported`, click `checkForUpdates`), `Check for updates automatically` (type checkbox, checked `updateCheck`, enabled `updatesSupported`, click `toggleUpdateCheck`), separator, Show logs, About.

- [ ] **Step 1: Write the failing tests** — add `"checkForUpdates", "toggleUpdateCheck"` to `names` in `mkActions`, add `updateCheck: true, updatesSupported: true` to `base`, and:

```ts
test("help menu has the update items", () => {
  const calls: string[] = [];
  const help = top(buildMenu(mkActions(calls), base, "linux"), "Help");
  assert.deepEqual(sub(help).map((i) => i.label ?? i.type), ["Documentation", "Discord", "Report issue", "separator", "Check for updates…", "Check for updates automatically", "separator", "Show logs", "About"]);
  const auto = item(help, "Check for updates automatically");
  assert.equal(auto.type, "checkbox");
  assert.equal(auto.checked, true);
  (item(help, "Check for updates…").click as () => void)();
  (auto.click as () => void)();
  assert.deepEqual(calls, ["checkForUpdates", "toggleUpdateCheck"]);
});
test("update items are disabled when updates are unsupported", () => {
  const help = top(buildMenu(mkActions(), { ...base, updatesSupported: false }, "linux"), "Help");
  assert.equal(item(help, "Check for updates…").enabled, false);
  assert.equal(item(help, "Check for updates automatically").enabled, false);
});
```

- [ ] **Step 2: Run** `node --import tsx --test test/menu.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement** in `menu.ts`.
- [ ] **Step 4: Run** the menu tests — expected: PASS. `npm run typecheck` will now FAIL in `main.ts` (missing actions/state); that is fixed in Task 4, so do not commit `src/` typecheck-clean here — instead commit with the note that Task 4 completes the contract.
- [ ] **Step 5: Commit** `feat(v2): Help menu items for update checks`

---

### Task 4: Wire it up in main, dependency, docs

**Files:**
- Modify: `package.json` (add `"electron-updater": "^6.8.0"` to `dependencies`; run `npm install`), `esbuild.mjs` (`external: ["electron", "mupdf", "electron-updater"]`), `src/main/main.ts`, `README.md`
- Test: `npm run typecheck`, `npm run build`, `npm test`, `node -e "require('electron-updater')"`

**Interfaces:**
- Consumes: Task 1 settings, Task 2 `UpdateHost`/`updateMode`/`ManualResult`, Task 3 menu contract.

- [ ] **Step 1:** `npm install electron-updater@^6.8.0` and add it to esbuild externals. Verify `node -e "require('electron-updater')"` prints nothing.
- [ ] **Step 2: Implement in `main.ts`:**
  - Replace `themePref` handling with a single `let settings: AppSettings` read in `whenReady`; `setThemePref` and the new `toggleUpdateCheck` both go through `saveSettings(patch: Partial<AppSettings>)` which merges, writes, and calls `rebuildMenu()`.
  - `let updateHost: UpdateHost | undefined; let updateModeValue: UpdateMode`. In `whenReady`, after `rebuildMenu()`: `updateModeValue = updateMode({ platform: process.platform, isPackaged: app.isPackaged, env: process.env })`; if not `off`, `const { autoUpdater } = require("electron-updater")` (a top-level `import` is fine too since it is external), set `autoUpdater.logger = null` and instead log through the `log` option as `[update] …` via `console.log`; construct `UpdateHost` with `post: sendToMain`, `openExternal: (u) => void shell.openExternal(u)`, `currentVersion: app.getVersion()`, `onManualResult: (r) => { if (!mainWindow || mainWindow.isDestroyed()) dialog.showMessageBox({ type: r.kind === "error" ? "warning" : "info", title: "Chronos updates", message: text(r) }) }` where `text` gives `Chronos <version> is up to date.`, `Chronos <version> is available. Download it from https://hufe.info/chronos/`, or `Update check failed: <message>`.
  - If `settings.checkForUpdates`, `setTimeout(() => void updateHost?.check({ manual: false }), 15_000)`.
  - In `createMainWindow`'s `onMsg`, before `tree.handle(msg)`: `if (updateHost?.handleWebviewMessage(msg)) return;`. On `did-finish-load`: `updateHost?.repost()`.
  - `menuActions()`: `checkForUpdates: () => void updateHost?.check({ manual: true })`, `toggleUpdateCheck: () => saveSettings({ checkForUpdates: !settings.checkForUpdates })`. `rebuildMenu()` state: `updateCheck: settings.checkForUpdates, updatesSupported: updateModeValue !== "off"`.
- [ ] **Step 3: README** — add an "Updates" subsection under "Building installers" / releasing: the mode table from the spec in two sentences, that updates only reach users once the draft release is published, and that macOS install needs signing plus a `zip` mac target.
- [ ] **Step 4: Verify** — `npm run typecheck` clean; `npm test` all green; `CHRONOS_DEV_MENU_DUMP=1 npm run dev -- --workspace <any workspace>` logs `Help(9)` (seven items plus two separators) and the app log shows no `[update]` line in dev (mode `off`).
- [ ] **Step 5: Commit** `feat(v2): check for updates via electron-updater (Windows/AppImage install, elsewhere notify)`

---

### Task 5: Renderer banner

**Files:**
- Modify: `src/renderer/components/chronos-app.ts`, `src/renderer/styles.css`
- Test: `test/e2e/boot.spec.ts`

**Interfaces:**
- Consumes: `UpdateStatus`, `update/status`, `update/download|install|openDownloadPage` from Task 2.
- Produces: state `update: UpdateStatus` (default `{ kind: "none" }`) and `updateDismissed: string | null`; `renderUpdateBanner()`; test snapshot field `update: this.update.kind`; `__test/invoke` action `updateStatus` with `payload: UpdateStatus` (sets `this.update`).

Banner rules: rendered right after the login banner when `update.kind !== "none"` and not (`kind === "available"` or `"ready"`) with `updateDismissed === version`. Markup `<div class="login-banner update-banner">` with `<span class="login-banner-text">` and buttons `class="login-banner-btn"` (primary) / `class="login-banner-btn is-secondary"` (✕ / Later). Copy per the spec table; percent as `${percent}%`.

- [ ] **Step 1: Write the failing e2e test** (after the Organize sources test):

```ts
test("update banner: available → dismiss; ready → restart posts update/install", async () => {
  await invoke("updateStatus", { kind: "available", version: "9.9.9", mode: "install" });
  await expect(page.locator(".update-banner")).toContainText("Chronos 9.9.9 is available.");
  await page.locator(".update-banner button", { hasText: "✕" }).click();
  await expect(page.locator(".update-banner")).toHaveCount(0);
  await invoke("updateStatus", { kind: "ready", version: "9.9.9" });
  await expect(page.locator(".update-banner")).toContainText("Chronos 9.9.9 is ready.");
  expect((await state()).update).toBe("ready");
});
```

(Use the suite's existing helpers for `__test/invoke` and the state snapshot; if the spec file names them differently, follow it.)

- [ ] **Step 2: Run** `npm run build && npx playwright test -g "update banner"` — expected: FAIL.
- [ ] **Step 3: Implement** state, the `update/status` case, the `__test/invoke` action, `renderUpdateBanner()`, and CSS: `.update-banner` reuses `.login-banner`; add `.login-banner-btn.is-secondary { background: transparent; color: var(--ch-fg); border: 1px solid var(--ch-border); }` (check the existing `--ch-border` name in `styles.css`). Button handlers post `update/download`, `update/install`, `update/openDownloadPage`; ✕ and Later set `updateDismissed = version`.
- [ ] **Step 4: Verify** — `npx tsc --noEmit -p tsconfig.renderer.json` clean; `npm run test:e2e` all green (9 tests).
- [ ] **Step 5: Commit** `feat(v2): update banner in the renderer`
