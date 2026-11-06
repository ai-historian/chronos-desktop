# Organize Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Organize sources" button in the header opens a modal grid (sources × collections, checkboxes) that creates, renames, deletes and fills collections, written to `collections/<id>.json` on Save.

**Architecture:** Shared types and the pure helpers (id slugging, snapshot→batch diff) live in `src/shared/collection-edit.ts` so renderer and host agree. The host gets a pure-Node manifest editor (`src/main/collection-edit.ts`: read a snapshot, apply a validated batch by read-modify-write) wired into `AgentHost` through two new message pairs; after a successful apply it refreshes the header picker and re-selects the agent's active collection with one `/select-collection` prompt. The renderer gets a Lit dialog (`organize-dialog.ts`) that holds a desired end state and sends the diff on Save.

**Tech Stack:** TypeScript, Electron main (plain Node modules, no Electron imports in the editor), Lit (light DOM), esbuild, node:test via tsx, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-06-organize-sources-design.md`

## Global Constraints

- Never import Electron or the agent package from `src/main/collection-edit.ts` or `src/shared/*` (unit tests run under plain Node; the host bundle cannot load the agent's ESM).
- Ref derivation must reuse `deriveRef`/`refFromRelative` from `src/main/data-key.ts`; never reimplement the slug.
- Every manifest write is read-modify-write of the existing JSON and atomic (`<id>.json.tmp` then `renameSync`). `description`, per-member `meta` and explicit `ref` fields survive untouched.
- Collection ids match `^[a-z0-9][a-z0-9_-]*$`; new ids are slugged from the name, empty slug → `collection`, collisions get `-2`, `-3`, … (collision = any existing `collections/<id>.json`, parseable or not).
- Rename changes `name` only. Delete unlinks `collections/<id>.json` only.
- An op that would leave a collection with zero members is a validation error; validation errors apply nothing.
- `collections/apply` while `isStreaming` is refused with `{ ok: false, error: "The agent is mid-answer; try again when it finishes.", applied: 0 }`.
- Commit author: Lorenz Hufe <lorenz.hufe@posteo.de>; no Co-Authored-By trailers.
- Verification for every task: `npm run typecheck && npm test` (and `npm run build && npm run test:e2e` where the task says so).

## Review Focus

1. A nested source `sources/wills/box-3` must appear as one row with path `sources/wills/box-3` and ref `wills/box-3`, and be written back with that relative path. (Task 2)
2. A manifest member with a bare relative path not under `sources/` (e.g. `{ "path": "TestSource" }`, which the existing tests write) must appear as an out-of-tree row with `pageCount 0` and survive a Save with its path verbatim, not be dropped or rewritten. (Task 2)
3. A name that slugs to nothing (`"???"`) gets id `collection`; a name whose slug matches an unparseable `collections/zz-broken.json` gets `-2`. (Task 1 + Task 2 validation)
4. Save while the agent is not running must still write the manifests and reply `ok: true` without sending a prompt. (Task 3)
5. A manifest edited on disk after the snapshot was taken (a `description` added by hand) must keep that description after a `setMembers` Save. (Task 2)

---

### Task 1: Shared types, id slugging and the snapshot diff

**Files:**
- Create: `src/shared/collection-edit.ts`
- Test: `test/collection-edit-shared.test.ts`

**Interfaces:**
- Produces (all exported from `src/shared/collection-edit.ts`):
  - `interface SourceRow { path: string; ref: string; pageCount: number; outOfTree: boolean }`
  - `interface MemberRef { path: string; ref?: string }`
  - `interface CollectionSnapshot { sources: SourceRow[]; collections: DesiredCollection[]; takenIds: string[] }` — `takenIds` = every `collections/*.json` stem, parseable or not, so the renderer slugs new ids against files it cannot otherwise see
  - `interface DesiredCollection { id: string; name: string; members: MemberRef[] }`
  - `type CollectionOp = { op: "create"; id; name; members } | { op: "rename"; id; name } | { op: "delete"; id } | { op: "setMembers"; id; members }` (types as in the spec)
  - `interface CollectionBatch { ops: CollectionOp[] }`
  - `type CollectionApplyResult = { ok: true; warning?: string } | { ok: false; error: string; applied: number }`
  - `const COLLECTION_ID_RE = /^[a-z0-9][a-z0-9_-]*$/`
  - `function slugifyCollectionId(name: string, taken: Iterable<string>): string`
  - `function sameMembers(a: MemberRef[], b: MemberRef[]): boolean` — order-insensitive, compares `path` and `ref`
  - `function diffCollections(before: DesiredCollection[], after: DesiredCollection[]): CollectionBatch` — ops ordered: every `delete`, then every `create`, then `rename`, then `setMembers`; an id in both lists yields a `rename` only if `name` differs and a `setMembers` only if `!sameMembers`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/collection-edit-shared.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyCollectionId, diffCollections, sameMembers, COLLECTION_ID_RE } from "../src/shared/collection-edit";

test("slugifyCollectionId lower-cases, collapses runs, trims, and suffixes on collision", () => {
  assert.equal(slugifyCollectionId("Frankfurt Directories!", []), "frankfurt-directories");
  assert.equal(slugifyCollectionId("  --Parish 1840s--  ", []), "parish-1840s");
  assert.equal(slugifyCollectionId("???", []), "collection");
  assert.equal(slugifyCollectionId("Parish", ["parish"]), "parish-2");
  assert.equal(slugifyCollectionId("Parish", ["parish", "parish-2"]), "parish-3");
  assert.match(slugifyCollectionId("ünïcödé", []), COLLECTION_ID_RE);
});

test("sameMembers ignores order and compares ref", () => {
  assert.ok(sameMembers([{ path: "sources/a" }, { path: "sources/b" }], [{ path: "sources/b" }, { path: "sources/a" }]));
  assert.ok(!sameMembers([{ path: "sources/a", ref: "A" }], [{ path: "sources/a" }]));
  assert.ok(!sameMembers([{ path: "sources/a" }], [{ path: "sources/a" }, { path: "sources/b" }]));
});

test("diffCollections emits delete, create, rename, setMembers in that order and nothing for unchanged", () => {
  const before = [
    { id: "gone", name: "Gone", members: [{ path: "sources/a" }] },
    { id: "same", name: "Same", members: [{ path: "sources/a" }] },
    { id: "renamed", name: "Old", members: [{ path: "sources/a" }] },
    { id: "refilled", name: "Refilled", members: [{ path: "sources/a" }] },
  ];
  const after = [
    { id: "same", name: "Same", members: [{ path: "sources/a" }] },
    { id: "renamed", name: "New", members: [{ path: "sources/a" }] },
    { id: "refilled", name: "Refilled", members: [{ path: "sources/a" }, { path: "sources/b" }] },
    { id: "fresh", name: "Fresh", members: [{ path: "sources/b" }] },
  ];
  assert.deepEqual(diffCollections(before, after), {
    ops: [
      { op: "delete", id: "gone" },
      { op: "create", id: "fresh", name: "Fresh", members: [{ path: "sources/b" }] },
      { op: "rename", id: "renamed", name: "New" },
      { op: "setMembers", id: "refilled", members: [{ path: "sources/a" }, { path: "sources/b" }] },
    ],
  });
  assert.deepEqual(diffCollections(after, after), { ops: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/collection-edit-shared.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/shared/collection-edit.ts`**

Slug: NFKD-normalise, lower-case, replace every run of characters outside `[a-z0-9_-]` with `-`, trim `-` from both ends; empty → `collection`; while the candidate is in `taken`, try `<base>-2`, `<base>-3`, …

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/collection-edit-shared.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/collection-edit.ts test/collection-edit-shared.test.ts
git commit -m "feat: shared collection-edit types, id slugging and snapshot diff"
```

---

### Task 2: Host manifest editor — `readSnapshot` and `applyBatch`

**Files:**
- Create: `src/main/collection-edit.ts`
- Test: `test/collection-edit.test.ts`
- Reference (read only): `src/main/sources.ts` (`discoverSources`, `countPages`), `src/main/data-key.ts` (`deriveRef`, `refFromRelative`), `agent/utils/collection-manifest.ts` (manifest shape).

**Interfaces:**
- Consumes: Task 1 types.
- Produces (exported from `src/main/collection-edit.ts`):
  - `function readSnapshot(workspaceDir: string): CollectionSnapshot`
  - `function applyBatch(workspaceDir: string, batch: CollectionBatch): CollectionApplyResult`
  - `function normalizeMemberPath(workspaceDir: string, manifestPath: string): { rowPath: string; abs: string; outOfTree: boolean }` — `abs = isAbsolute(p) ? p : join(ws, p)`; if `abs` is under `join(ws, "sources")` then `rowPath = "sources/" + refFromRelative(relative(join(ws,"sources"), abs))`, `outOfTree=false`; else `rowPath = abs`, `outOfTree=true`.

Behaviour pinned by the spec:
- Snapshot `sources` = `discoverSources` rows (`path: "sources/<ref>"`, `ref`, `pageCount` via `countPages`, `outOfTree:false`) plus one row per distinct out-of-tree member path across all manifests (`ref` = explicit ref or `deriveRef(ws, abs)`, `pageCount` via `countPages(abs)`, `outOfTree:true`), sorted by `ref`.
- Snapshot `takenIds` = every `*.json` stem in `collections/` (sorted). Snapshot `collections` = every parseable `collections/*.json`, sorted by display name; each member → `{ path: rowPath, ref? }` where `ref` is set only when the manifest's explicit `ref` differs from the derived ref. Members with no `png/` are still listed. Unparseable manifests are skipped.
- `applyBatch`: validate every op first — id matches `COLLECTION_ID_RE`; `create` id must not exist on disk (any file `collections/<id>.json`); `rename`/`delete`/`setMembers` id must exist and parse; `rename` name non-empty after trim; every member `path` must equal a snapshot row path; `create`/`setMembers` members non-empty. On any failure return `{ ok:false, error, applied:0 }` naming the op (`"create 'x': …"`). Then apply in order; on a thrown write error return `{ ok:false, error: "<op> '<id>': <message>", applied: <ops completed> }`.
- Writing: load existing JSON (or `{}` for create), set `name` on create/rename, set `members` on create/setMembers — each `{ ref?, path, meta? }` where `path` is the row path (relative `sources/…` or absolute), `ref` written only if `MemberRef.ref` is set, `meta` copied from the existing member with the same resolved absolute path. Write `JSON.stringify(m, null, 2) + "\n"` to `<id>.json.tmp`, then `renameSync` over `<id>.json`. `mkdirSync(collections, { recursive: true })` before the first write.

- [ ] **Step 1: Write the failing tests**

```ts
// test/collection-edit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, applyBatch } from "../src/main/collection-edit";

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "chronos-coll-edit-"));
  for (const s of ["Frankfurt_1858", "wills/box-3"]) {
    mkdirSync(join(dir, "sources", s, "png"), { recursive: true });
    writeFileSync(join(dir, "sources", s, "png", "page_0001.png"), "");
  }
  mkdirSync(join(dir, "collections"), { recursive: true });
  return dir;
}
const manifest = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, "collections", `${id}.json`), "utf-8"));

test("readSnapshot lists discovered sources (nested as one row) and parseable manifests", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "Frankfurt", description: "d", members: [{ path: "sources/Frankfurt_1858", meta: { year: 1858 } }] }));
  writeFileSync(join(dir, "collections", "zz-broken.json"), "{ nope");
  const snap = readSnapshot(dir);
  assert.deepEqual(snap.sources, [
    { path: "sources/Frankfurt_1858", ref: "Frankfurt_1858", pageCount: 1, outOfTree: false },
    { path: "sources/wills/box-3", ref: "wills/box-3", pageCount: 1, outOfTree: false },
  ]);
  assert.deepEqual(snap.collections, [{ id: "ffm", name: "Frankfurt", members: [{ path: "sources/Frankfurt_1858" }] }]);
  assert.deepEqual(snap.takenIds, ["ffm", "zz-broken"]);
  rmSync(dir, { recursive: true, force: true });
});

test("readSnapshot surfaces out-of-tree and bare-relative members as rows and keeps custom refs", () => {
  const dir = ws();
  const outside = mkdtempSync(join(tmpdir(), "chronos-outside-"));
  mkdirSync(join(outside, "png"));
  writeFileSync(join(outside, "png", "page_0001.png"), "");
  writeFileSync(join(dir, "collections", "mix.json"), JSON.stringify({ members: [
    { path: outside }, { path: "TestSource" }, { ref: "FFM", path: "sources/Frankfurt_1858" },
  ] }));
  const snap = readSnapshot(dir);
  assert.ok(snap.sources.some((s) => s.path === outside && s.outOfTree && s.pageCount === 1));
  assert.ok(snap.sources.some((s) => s.path === join(dir, "TestSource") && s.outOfTree && s.pageCount === 0));
  assert.equal(snap.sources.filter((s) => s.path === "sources/Frankfurt_1858").length, 1);
  assert.deepEqual(snap.collections[0].members, [
    { path: outside }, { path: join(dir, "TestSource") }, { path: "sources/Frankfurt_1858", ref: "FFM" },
  ]);
  rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

test("applyBatch create/rename/setMembers/delete write the expected JSON and preserve description and meta", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "Frankfurt", description: "keep me", members: [{ path: "sources/Frankfurt_1858", meta: { year: 1858 } }] }));
  const r = applyBatch(dir, { ops: [
    { op: "create", id: "wills", name: "Wills", members: [{ path: "sources/wills/box-3" }] },
    { op: "rename", id: "ffm", name: "Frankfurt renamed" },
    { op: "setMembers", id: "ffm", members: [{ path: "sources/wills/box-3" }, { path: "sources/Frankfurt_1858", ref: "FFM" }] },
  ] });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(manifest(dir, "wills"), { name: "Wills", members: [{ path: "sources/wills/box-3" }] });
  assert.deepEqual(manifest(dir, "ffm"), { name: "Frankfurt renamed", description: "keep me", members: [
    { path: "sources/wills/box-3" }, { ref: "FFM", path: "sources/Frankfurt_1858", meta: { year: 1858 } },
  ] });
  assert.deepEqual(applyBatch(dir, { ops: [{ op: "delete", id: "wills" }] }), { ok: true });
  assert.ok(!existsSync(join(dir, "collections", "wills.json")));
  assert.ok(!readdirSync(join(dir, "collections")).some((f) => f.endsWith(".tmp")));
  rmSync(dir, { recursive: true, force: true });
});

test("applyBatch keeps a description added on disk after the snapshot", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "F", members: [{ path: "sources/Frankfurt_1858" }] }));
  readSnapshot(dir);
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "F", description: "late", members: [{ path: "sources/Frankfurt_1858" }] }));
  applyBatch(dir, { ops: [{ op: "setMembers", id: "ffm", members: [{ path: "sources/wills/box-3" }] }] });
  assert.equal(manifest(dir, "ffm").description, "late");
  rmSync(dir, { recursive: true, force: true });
});

test("applyBatch validation rejects the whole batch and writes nothing", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "F", members: [{ path: "sources/Frankfurt_1858" }] }));
  writeFileSync(join(dir, "collections", "zz-broken.json"), "{ nope");
  const cases: [any, RegExp][] = [
    [{ op: "create", id: "Bad Id", name: "x", members: [{ path: "sources/Frankfurt_1858" }] }, /create 'Bad Id'/],
    [{ op: "create", id: "ffm", name: "x", members: [{ path: "sources/Frankfurt_1858" }] }, /already exists/],
    [{ op: "create", id: "zz-broken", name: "x", members: [{ path: "sources/Frankfurt_1858" }] }, /already exists/],
    [{ op: "create", id: "empty", name: "x", members: [] }, /no sources/],
    [{ op: "setMembers", id: "ffm", members: [] }, /no sources/],
    [{ op: "setMembers", id: "ffm", members: [{ path: "sources/nope" }] }, /unknown source/],
    [{ op: "rename", id: "missing", name: "x" }, /not found/],
    [{ op: "rename", id: "ffm", name: "   " }, /name/],
    [{ op: "delete", id: "missing" }, /not found/],
  ];
  for (const [op, re] of cases) {
    const r = applyBatch(dir, { ops: [{ op: "rename", id: "ffm", name: "Changed" }, op] });
    assert.equal(r.ok, false, JSON.stringify(op));
    if (!r.ok) { assert.match(r.error, re); assert.equal(r.applied, 0); }
    assert.equal(manifest(dir, "ffm").name, "F", "nothing written");
  }
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/collection-edit.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/collection-edit.ts`**

Resolve "same member" for `meta` carry-over by comparing `normalizeMemberPath(...).abs`. Validation of member paths checks against `readSnapshot(ws).sources` computed once at the start of `applyBatch`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/collection-edit.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/collection-edit.ts test/collection-edit.test.ts
git commit -m "feat: collection manifest editor — snapshot and validated batch apply"
```

---

### Task 3: Protocol messages and `AgentHost` wiring

**Files:**
- Modify: `src/shared/webview-protocol.ts` (the `ExtToWebview` union near the `collections` member, and `WebviewToExt` near `selectCollection`)
- Modify: `src/main/agent-host.ts` (`handleWebviewMessage` switch near `case "selectCollection"`; new method)
- Modify: `test/mock-pi.mjs` (`handlePrompt`)
- Test: `test/agent-host.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 `readSnapshot`, `applyBatch`.
- Produces:
  - `WebviewToExt` gains `{ type: "collections/plan" }` and `{ type: "collections/apply"; batch: CollectionBatch }`.
  - `ExtToWebview` gains `{ type: "collections/snapshot"; snapshot: CollectionSnapshot }` and `{ type: "collections/applied"; result: CollectionApplyResult }`.
  - `AgentHost.streaming: boolean` (public getter over the private `isStreaming`, for tests)
  - `AgentHost.applyCollectionBatch(batch: CollectionBatch): Promise<CollectionApplyResult>` (public, so tests call it directly) implementing spec steps 1–4: streaming refusal → `applyBatch` → `postCollections()` → if `rpc?.isRunning`: active id non-null and still on disk → prompt `/select-collection <id>`; active id non-null and gone → `/select-collection (all sources)`; active null → no prompt. A thrown prompt error becomes `{ ok: true, warning: "Saved, but the agent could not reload its catalogue: <message>" }`.
  - `test/mock-pi.mjs` gains the scenario `"hang: …"` → `send({ type: "agent_start" })` and nothing else (keeps the host in `isStreaming` until stop).

- [ ] **Step 1: Write the failing tests** (append to `test/agent-host.test.ts`, reusing `makeWorkspace`, `makeHost`, `waitFor`, `postHttp`, `writeCollection`)

```ts
test("collections/plan posts a snapshot of sources and manifests", async () => {
  const ws = makeWorkspace();
  writeCollection(ws, "parish", { name: "Parish books", members: [{ path: "sources/TestSource" }] });
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "collections/plan" });
    const m = posted.find((x) => x.type === "collections/snapshot");
    assert.ok(m && m.type === "collections/snapshot");
    assert.deepEqual(m.snapshot, {
      sources: [{ path: "sources/TestSource", ref: "TestSource", pageCount: 1, outOfTree: false }],
      collections: [{ id: "parish", name: "Parish books", members: [{ path: "sources/TestSource" }] }],
      takenIds: ["parish"],
    });
  } finally { await host.stop(); rmSync(ws, { recursive: true, force: true }); }
});

test("applyCollectionBatch is refused while the agent is streaming", async () => {
  const ws = makeWorkspace();
  const { host } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "hang: forever" });
    await waitFor(() => host.streaming || undefined);
    const r = await host.applyCollectionBatch({ ops: [{ op: "create", id: "x", name: "X", members: [{ path: "sources/TestSource" }] }] });
    assert.deepEqual(r, { ok: false, error: "The agent is mid-answer; try again when it finishes.", applied: 0 });
    assert.ok(!existsSync(join(ws, "collections", "x.json")));
  } finally { await host.stop(); rmSync(ws, { recursive: true, force: true }); }
});

test("applyCollectionBatch writes, refreshes the picker and re-selects the active collection", async () => {
  const ws = makeWorkspace();
  writeCollection(ws, "parish", { name: "Parish books", members: [{ path: "sources/TestSource" }] });
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await waitFor(() => posted.some((m) => m.type === "models") || undefined);
    // active = parish (as the agent would announce it)
    await postHttp(host.httpPort, { type: "collection", id: "parish", name: "Parish books", dataDir: ws });
    await waitFor(() => host.activeCollectionId === "parish" || undefined);

    // (a) active collection still exists → re-selected (mock-pi answers /select-collection parish by re-announcing it)
    posted.length = 0;
    assert.deepEqual(await host.applyCollectionBatch({ ops: [{ op: "rename", id: "parish", name: "Parish renamed" }] }), { ok: true });
    const pick = posted.find((m) => m.type === "collections");
    assert.ok(pick && pick.type === "collections" && pick.collections[0].name === "Parish renamed");
    await waitFor(() => (posted.filter((m) => m.type === "collections").length >= 2 ? true : undefined));
    assert.equal(host.activeCollectionId, "parish");

    // (b) active collection deleted → falls back to all sources
    assert.deepEqual(await host.applyCollectionBatch({ ops: [{ op: "delete", id: "parish" }] }), { ok: true });
    await waitFor(() => host.activeCollectionId === null || undefined);

    // (c) active = all sources → no prompt: exactly one collections message (the picker refresh)
    posted.length = 0;
    assert.deepEqual(await host.applyCollectionBatch({ ops: [{ op: "create", id: "new", name: "New", members: [{ path: "sources/TestSource" }] }] }), { ok: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(posted.filter((m) => m.type === "collections").length, 1);
  } finally { await host.stop(); rmSync(ws, { recursive: true, force: true }); }
});

test("applyCollectionBatch with no agent running still writes and replies ok", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    const r = await host.applyCollectionBatch({ ops: [{ op: "create", id: "offline", name: "Offline", members: [{ path: "sources/TestSource" }] }] });
    assert.deepEqual(r, { ok: true });
    assert.ok(existsSync(join(ws, "collections", "offline.json")));
    assert.ok(posted.some((m) => m.type === "collections"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
```

(`existsSync` must be added to the `node:fs` import at the top of the file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/agent-host.test.ts`
Expected: the four new tests FAIL (unknown message type / method missing); existing tests still pass.

- [ ] **Step 3: Add the protocol members, the mock-pi `hang:` scenario, the `streaming` getter, and `applyCollectionBatch` + the two `case`s in `handleWebviewMessage`**

`case "collections/plan"` posts `readSnapshot(this.workspaceDir)`; `case "collections/apply"` posts `{ type: "collections/applied", result: await this.applyCollectionBatch(msg.batch) }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all green (previous 116 + 3 + 5 + 4 = 128 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/webview-protocol.ts src/main/agent-host.ts test/mock-pi.mjs test/agent-host.test.ts
git commit -m "feat: collections/plan and collections/apply host messages; re-sync the agent after a save"
```

---

### Task 4: The Organize sources dialog and the header button

**Files:**
- Create: `src/renderer/components/organize-dialog.ts`
- Modify: `src/renderer/components/chronos-app.ts` (import/register the component the same way `provider-dialog` is; `renderHeader()` after the collection `<select>`; `handleMessage` for the two new messages; render the dialog beside `chronos-provider-dialog`; `runTestAction` gains `"openOrganize"` which does what the header button does; `collectTestState` gains `organizeOpen: boolean`)
- Modify: `src/renderer/styles.css` (new `.organize-*` rules after the `.dialog-actions` block)
- Reference (read only): `src/renderer/components/provider-dialog.ts` (dialog conventions: light DOM, `post` callback, `close` event, Escape handling)

**Interfaces:**
- Consumes: Task 1 (`CollectionSnapshot`, `DesiredCollection`, `MemberRef`, `slugifyCollectionId`, `diffCollections`, `CollectionApplyResult`), Task 3 messages.
- Produces: `<chronos-organize-dialog>` (`class ChronosOrganizeDialog extends LitElement`, light DOM) with
  - properties set by the parent: `snapshot: CollectionSnapshot | null`, `result: CollectionApplyResult | null`, `post: (m: WebviewToExt) => void`
  - events: `close`
  - state: `desired: DesiredCollection[]` (seeded from `snapshot.collections` the first time a snapshot arrives; later snapshots replace only `snapshot`), `editing: { kind: "new" } | { kind: "rename"; id } | { kind: "delete"; id } | null`, `confirmDiscard: boolean`, `saving: boolean`, `footerError: string`
  - `get batch(): CollectionBatch` = `diffCollections(snapshot.collections, desired)`; `get changeCount(): number` = `batch.ops.length`
  - new column id = `slugifyCollectionId(name, [...snapshot.takenIds, ...desired.map((c) => c.id)])`; an empty or duplicate display name is refused inline (`input.organize-inline.is-invalid`)
  - `save()`: sets `footerError` and returns without posting when any `desired` collection has zero members (`"'<name>' has no sources: tick one or delete it"`, column gets class `is-empty`); otherwise `saving = true`, `post({ type: "collections/apply", batch })`.
  - On `result` change: `ok && !warning` → close; `ok && warning` → close (the app shows the toast); `!ok && applied === 0` → `saving=false`, `footerError = error`; `!ok && applied > 0` → `saving=false`, `footerError = error`, `post({ type: "collections/plan" })` (desired is kept; the next snapshot re-seeds only `snapshot`, not `desired`).
  - Closing (✕, Escape, backdrop click, Cancel) with `changeCount > 0` → `confirmDiscard = true` and a footer row "Discard N unsaved changes? [Discard] [Keep editing]".
- `chronos-app` state: `organize: { snapshot: CollectionSnapshot | null; result: CollectionApplyResult | null } | null`. Button click → `organize = { snapshot: null, result: null }` and `post({ type: "collections/plan" })`. `collections/snapshot` → `organize.snapshot = msg.snapshot` (only when `organize` is non-null). `collections/applied` → `organize.result = msg.result`, and if `result.ok && result.warning` push a warning toast with that text. Dialog `close` → `organize = null`.

Markup (class names the CSS and the e2e test rely on):

```
.dialog-backdrop.organize-backdrop
  .dialog.organize-dialog
    .dialog-title "Organize sources"   + button.organize-close "✕"
    .organize-grid (scroll container)
      table.organize-table
        thead > tr > th.organize-src "Source" | th.organize-col (per collection: span.organize-col-name title=<id>, button.organize-rename "✎", button.organize-delete "🗑") | th.organize-add (button.organize-add-btn "+ New collection" | input.organize-inline)
        tbody > tr (per source) > td.organize-src (<ref> <span.organize-pages>N p.</span>) | td.organize-cell > input[type=checkbox] (per collection) | td
    .organize-footer: span.organize-dirty ("● N unsaved changes" or "No changes") | span.organize-error | .dialog-actions: button.organize-cancel "Cancel", button.organize-save "Save" (disabled when changeCount===0 or saving)
```

Header button: `<button class="header-btn organize-btn" title="Put sources into collections" @click=...>Organize sources</button>` directly after the collection `<label class="control">` block (rendered unconditionally, unlike the picker).

- [ ] **Step 1: Implement the component, the header button, the app wiring, the CSS**

CSS pins: `.organize-dialog { width: min(1100px, 90vw); max-height: 80vh; display: flex; flex-direction: column; top: 10%; }`; `.organize-grid { overflow: auto; flex: 1; }`; `thead th { position: sticky; top: 0; }`; `.organize-src { position: sticky; left: 0; }`; `th.is-empty, td.is-empty { background: var(--ch-danger-soft, rgba(220,80,80,.12)); }`; `.organize-add-btn { border: 1px dashed var(--ch-brand); border-radius: 12px; }`.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Manual check in the dev app** (`npm run dev -- --workspace <some workspace>`): open the dialog, add a column, tick two boxes, Save; confirm the manifest on disk and the new picker entry; reopen, untick everything in one column, Save → refused with the column highlighted; Cancel with changes → discard prompt.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/organize-dialog.ts src/renderer/components/chronos-app.ts src/renderer/styles.css
git commit -m "feat: Organize sources dialog — sources × collections grid with batch save"
```

---

### Task 5: End-to-end test and docs

**Files:**
- Modify: `test/e2e/boot.spec.ts` (append one test; add `readFileSync`, `existsSync` to the `node:fs` import)
- Modify: `README.md` (the collections paragraph: mention the button) and `DOCS.md` (`collections/` line: "edit with Organize sources in the header, or by hand")

**Interfaces:**
- Consumes: Task 4 class names and the `openOrganize` test action.

- [ ] **Step 1: Write the failing e2e test**

```ts
test("Organize sources: create a collection, tick a source, save", async () => {
  await invoke(page, "openOrganize");
  const dialog = page.locator(".organize-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("td.organize-src")).toContainText("TestSource");
  await dialog.locator(".organize-add-btn").click();
  await dialog.locator("input.organize-inline").fill("Parish Books");
  await dialog.locator("input.organize-inline").press("Enter");
  await expect(dialog.locator("th.organize-col")).toHaveCount(1);
  // A new empty column is one pending change, but Save refuses it until it has a member.
  await expect(dialog.locator(".organize-dirty")).toContainText("1 unsaved change");
  await dialog.locator(".organize-save").click();
  await expect(dialog.locator(".organize-error")).toContainText("has no sources");
  await dialog.locator("td.organize-cell input[type=checkbox]").first().check();
  await dialog.locator(".organize-save").click();
  await expect(dialog).toBeHidden();
  const file = join(fixture, "collections", "parish-books.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ name: "Parish Books", members: [{ path: "sources/TestSource" }] });
  await expect(page.locator("#app-header select.control-select option", { hasText: "Parish Books" })).toHaveCount(1);
});
```

- [ ] **Step 2: Build and run the e2e suite to verify the new test fails**

Run: `npm run build && npm run test:e2e`
Expected: 7 existing pass, the new one FAILS only if Task 4 is incomplete; if it passes already, continue.

- [ ] **Step 3: Fix whatever the e2e run surfaces; update README.md and DOCS.md**

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test && npm run build && npm run test:e2e`
Expected: all green (unit 128, e2e 8).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/boot.spec.ts README.md DOCS.md
git commit -m "test: e2e for Organize sources; docs"
```
