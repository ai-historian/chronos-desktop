// Renders resources/icon.png (1024px) into the hicolor icon set under resources/icons/
// (16x16.png … 1024x1024.png) that electron-builder's linux.icon points at.
// Run after editing the source icon: node scripts/render-icons.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(join(root, "agent", "package.json"))("sharp");
const src = join(root, "resources", "icon.png");
const dir = join(root, "resources", "icons");
mkdirSync(dir, { recursive: true });

for (const n of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await sharp(src).resize(n, n, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(dir, `${n}x${n}.png`));
  console.log(`${n}x${n}.png`);
}
