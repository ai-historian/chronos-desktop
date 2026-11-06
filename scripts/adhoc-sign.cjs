// electron-builder afterPack hook: ad-hoc sign the macOS app when no signing
// identity is available. Without any signature, Apple Silicon refuses to launch
// the app at all ("Chronos is damaged"); with an ad-hoc signature Gatekeeper only
// asks the user to allow it once (System Settings -> Privacy & Security -> Open
// Anyway). Real Developer ID signing (CSC_LINK) takes precedence: electron-builder
// signs in that case and this hook does nothing.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing configured
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app} (no Developer ID identity available)`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
