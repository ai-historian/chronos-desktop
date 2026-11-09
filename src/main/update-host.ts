/**
 * Auto-update core, free of any electron import: wraps an electron-updater-shaped
 * object and turns its events into `update/status` messages and toasts.
 */
import type { ExtToWebview, UpdateStatus, WebviewToExt } from "../shared/webview-protocol";

export const DOWNLOAD_PAGE = "https://hufe.info/chronos/";
export type UpdateMode = "install" | "notify" | "off";

/** install: download + restart in-app; notify: only announce; off: dev / e2e. */
export function updateMode(o: { platform: NodeJS.Platform; isPackaged: boolean; env: NodeJS.ProcessEnv }): UpdateMode {
  if (!o.isPackaged || o.env.CHRONOS_E2E === "1") return "off";
  if (o.platform === "win32") return "install";
  if (o.platform === "linux") return o.env.APPIMAGE ? "install" : "notify";
  return "notify";
}

/** The slice of electron-updater's AppUpdater that UpdateHost uses (tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
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
  onManualResult?: (r: ManualResult) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class UpdateHost {
  private o: UpdateHostOptions;
  private _status: UpdateStatus = { kind: "none" };
  private phase: "idle" | "checking" | "downloading" = "idle";
  private manual = false;

  constructor(o: UpdateHostOptions) {
    this.o = o;
    const u = o.updater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.on("update-available", (info) => {
      this.phase = "idle";
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
    if (this.phase !== "idle") return;
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

  install(): void {
    if (this._status.kind === "ready") this.o.updater.quitAndInstall();
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
    const message = messageOf(err);
    this.o.log(`[update] ${this.phase === "idle" ? "error" : `${this.phase} error`}: ${message}`);
    if (this.phase === "checking") {
      this.phase = "idle";
      if (this.manual) {
        this.o.post({ type: "notify", level: "warning", message: `Update check failed: ${message}` });
        this.o.onManualResult?.({ kind: "error", message });
      }
    } else if (this.phase === "downloading") {
      this.phase = "idle";
      if (this._status.kind === "downloading") {
        this.setStatus({ kind: "available", version: this._status.version, mode: this.o.mode });
      }
      this.o.post({ type: "notify", level: "warning", message: `Update download failed: ${message}` });
    }
  }
}
