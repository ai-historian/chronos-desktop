# Auto-update — design

**Goal.** Chronos tells the user when a newer release exists and, where the installer
allows it, downloads and installs it. Users of the first release with this feature
(v0.3.1) never have to visit the download page again on Windows and AppImage.

**Source of truth.** The published GitHub releases of `ai-historian/chronos-desktop`.
electron-builder already uploads `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and
blockmaps there; `electron-updater` (same author, GitHub provider, no token needed for a
public repo) reads them. Draft releases are invisible to it, so an update reaches users
only once the draft is published.

**Modes, decided once at startup** (`updateMode` in `src/main/update-host.ts`):

| Situation | Mode | Behaviour |
|---|---|---|
| not packaged (`npm run dev`), or `CHRONOS_E2E=1` | `off` | never checks |
| Windows (NSIS) | `install` | check, download on request, install on quit or on "Restart to update" |
| Linux, running as AppImage (`APPIMAGE` env set) and its folder is writable | `install` | same |
| Linux AppImage in an unwritable folder (e.g. `/opt`, read-only mount) | `notify` | the update replaces the AppImage file, which would fail on every launch |
| Linux .deb | `notify` | check, then only offer the download page |
| macOS | `notify` | same, until the builds are Developer-ID signed (Squirrel.Mac refuses unsigned updates; a `zip` mac target is also needed then) |

**When it checks.** Once, 15 s after startup, if the setting *Check for updates
automatically* (default on, stored in the app's `settings.json`) is enabled; and
whenever the user picks Help ▸ Check for updates…. A check never runs while another
check or a download is in progress.

**What the user sees** (banner in the main window, same style as the login banner):

| Status | Text | Buttons |
|---|---|---|
| available, `install` | **Chronos 0.4.0 is available.** | Download · ✕ |
| available, `notify` | **Chronos 0.4.0 is available.** Download it from the Chronos download page. | Open download page · ✕ |
| downloading | Downloading Chronos 0.4.0… 42% | — |
| ready | **Chronos 0.4.0 is ready.** It installs when you quit Chronos. | Restart to update · Later |

✕ and Later hide the banner for this stage and version until the next launch. The
dismissal is kept by main (`update/dismiss` → `UpdateHost`), and every `update/status`
carries `dismissed`, so a fresh renderer (another workspace, back through the welcome
window) keeps the banner hidden. A manual check clears the dismissal, so it brings the
banner back.

**Restart to update** is a normal quit: the renderer's unsaved-edits check can still
cancel it (that also cancels the install). Only once every window has closed
(`will-quit`) does main run the installer silently and relaunch
(`quitAndInstall(true, true)`). Without the click, the update installs when the user
quits (electron-updater's install-on-quit).

**A manual check always answers.** Nothing new: toast "Chronos 0.3.0 is up to date."
Update found: the banner (shown again even if dismissed). Update already downloaded: no
check, toast "Chronos 0.4.0 is ready. It installs when you quit Chronos." With no main
window open (welcome window), the answer is a dialog instead; for an available update it
offers "Open download page".

**Errors.** The full electron-updater message (it embeds stacks and HTTP headers) goes to
the log only; toasts and dialogs show a short text (`describeUpdateError`): "No update
information for this platform yet." (no `latest*.yml` for it), "No connection to the
update server." (DNS/connection errors), else the message's first line, at most 120
characters. A failed manual check ("Update check failed: …"), a failed download ("Update
download failed: …") and a failed install ("Update install failed: …", the update stays
ready) warn; a failed automatic check is only logged. Nothing is ever installed silently
while the app runs.

**AppImage file name.** The AppImage artifact is version-free (`Chronos.AppImage`), so an
in-place update keeps the file name and the user's launchers keep working; the `.deb`
keeps its versioned name.

**Download page.** `https://hufe.info/chronos/` (one constant, `DOWNLOAD_PAGE`).

**Out of scope.** Pre-releases, release notes in the banner, per-workspace settings,
update channels, macOS install (needs signing first).
