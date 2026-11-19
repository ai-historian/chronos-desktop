#!/usr/bin/env node
// Populates vendor/{pi,chronos} (gitignored) for packaging, and
// copies third-party licence texts into resources/licenses/.
//
// Chronos agent (the agent/ pi-package):
//   1. (agent/)          npm ci                         full install (typescript is a devDependency)
//   2. (agent/)          npm run build                  tsc -> dist/
//   3. copy dist, prompts, skills (if any), package.json, package-lock.json -> vendor/chronos/
//   4. (vendor/chronos)  npm ci --omit=dev --omit=peer  prod-only tree: dotenv, sharp(+@img/*), @sinclair/typebox
// The prod install runs in the vendor copy, so agent/node_modules is only
// ever a full dev tree and agent/ always stays buildable.
// The pi peers are not vendored with the agent: pi's extension loader aliases
// @earendil-works/pi-{ai,coding-agent} to its own bundled copies.
//
// pi itself: the installed devDependency node_modules/@earendil-works/pi-coding-agent
// is copied whole (package.json, dist/ incl. dist/bundle/chunks/, node_modules/)
// after asserting its version equals package.json "piVersion".
//
// Node runtime (Linux only): the official Node tarball for package.json "nodeRuntimeVersion"
// is downloaded to .cache/node/, verified against nodejs.org's SHASUMS256.txt and extracted
// to vendor/node/. Packaged Linux builds run pi with it instead of Electron's binary.
//
// Usage: node scripts/bundle-agent.mjs

import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentSrc = join(appRoot, "agent");
const vendor = join(appRoot, "vendor");
const licensesDir = join(appRoot, "resources", "licenses");
const piSrc = join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent");

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const run = (cmd, cwd) => {
  console.log(`$ (${cwd}) ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

// --- pi runtime ---------------------------------------------------------
const { piVersion, nodeRuntimeVersion } = readJson(join(appRoot, "package.json"));
const piPkg = readJson(join(piSrc, "package.json"));
if (piPkg.version !== piVersion) {
  throw new Error(`installed pi is ${piPkg.version}, package.json piVersion is ${piVersion} — run npm ci`);
}
// vendor/pi is a self-contained npm install root: npm hoists most of pi's
// dependencies (jiti, pi-ai, ...) next to it in the app's node_modules, so copying
// the pi package folder alone ships an incomplete runtime. Installing the pinned
// version into its own root puts every dependency under vendor/pi/node_modules,
// where Node resolution from cli.js finds them.
const piDest = join(vendor, "pi");
rmSync(piDest, { recursive: true, force: true });
mkdirSync(piDest, { recursive: true });
writeFileSync(
  join(piDest, "package.json"),
  JSON.stringify({ name: "chronos-pi-runtime", private: true, dependencies: { "@earendil-works/pi-coding-agent": piVersion } }, null, 2) + "\n",
);
run("npm install --omit=dev --no-audit --no-fund", piDest);
const piVendored = join(piDest, "node_modules", "@earendil-works", "pi-coding-agent");
if (readJson(join(piVendored, "package.json")).version !== piVersion) throw new Error("vendored pi version mismatch");
// .bin symlinks are useless in the installed app and may leak build paths.
rmSync(join(piDest, "node_modules", ".bin"), { recursive: true, force: true });
console.log(`vendored pi ${piVersion} -> ${piVendored}`);

// --- chronos agent ------------------------------------------------------
const agentDest = join(vendor, "chronos");
rmSync(agentDest, { recursive: true, force: true });
mkdirSync(agentDest, { recursive: true });
run("npm ci", agentSrc);
run("npm run build", agentSrc);
for (const entry of ["dist", "prompts", "skills", "package.json", "package-lock.json"]) {
  if (existsSync(join(agentSrc, entry))) cpSync(join(agentSrc, entry), join(agentDest, entry), { recursive: true });
}
run("npm ci --omit=dev --omit=peer", agentDest);
console.log(`vendored chronos agent -> ${agentDest}`);

// --- node runtime (Linux) -----------------------------------------------
// Electron's Linux binary is linked against the system GLib, and sharp's bundled libvips
// resolves its g_object_* calls to that copy instead of its own (assertion failure on
// GLib 2.80, crash on newer GLib). A plain Node binary links no GLib, so packaged Linux
// builds run pi with an official Node.

// Drift check (every platform): nodeRuntimeVersion must equal the Node inside the pinned
// Electron so the agent runs the same Node line packaged and in dev; bump it with Electron.
if (!nodeRuntimeVersion) throw new Error("package.json has no nodeRuntimeVersion");
const electronPath = createRequire(import.meta.url)("electron");
const electronNode = execFileSync(electronPath, ["-p", "process.versions.node"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
}).toString().trim();
if (electronNode !== nodeRuntimeVersion) {
  throw new Error(`package.json nodeRuntimeVersion is ${nodeRuntimeVersion} but the pinned Electron embeds Node ${electronNode}; set nodeRuntimeVersion to ${electronNode}`);
}

const nodeDest = join(vendor, "node");
rmSync(nodeDest, { recursive: true, force: true });
if (process.platform === "linux") {
  const nodeVersion = nodeRuntimeVersion;
  const nodeArch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!nodeArch) throw new Error(`unsupported architecture for the bundled node: ${process.arch}`);
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const stem = `node-v${nodeVersion}-linux-${nodeArch}`;
  const tarName = `${stem}.tar.xz`;
  const cacheDir = join(appRoot, ".cache", "node");
  const tarPath = join(cacheDir, tarName);
  const sidecar = `${tarPath}.sha256`;
  mkdirSync(cacheDir, { recursive: true });

  const download = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const fetchExpected = async () => {
    const sums = (await download(`${base}/SHASUMS256.txt`)).toString("utf-8");
    const e = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === tarName)?.[0];
    if (!e) throw new Error(`no SHA-256 for ${tarName} in ${base}/SHASUMS256.txt`);
    return e;
  };
  // A file failing verification is deleted so the next run starts clean.
  const verify = (path, expected) => {
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) {
      rmSync(path, { force: true });
      throw new Error(`SHA-256 mismatch for ${tarName}: expected ${expected}, got ${actual} (removed the file)`);
    }
  };
  if (existsSync(tarPath)) {
    // Warm cache: verify against the digest recorded at download time (offline-capable);
    // without the sidecar, fall back to nodejs.org's SHASUMS256.txt.
    const expected = existsSync(sidecar) ? readFileSync(sidecar, "utf-8").trim() : await fetchExpected();
    verify(tarPath, expected);
  } else {
    const expected = await fetchExpected();
    console.log(`downloading ${base}/${tarName}`);
    const partial = `${tarPath}.partial`;
    writeFileSync(partial, await download(`${base}/${tarName}`));
    verify(partial, expected);
    renameSync(partial, tarPath);
    writeFileSync(sidecar, expected + "\n");
  }

  mkdirSync(nodeDest, { recursive: true });
  try {
    execFileSync("tar", ["-xJf", tarPath, "--strip-components=1", "-C", nodeDest, `${stem}/bin/node`, `${stem}/LICENSE`], { stdio: "inherit" });
    const nodeBin = join(nodeDest, "bin", "node");
    chmodSync(nodeBin, 0o755);
    const got = execFileSync(nodeBin, ["--version"]).toString().trim();
    if (got !== `v${nodeVersion}`) throw new Error(`vendored node reports ${got}, expected v${nodeVersion}`);
  } catch (err) {
    rmSync(nodeDest, { recursive: true, force: true });
    throw err;
  }
  console.log(`vendored node v${nodeVersion} (linux-${nodeArch}) -> vendor/node/bin/node`);
}

// --- licences -----------------------------------------------------------
mkdirSync(licensesDir, { recursive: true });
const copyLicense = (from, name) => {
  if (!existsSync(from)) throw new Error(`licence not found: ${from}`);
  cpSync(from, join(licensesDir, `${name}.txt`));
};

// pi's npm tarball ships no LICENSE file; fall back to the MIT text with the
// copyright holder from its package.json.
const piLicense = join(piVendored, "LICENSE");
if (existsSync(piLicense)) {
  copyLicense(piLicense, "pi-coding-agent");
} else {
  if (piPkg.license !== "MIT") throw new Error(`pi licence is ${piPkg.license}, expected MIT`);
  const header = `${piPkg.name} ${piPkg.version} — MIT per package.json; upstream: https://github.com/earendil-works/pi\n\n`;
  writeFileSync(join(licensesDir, "pi-coding-agent.txt"), header + mitText(piPkg.author));
}

const agentModules = join(agentDest, "node_modules");
copyLicense(join(agentModules, "sharp", "LICENSE"), "sharp");
// libvips (LGPL-3.0-or-later) comes as a separate @img/sharp-libvips-<platform>
// prebuild on Linux/macOS, while on Windows the DLLs ship inside
// @img/sharp-win32-<arch> itself (licensed "Apache-2.0 AND LGPL-3.0-or-later").
const imgPkgs = readdirSync(join(agentModules, "@img"));
const libvips = imgPkgs.find((d) => d.startsWith("sharp-libvips-")) ?? imgPkgs.find((d) => d.startsWith("sharp-win32-"));
if (!libvips) throw new Error(`no @img/sharp-libvips-* or @img/sharp-win32-* prebuild in vendored agent (found: ${imgPkgs.join(", ") || "none"})`);
// The prebuilds ship no LGPL text. The full LGPL-3.0 and GPL-3.0 texts are
// committed statically in resources/licenses/; the prebuild's README licence
// table (and its LICENSE file, when present) are kept as supplementary notices.
for (const name of ["LGPL-3.0.txt", "GPL-3.0.txt"]) {
  if (!existsSync(join(licensesDir, name))) throw new Error(`missing static licence text: resources/licenses/${name}`);
}
copyLicense(join(agentModules, "@img", libvips, "README.md"), "sharp-libvips-NOTICE");
if (existsSync(join(agentModules, "@img", libvips, "LICENSE"))) copyLicense(join(agentModules, "@img", libvips, "LICENSE"), "sharp-prebuild-LICENSE");
copyLicense(join(appRoot, "node_modules", "mupdf", "LICENSE"), "mupdf");
if (process.platform === "linux") {
  copyLicense(join(nodeDest, "LICENSE"), "node");
} else {
  // node.txt is tracked but only meaningful for the Linux-bundled Node: drop it from
  // non-Linux bundles. Note: git will show it as deleted on a macOS/Windows build machine.
  rmSync(join(licensesDir, "node.txt"), { force: true });
}
console.log(`licences -> ${licensesDir}`);

function mitText(holder) {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}
