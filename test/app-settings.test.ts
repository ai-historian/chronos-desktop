import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppSettings, writeAppSettings } from "../src/main/app-settings";

const dir = () => mkdtempSync(join(tmpdir(), "chronos-as-"));

test("round trip", () => {
  const d = dir();
  writeAppSettings(d, { theme: "dark", checkForUpdates: true });
  assert.deepEqual(readAppSettings(d), { theme: "dark", checkForUpdates: true });
});

test("missing file gives defaults", () => {
  assert.deepEqual(readAppSettings(dir()), { theme: "system", checkForUpdates: true });
});

test("corrupt or invalid gives defaults", () => {
  const d = dir();
  writeFileSync(join(d, "settings.json"), "{nope");
  assert.deepEqual(readAppSettings(d), { theme: "system", checkForUpdates: true });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ theme: "purple" }));
  assert.deepEqual(readAppSettings(d), { theme: "system", checkForUpdates: true });
});

test("checkForUpdates round-trips and defaults to true", () => {
  const d = dir();
  writeAppSettings(d, { theme: "light", checkForUpdates: false });
  assert.deepEqual(readAppSettings(d), { theme: "light", checkForUpdates: false });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.deepEqual(readAppSettings(d), { theme: "dark", checkForUpdates: true });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ checkForUpdates: "no" }));
  assert.deepEqual(readAppSettings(d), { theme: "system", checkForUpdates: true });
});
