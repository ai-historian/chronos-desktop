import { join } from "node:path";

// Where the bundled pi runtime and the chronos agent live. Packaged builds ship
// them under resources/vendor/ (populated by scripts/bundle-agent.mjs); in dev
// we run the devDependency pi and the agent/ working copy in this repo.

export interface VendorPaths {
  piCli: string;
  agentDir: string;
  /** Bundled official Node (packaged Linux only); the agent runs under it instead of Electron. */
  nodeBin?: string;
}

export function resolveVendorPaths(opts: { isPackaged: boolean; resourcesPath: string; appRoot: string; platform?: NodeJS.Platform }): VendorPaths {
  if (opts.isPackaged) {
    const platform = opts.platform ?? process.platform;
    return {
      // vendor/pi is an npm install root (see scripts/bundle-agent.mjs), so pi and all
      // of its dependencies sit under vendor/pi/node_modules.
      piCli: join(opts.resourcesPath, "vendor", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      agentDir: join(opts.resourcesPath, "vendor", "chronos"),
      ...(platform === "linux" ? { nodeBin: join(opts.resourcesPath, "vendor", "node", "bin", "node") } : {}),
    };
  }
  return {
    piCli: join(opts.appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    agentDir: join(opts.appRoot, "agent"),
  };
}

/**
 * Packaged builds keep main.js inside app.asar, but worker scripts (and the
 * mupdf they import) are asarUnpack'ed to app.asar.unpacked/ — a Worker cannot
 * load from inside an asar. Maps `.../app.asar/...` to `.../app.asar.unpacked/...`;
 * any other path is returned unchanged.
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
}
