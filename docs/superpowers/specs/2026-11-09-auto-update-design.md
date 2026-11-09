# Auto-update — design

**Goal.** Chronos tells the user when a newer release exists and, where the installer
allows it, downloads and installs it. Users of the first release with this feature
(v0.4.0) never have to visit the download page again on Windows and AppImage.

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
| Linux, running as AppImage (`APPIMAGE` env set) | `install` | same |
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

✕ and Later hide the banner for this version until the next launch. A manual check that
finds nothing shows the toast "Chronos 0.3.0 is up to date." A failed manual check or a
failed download shows a warning toast; a failed automatic check is only logged. With no
main window open (welcome window), a manual check reports through a dialog instead.
Nothing is ever installed silently while the app runs.

**Download page.** `https://hufe.info/chronos/` (one constant, `DOWNLOAD_PAGE`).

**Out of scope.** Pre-releases, release notes in the banner, per-workspace settings,
update channels, macOS install (needs signing first).
