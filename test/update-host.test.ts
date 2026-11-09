import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_PAGE,
  UpdateHost,
  updateMode,
  type ManualResult,
  type UpdaterLike,
} from "../src/main/update-host";
import type { ExtToWebview } from "../src/shared/webview-protocol";

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  listeners = new Map<string, Array<(arg: any) => void>>();
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkResult: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  downloadResult: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  on(event: string, listener: (arg: any) => void) {
    const l = this.listeners.get(event) ?? [];
    l.push(listener);
    this.listeners.set(event, l);
    return this;
  }
  emit(event: string, arg?: unknown) {
    for (const l of this.listeners.get(event) ?? []) l(arg);
  }
  checkForUpdates() {
    this.checkCalls++;
    return new Promise<unknown>((resolve, reject) => {
      this.checkResult = { resolve: () => resolve(undefined), reject };
    });
  }
  downloadUpdate() {
    this.downloadCalls++;
    return new Promise<unknown>((resolve, reject) => {
      this.downloadResult = { resolve: () => resolve(undefined), reject };
    });
  }
  quitAndInstall() {
    this.installCalls++;
  }
}

function setup(mode: "install" | "notify" = "install") {
  const updater = new FakeUpdater();
  const posted: ExtToWebview[] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  const results: ManualResult[] = [];
  const host = new UpdateHost({
    updater,
    mode,
    currentVersion: "0.3.0",
    post: (m) => posted.push(m),
    openExternal: (u) => opened.push(u),
    log: (l) => logs.push(l),
    onManualResult: (r) => results.push(r),
  });
  return { updater, posted, logs, opened, results, host };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("updateMode table", () => {
  const env = {};
  assert.equal(updateMode({ platform: "win32", isPackaged: true, env }), "install");
  assert.equal(updateMode({ platform: "linux", isPackaged: true, env: { APPIMAGE: "/x/Chronos.AppImage" } }), "install");
  assert.equal(updateMode({ platform: "linux", isPackaged: true, env }), "notify");
  assert.equal(updateMode({ platform: "darwin", isPackaged: true, env }), "notify");
  assert.equal(updateMode({ platform: "win32", isPackaged: false, env }), "off");
  assert.equal(updateMode({ platform: "win32", isPackaged: true, env: { CHRONOS_E2E: "1" } }), "off");
});

test("constructor configures the updater", () => {
  const { updater } = setup();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test("available posts a banner status (install mode)", async () => {
  const { updater, posted, host } = setup("install");
  const p = host.check({ manual: false });
  updater.emit("update-available", { version: "0.4.0" });
  updater.checkResult!.resolve();
  await p;
  assert.deepEqual(posted[0], { type: "update/status", status: { kind: "available", version: "0.4.0", mode: "install" } });
  assert.deepEqual(host.status, { kind: "available", version: "0.4.0", mode: "install" });
});

test("manual check that finds nothing toasts and reports", async () => {
  const { updater, posted, results, host } = setup();
  const p = host.check({ manual: true });
  updater.emit("update-not-available", {});
  updater.checkResult!.resolve();
  await p;
  assert.deepEqual(posted, [{ type: "notify", level: "info", message: "Chronos 0.3.0 is up to date." }]);
  assert.deepEqual(results, [{ kind: "upToDate", version: "0.3.0" }]);
});

test("manual check that finds an update reports available", async () => {
  const { updater, results, host } = setup();
  const p = host.check({ manual: true });
  updater.emit("update-available", { version: "0.4.0" });
  updater.checkResult!.resolve();
  await p;
  assert.deepEqual(results, [{ kind: "available", version: "0.4.0" }]);
});

test("automatic check that finds nothing is silent", async () => {
  const { updater, posted, results, host } = setup();
  const p = host.check({ manual: false });
  updater.emit("update-not-available", {});
  updater.checkResult!.resolve();
  await p;
  assert.equal(posted.length, 0);
  assert.equal(results.length, 0);
});

test("automatic check error is logged only", async () => {
  const { updater, posted, logs, results, host } = setup();
  const p = host.check({ manual: false });
  updater.emit("error", new Error("boom"));
  updater.checkResult!.reject(new Error("boom"));
  await p;
  assert.ok(logs.some((l) => l.startsWith("[update] ") && l.includes("boom")));
  assert.equal(posted.length, 0);
  assert.equal(results.length, 0);
});

test("manual check error warns", async () => {
  const { updater, posted, results, host } = setup();
  const p = host.check({ manual: true });
  updater.emit("error", new Error("boom"));
  updater.checkResult!.reject(new Error("boom"));
  await p;
  assert.deepEqual(posted, [{ type: "notify", level: "warning", message: "Update check failed: boom" }]);
  assert.deepEqual(results, [{ kind: "error", message: "boom" }]);
});

async function toAvailable(s: ReturnType<typeof setup>) {
  const p = s.host.check({ manual: false });
  s.updater.emit("update-available", { version: "0.4.0" });
  s.updater.checkResult!.resolve();
  await p;
  s.posted.length = 0;
}

test("download: progress then ready", async () => {
  const s = setup();
  await toAvailable(s);
  s.host.download();
  s.updater.emit("download-progress", { percent: 41.6 });
  s.updater.emit("update-downloaded", { version: "0.4.0" });
  const statuses = s.posted.map((m) => (m as any).status);
  assert.deepEqual(statuses, [
    { kind: "downloading", version: "0.4.0", percent: 0 },
    { kind: "downloading", version: "0.4.0", percent: 42 },
    { kind: "ready", version: "0.4.0" },
  ]);
  assert.equal(s.updater.downloadCalls, 1);
});

test("download error returns to available and warns", async () => {
  const s = setup();
  await toAvailable(s);
  s.host.download();
  s.updater.emit("error", new Error("disk full"));
  s.updater.downloadResult!.reject(new Error("disk full"));
  await tick();
  assert.deepEqual(s.posted.slice(1), [
    { type: "update/status", status: { kind: "available", version: "0.4.0", mode: "install" } },
    { type: "notify", level: "warning", message: "Update download failed: disk full" },
  ]);
  assert.equal(s.posted.filter((m) => m.type === "notify").length, 1);
});

test("check is ignored while downloading", async () => {
  const s = setup();
  await toAvailable(s);
  s.host.download();
  await s.host.check({ manual: true });
  assert.equal(s.updater.checkCalls, 1);
});

test("check is ignored while another check is in progress", async () => {
  const s = setup();
  const p = s.host.check({ manual: false });
  await s.host.check({ manual: true });
  assert.equal(s.updater.checkCalls, 1);
  s.updater.emit("update-not-available", {});
  s.updater.checkResult!.resolve();
  await p;
});

test("notify mode: download is a no-op, openDownloadPage opens the page", async () => {
  const s = setup("notify");
  await toAvailable(s);
  s.host.download();
  assert.equal(s.updater.downloadCalls, 0);
  assert.equal(s.host.status.kind, "available");
  s.host.openDownloadPage();
  assert.deepEqual(s.opened, ["https://hufe.info/chronos/"]);
  assert.equal(DOWNLOAD_PAGE, "https://hufe.info/chronos/");
});

test("install only when ready", async () => {
  const s = setup();
  await toAvailable(s);
  s.host.install();
  assert.equal(s.updater.installCalls, 0);
  s.host.download();
  s.updater.emit("update-downloaded", { version: "0.4.0" });
  s.host.install();
  assert.equal(s.updater.installCalls, 1);
});

test("repost re-sends the current status", async () => {
  const s = setup();
  s.host.repost();
  assert.deepEqual(s.posted, [{ type: "update/status", status: { kind: "none" } }]);
  await toAvailable(s);
  s.host.repost();
  assert.deepEqual(s.posted, [{ type: "update/status", status: { kind: "available", version: "0.4.0", mode: "install" } }]);
});

test("handleWebviewMessage consumes only update messages", async () => {
  const s = setup();
  await toAvailable(s);
  assert.equal(s.host.handleWebviewMessage({ type: "update/download" }), true);
  assert.equal(s.updater.downloadCalls, 1);
  s.updater.emit("update-downloaded", { version: "0.4.0" });
  assert.equal(s.host.handleWebviewMessage({ type: "update/install" }), true);
  assert.equal(s.updater.installCalls, 1);
  assert.equal(s.host.handleWebviewMessage({ type: "update/openDownloadPage" }), true);
  assert.deepEqual(s.opened, [DOWNLOAD_PAGE]);
  assert.equal(s.host.handleWebviewMessage({ type: "login" } as any), false);
});

test("check is ignored once an update is ready", async () => {
  const s = setup();
  await toAvailable(s);
  s.host.download();
  s.updater.emit("update-downloaded", { version: "0.4.0" });
  await s.host.check({ manual: true });
  assert.equal(s.updater.checkCalls, 1);
  s.updater.emit("update-available", { version: "0.4.0" });
  assert.deepEqual(s.host.status, { kind: "ready", version: "0.4.0" });
});
