// Equivalence test for the source data-dir key: src/main/data-key.ts duplicates
// the trivial slug transform the agent uses to name a source's data/<key>/
// directory (the host bundle can't import the agent's ESM package — see the
// docblock there). That duplication is only safe as long as the two
// implementations agree, so this test runs BOTH sides on the same inputs and
// compares their output directly — no expected-value literal anywhere:
//   - the agent's real, compiled deriveRef/dataKeyForRef/refFromRelative from
//     agent/dist/tools/collection-context.js (`cd agent && npm run build`, the
//     same precondition as `npm run canary`)
//   - the host's deriveDataKeyFallback / discoverSources
// If the agent's derivation ever changes without a matching update to
// data-key.ts, this fails instead of the two silently drifting apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveDataKeyFallback, refFromRelative } from "../src/main/data-key";
import { discoverSources } from "../src/main/sources";

const agentModule = resolve(__dirname, "..", "agent", "dist", "tools", "collection-context.js");

interface AgentDataKeyApi {
  deriveRef(workspaceDir: string, sourcePath: string): string;
  dataKeyForRef(ref: string, sourcePath: string): string;
  refFromRelative(rel: string, pathSep?: string): string;
}

async function loadAgent(): Promise<AgentDataKeyApi> {
  assert.ok(existsSync(agentModule), `agent not built: ${agentModule} missing — run "cd agent && npm run build"`);
  // The agent is an ESM package; a dynamic import is the only way in from this CJS test.
  return (await import(pathToFileURL(agentModule).href)) as AgentDataKeyApi;
}

test("host data-key fallback matches the agent's derivation for flat, nested and out-of-tree sources", async () => {
  const agent = await loadAgent();
  const ws = mkdtempSync(join(tmpdir(), "chronos-datakey-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "chronos-datakey-ext-"));
  try {
    const cases = [
      join(ws, "sources", "Frankfurt_1864"),
      join(ws, "sources", "city", "Nested_1900"),
      join(ws, "sources", "region", "city", "Deep_1850"),
      join(ws, "sources", "a", "b", "c", "Frankfurt_1864"),
      join(elsewhere, "Imported_Archive_1900"),
    ];
    for (const sourceDir of cases) {
      const expected = agent.dataKeyForRef(agent.deriveRef(ws, sourceDir), sourceDir);
      assert.equal(deriveDataKeyFallback(ws, sourceDir), expected, sourceDir);
      assert.ok(!expected.includes(sep), `key carries a raw path separator: ${expected}`);
    }
    // The table must exercise both branches (slugged nested key, bare basename).
    assert.ok(deriveDataKeyFallback(ws, cases[1]).includes("--"));
    assert.ok(!deriveDataKeyFallback(ws, cases[0]).includes("--"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("discoverSources names a nested source exactly like the agent's ref", async () => {
  const agent = await loadAgent();
  const ws = mkdtempSync(join(tmpdir(), "chronos-datakey-disc-"));
  try {
    for (const rel of [join("city", "Nested_1900"), "Flat_1864"]) {
      mkdirSync(join(ws, "sources", rel, "png"), { recursive: true });
      writeFileSync(join(ws, "sources", rel, "png", "page_0001.png"), Buffer.alloc(8));
    }
    const found = discoverSources(join(ws, "sources"));
    assert.equal(found.length, 2);
    for (const s of found) {
      // The name is what /select-source sends verbatim and the agent matches against member.ref.
      assert.equal(s.name, agent.deriveRef(ws, s.path));
      assert.equal(deriveDataKeyFallback(ws, s.path), agent.dataKeyForRef(agent.deriveRef(ws, s.path), s.path));
    }
    assert.ok(found.some((s) => s.name === "city/Nested_1900"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("refFromRelative agrees with the agent on the win32 separator branch", async () => {
  const agent = await loadAgent();
  const cases: [string, string, string][] = [
    ["city\\Nested_1900", "\\", "city/Nested_1900"],
    ["a\\b\\c\\D_1900", "\\", "a/b/c/D_1900"],
    ["Flat_1864", "\\", "Flat_1864"],
    ["city/Nested_1900", "/", "city/Nested_1900"],
    // On POSIX a backslash is a legal filename character and must survive.
    ["city\\Nested_1900", "/", "city\\Nested_1900"],
  ];
  for (const [rel, pathSep, expected] of cases) {
    assert.equal(refFromRelative(rel, pathSep), agent.refFromRelative(rel, pathSep));
    assert.equal(refFromRelative(rel, pathSep), expected);
  }
  assert.equal(refFromRelative("city\\Nested_1900", "\\"), refFromRelative("city/Nested_1900", "/"));
});
