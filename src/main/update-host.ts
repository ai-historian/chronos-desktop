/**
 * Auto-update core, free of any electron import: wraps an electron-updater-shaped
 * object and turns its events into `update/status` messages and toasts.
 */
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { ExtToWebview, UpdateStatus, WebviewToExt } from "../shared/webview-protocol";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const DOWNLOAD_PAGE = "https://hufe.info/chronos/";
export type UpdateMode = "install" | "notify" | "off";

const canWrite = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * install: download + restart in-app; notify: only announce; off: dev / e2e.
 * An AppImage installs only when its folder is writable (the update replaces the file).
 */
export function updateMode(o: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  isWritable?: (dir: string) => boolean;
}): UpdateMode {
  if (!o.isPackaged || o.env.CHRONOS_E2E === "1") return "off";
  if (o.platform === "win32") return "install";
  if (o.platform === "linux") {
    if (!o.env.APPIMAGE) return "notify";
    return (o.isWritable ?? canWrite)(dirname(o.env.APPIMAGE)) ? "install" : "notify";
  }
  return "notify";
}

const NO_UPDATE_INFO = new Set(["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"]);
const NO_CONNECTION = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);

/** A short, user-facing text for an electron-updater error (its messages embed stacks and headers). */
export function describeUpdateError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = messageOf(err);
  if (typeof code === "string" && NO_UPDATE_INFO.has(code)) return "No update information for this platform yet.";
  if ((typeof code === "string" && NO_CONNECTION.has(code)) || message.startsWith("net::ERR_")) {
    return "No connection to the update server.";
  }
  const first = message.split("\n", 1)[0].trim();
  return first.length > 120 ? first.slice(0, 119) + "…" : first;
}

/** The slice of electron-updater's AppUpdater that UpdateHost uses (tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error", listener: (arg: any) => void): unknown;
}

export type ManualResult =
  | { kind: "upToDate"; version: string }
  | { kind: "available"; version: string }
  | { kind: "error"; message: string };

export interface UpdateHostOptions {
  updater: UpdaterLike;
  mode: "install" | "notify";
  currentVersion: string;
  post: (msg: ExtToWebview) => void;
  openExternal: (url: string) => void;
  log: (line: string) => void;
  /** Start a normal app quit (main: `app.quit()`); the install runs from finishInstall(). */
  requestQuit: () => void;
  onManualResult?: (r: ManualResult) => void;
}

export class UpdateHost {
  private o: UpdateHostOptions;
  private _status: UpdateStatus = { kind: "none" };
  private phase: "idle" | "checking" | "downloading" = "idle";
  private manual = false;
  /** "Restart to update" was clicked; install once every window has closed. */
  private installRequested = false;

  constructor(o: UpdateHostOptions) {
    this.o = o;
    const u = o.updater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.on("update-available", (info) => {
      this.phase = "idle";
      if (this._status.kind === "ready" || this._status.kind === "downloading") return;
      this.setStatus({ kind: "available", version: String(info?.version), mode: o.mode });
      if (this.manual) o.onManualResult?.({ kind: "available", version: String(info?.version) });
    });
    u.on("update-not-available", () => {
      this.phase = "idle";
      if (this.manual) {
        o.post({ type: "notify", level: "info", message: `Chronos ${o.currentVersion} is up to date.` });
        o.onManualResult?.({ kind: "upToDate", version: o.currentVersion });
      }
    });
    u.on("download-progress", (p) => {
      if (this._status.kind === "downloading" || this._status.kind === "available") {
        this.setStatus({ kind: "downloading", version: this._status.version, percent: Math.round(p?.percent ?? 0) });
      }
    });
    u.on("update-downloaded", () => {
      if (this._status.kind === "downloading" || this._status.kind === "available") {
        this.phase = "idle";
        this.setStatus({ kind: "ready", version: this._status.version });
      }
    });
    u.on("error", (err) => this.onError(err));
  }

  get status(): UpdateStatus {
    return this._status;
  }

  async check(o: { manual: boolean }): Promise<void> {
    if (this.phase !== "idle" || this._status.kind === "ready") return;
    this.phase = "checking";
    this.manual = o.manual;
    try {
      await this.o.updater.checkForUpdates();
    } catch {
      // the `error` event already reported it
    }
    if (this.phase === "checking") this.phase = "idle";
  }

  download(): void {
    if (this._status.kind !== "available" || this.o.mode !== "install" || this.phase !== "idle") return;
    this.phase = "downloading";
    this.setStatus({ kind: "downloading", version: this._status.version, percent: 0 });
    this.o.updater.downloadUpdate().catch(() => {
      // the `error` event already reported it
    });
  }

  /**
   * "Restart to update": a normal quit first, so unsaved edits can still veto it; the
   * installer runs only from finishInstall() once every window has closed.
   */
  install(): void {
    if (this._status.kind !== "ready") return;
    this.installRequested = true;
    this.o.requestQuit();
  }

  /** The quit was prevented (unsaved edits): forget the pending install. */
  cancelInstall(): void {
    this.installRequested = false;
  }

  /** Main calls this from `will-quit` (every window has closed): run a requested install. */
  finishInstall(): void {
    if (!this.installRequested) return;
    this.installRequested = false;
    this.o.updater.quitAndInstall(true, true);
  }

  openDownloadPage(): void {
    this.o.openExternal(DOWNLOAD_PAGE);
  }

  repost(): void {
    this.o.post({ type: "update/status", status: this._status });
  }

  handleWebviewMessage(msg: WebviewToExt): boolean {
    switch (msg.type) {
      case "update/download":
        this.download();
        return true;
      case "update/install":
        this.install();
        return true;
      case "update/openDownloadPage":
        this.openDownloadPage();
        return true;
      default:
        return false;
    }
  }

  private setStatus(s: UpdateStatus): void {
    this._status = s;
    this.repost();
  }

  private onError(err: unknown): void {
    this.o.log(`[update] ${this.phase === "idle" ? "error" : `${this.phase} error`}: ${messageOf(err)}`);
    const short = describeUpdateError(err);
    if (this.phase === "checking") {
      this.phase = "idle";
      if (this.manual) {
        this.o.post({ type: "notify", level: "warning", message: `Update check failed: ${short}` });
        this.o.onManualResult?.({ kind: "error", message: short });
      }
    } else if (this.phase === "downloading") {
      this.phase = "idle";
      if (this._status.kind === "downloading") {
        this.setStatus({ kind: "available", version: this._status.version, mode: this.o.mode });
      }
      this.o.post({ type: "notify", level: "warning", message: `Update download failed: ${short}` });
    } else if (this._status.kind === "ready") {
      // The installer failed (e.g. AppImage folder not writable); the download stays valid.
      this.installRequested = false;
      this.o.post({ type: "notify", level: "warning", message: `Update install failed: ${short}` });
    }
  }
}
