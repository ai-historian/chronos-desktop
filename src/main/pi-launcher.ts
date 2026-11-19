import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "./env-file";
import type { VendorPaths } from "./paths";

/** True when `path` exists and the current user may execute it. */
export function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

// Builds the argv/env for spawning the bundled pi in RPC mode. pi runs under
// Electron's own binary as plain Node (ELECTRON_RUN_AS_NODE), or under the bundled
// Node when vendor.nodeBin is executable. `env` holds only
// Chronos-specific vars; PiRpcSession merges process.env itself.

export interface PiLaunch {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

export function buildPiLaunch(opts: {
  vendor: VendorPaths;
  workspaceDir: string;
  userDataDir: string;
  httpPort: number;
  execPath: string;
}): PiLaunch {
  const args = [opts.vendor.piCli, "--mode", "rpc", "--extension", join(opts.vendor.agentDir, "dist", "extensions")];
  // Workspace skills need an explicit --skill: the .pi/settings.json bridge is
  // dropped in headless rpc mode (project settings are untrusted).
  const skillsDir = join(opts.workspaceDir, "skills");
  if (existsSync(skillsDir)) args.push("--skill", skillsDir);

  // A bundled real Node (packaged Linux) replaces Electron-as-Node when present.
  const useNode = !!opts.vendor.nodeBin && isExecutable(opts.vendor.nodeBin);
  const env: Record<string, string> = {
    // Workspace keys first so they can never override the launcher's own vars.
    ...readEnvFile(join(opts.workspaceDir, ".chronos", ".env")),
    ...(useNode ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    PI_CODING_AGENT_DIR: join(opts.userDataDir, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: join(opts.workspaceDir, "sessions"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    CHRONOS_HTTP_PORT: String(opts.httpPort),
  };
  // A workspace .env must not be able to switch a real Node into Electron-as-Node mode.
  if (useNode) delete env.ELECTRON_RUN_AS_NODE;
  return { bin: useNode ? opts.vendor.nodeBin! : opts.execPath, args, env };
}
