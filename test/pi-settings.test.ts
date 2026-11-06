import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREFERRED_DEFAULT_MODELS,
  chooseDefaultModel,
  ensurePiDefaultModel,
  readPiSettings,
  rememberModelChoice,
  writePiSettings,
} from "../src/main/pi-settings";

const dir = () => mkdtempSync(join(tmpdir(), "chronos-pis-"));
const anthropic = [
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-fable-5-1" },
];

test("preferred list starts with Opus 5.5", () => {
  assert.equal(PREFERRED_DEFAULT_MODELS[0], "anthropic/claude-opus-5-5");
});

test("chooseDefaultModel picks the first preferred model that is available", () => {
  assert.deepEqual(chooseDefaultModel(anthropic), { provider: "anthropic", id: "claude-opus-5-5" });
  assert.deepEqual(chooseDefaultModel([{ provider: "google", id: "gemini-pro-latest" }]), {
    provider: "google",
    id: "gemini-pro-latest",
  });
  assert.equal(chooseDefaultModel([{ provider: "anthropic", id: "claude-opus-4-8" }]), undefined);
  assert.equal(chooseDefaultModel([]), undefined);
});

test("ensurePiDefaultModel seeds settings.json once and returns the choice", () => {
  const d = dir();
  assert.deepEqual(ensurePiDefaultModel(d, anthropic), { provider: "anthropic", id: "claude-opus-5-5" });
  const j = JSON.parse(readFileSync(join(d, "settings.json"), "utf-8"));
  assert.equal(j.defaultProvider, "anthropic");
  assert.equal(j.defaultModel, "claude-opus-5-5");
  // A stored default is never overridden, even when a "better" one is available.
  assert.equal(ensurePiDefaultModel(d, anthropic), undefined);
});

test("ensurePiDefaultModel respects a user-set default and preserves other keys", () => {
  const d = dir();
  writeFileSync(join(d, "settings.json"), JSON.stringify({ defaultProvider: "google", defaultModel: "gemini-pro-latest", theme: "dark" }));
  assert.equal(ensurePiDefaultModel(d, anthropic), undefined);
  rememberModelChoice(d, { provider: "anthropic", id: "claude-fable-5-1" });
  const j = readPiSettings(d);
  assert.equal(j.defaultModel, "claude-fable-5-1");
  assert.equal(j.defaultProvider, "anthropic");
  assert.equal(j.theme, "dark");
});

test("writePiSettings merges and survives a corrupt file", () => {
  const d = dir();
  writeFileSync(join(d, "settings.json"), "{not json");
  assert.deepEqual(readPiSettings(d), {});
  writePiSettings(d, { defaultModel: "x" });
  assert.equal(readPiSettings(d).defaultModel, "x");
});
