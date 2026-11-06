# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Chronos Desktop** — the standalone Electron app of Chronos, an AI agent that helps
historians extract structured data from scanned primary sources. One installer per
platform; it bundles the `pi` agent runtime and the Chronos agent, so users install
nothing else. The VS Code extension lives in the separate `ai-historian/chronos` repo.

Two parts, built separately:

- repo root — the Electron app (`src/main` host process, `src/preload` bridge,
  `src/renderer` Lit UI, `src/shared` protocol types).
- `agent/` — the Chronos **pi-package** (tools, prompts, lifecycle hooks), compiled by
  `tsc` to `agent/dist/`. pi loads it from `dist/`, so rebuild after editing
  `agent/{extensions,tools,utils,http}/*.ts`; `agent/prompts/` is read live.

## Build / test / typecheck

```bash
cd agent && npm install && npm run build   # the agent; again after agent changes
npm install
npm run build                       # esbuild: main + preload + workers + renderer into out/
npm run dev -- --workspace <dir>    # build + launch into a workspace (dev pi from node_modules + agent/)
npm run typecheck                   # tsc, two tsconfigs (main/preload/shared/test and renderer)
npm test                            # node:test (test/*.test.ts, uses test/mock-pi.mjs); pretest builds
npm run test:e2e                    # Playwright _electron boot test (test/e2e/); needs a prior build
npm run canary                      # real pinned pi + agent/: RPC contract check after a pi bump
npm run dist                        # bundle-agent (fills vendor/) + build + electron-builder installers
```

esbuild does not type-check — always run `npm run typecheck`.

## Architecture

- **Two channels to the agent.** `AgentHost` (`src/main/agent-host.ts`) spawns
  `pi --mode rpc` (`src/main/rpc/pi-rpc-session.ts`, JSONL over stdio: prompts, state,
  models, sessions, `extension_ui_request`) and runs an HTTP server whose port is passed
  as `CHRONOS_HTTP_PORT`; the agent's `agent/http/http-client.ts` POSTs viewer events
  (show page, text) back. Chat streaming is RPC; the viewer is HTTP.
- **Main ↔ renderer** go through the preload bridge `window.chronos` on one IPC channel
  `chronos:msg`, carrying the typed `ExtToWebview`/`WebviewToExt` envelopes of
  `src/shared/webview-protocol.ts`. Renderer root is `chronos-app` (Lit, no React).
  `TreeHost` (`src/main/tree-host.ts`) serves the file tree and file open/save; every
  renderer-supplied path is realpath-validated inside the workspace, dot paths refused.
- **pi runtime.** `src/main/pi-launcher.ts` builds pi's argv/env: pi runs under Electron's
  binary with `ELECTRON_RUN_AS_NODE=1`, `PI_CODING_AGENT_DIR=<userData>/pi-agent` (never
  `~/.pi`), `PI_CODING_AGENT_SESSION_DIR=<workspace>/sessions`, the agent via
  `--extension agent/dist/extensions`, workspace skills via `--skill`. `src/main/paths.ts`
  picks vendored (packaged) or dev (node_modules pi + `agent/`) locations.
  `src/main/pi-settings.ts` seeds pi's default model once (Claude Opus 5.5 first) and
  remembers the user's picks.
- **The `vendor/` rule.** `vendor/` is gitignored and used only when packaged.
  `npm run dist` (via `scripts/bundle-agent.mjs`) vendors the pinned pi (`piVersion` in
  `package.json`) and the built `agent/` with production deps as `resources/vendor/`.
  Never edit `vendor/`.
- **pi protocol.** Pinned pi is 1.5.0. RPC `message_update` carries an
  `assistantMessageEvent` delta (`text_start`/`text_delta`/`text_end`, likewise thinking
  and tool calls, keyed by `contentIndex`); the client rebuilds the message between
  `message_start` and `message_end` (`src/renderer/stream-assembler.ts`). Run the canary
  after any pi bump.
- **Workspace images** are served over `chronos-file://local/<abs path>`
  (`src/main/protocol-handler.ts`), scoped to the open workspace; the renderer CSP allows
  images only from `chronos-file:` and `data:`.
- **Logs and windows.** `src/main/app-log.ts` writes `<app logs dir>/chronos.log`
  (previous run kept as `.1`): main's console plus pi's stderr, never pi's env. On macOS
  closing the last window keeps the app running. Every workspace open goes through
  `openOrOfferInit` in `src/main/main.ts`.
- **Tests.** Unit/integration in `test/*.test.ts`; `test/mock-pi.mjs` is a deterministic
  fake pi; the Electron e2e test is `test/e2e/boot.spec.ts` using the test-only env flags
  `CHRONOS_PI_LAUNCH_OVERRIDE` and `CHRONOS_E2E=1`.

## The agent (`agent/`)

`agent/extensions/index.ts` registers the tools, the `/select-source` and `/yolo`
commands and lifecycle hooks; tools in `agent/tools/` share a mutable `SourceContext`.
The system prompt is rebuilt every turn from `agent/prompts/system-prompt.md`. Key tools:
`task`/`task_batch` (vision-expert subagents per page), `list_pages`, `show_page`,
`show_text`, `change_source`. `agent/utils/pi-ai-compat.ts` shims `complete` across pi
versions. Expert models are any `provider/model-id` pi has auth for; none is hardcoded.

## Workspace layout (user-facing)

A Chronos workspace contains `sources/<name>/png/page_NNNN.png`, `data/`, `memory/`
(`MEMORY.MD` + per-source notes, injected into the system prompt), `skills/<name>/SKILL.md`,
`sessions/`, and `.chronos/` (`.env` with provider keys written by the login flow,
`settings.json` for the `yolo` flag, session sidecars).

## Releasing

Set `version` in `package.json`, push tag `v<version>`; `.github/workflows/release.yml`
creates one draft release and builds Linux (deb, AppImage), Windows (NSIS), and macOS
(arm64 and x64 dmg, built per architecture because `vendor/` holds single-arch native
binaries). Publish the draft by hand. See `README.md`.
