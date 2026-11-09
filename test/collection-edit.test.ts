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

test("in-tree members without png/ are still snapshot rows and can be kept by setMembers", () => {
  const dir = ws();
  mkdirSync(join(dir, "sources", "NoPng"), { recursive: true });
  writeFileSync(join(dir, "collections", "np.json"), JSON.stringify({ name: "NP", members: [{ path: "sources/NoPng" }] }));
  const snap = readSnapshot(dir);
  assert.deepEqual(snap.sources.find((s) => s.path === "sources/NoPng"), { path: "sources/NoPng", ref: "NoPng", pageCount: 0, outOfTree: false });
  assert.deepEqual(applyBatch(dir, { ops: [{ op: "setMembers", id: "np", members: [{ path: "sources/NoPng" }, { path: "sources/Frankfurt_1858" }] }] }), { ok: true });
  assert.deepEqual(manifest(dir, "np").members, [{ path: "sources/NoPng" }, { path: "sources/Frankfurt_1858" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("create is rejected when a differently-cased manifest exists (case-insensitive filesystems)", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "FFM.json"), JSON.stringify({ name: "F", members: [{ path: "sources/Frankfurt_1858" }] }));
  const r = applyBatch(dir, { ops: [{ op: "create", id: "ffm", name: "x", members: [{ path: "sources/Frankfurt_1858" }] }] });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.match(r.error, /create 'ffm': already exists/); assert.equal(r.applied, 0); }
  rmSync(dir, { recursive: true, force: true });
});

test("a failing write mid-batch reports applied count and the op, without clobbering", () => {
  const dir = ws();
  for (const id of ["a", "b"]) writeFileSync(join(dir, "collections", `${id}.json`), JSON.stringify({ name: id, description: "d", members: [{ path: "sources/Frankfurt_1858" }] }));
  mkdirSync(join(dir, "collections", "b.json.tmp")); // makes the write for 'b' fail
  const r = applyBatch(dir, { ops: [{ op: "rename", id: "a", name: "A2" }, { op: "rename", id: "b", name: "B2" }] });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.applied, 1); assert.match(r.error, /rename 'b'/); }
  assert.equal(manifest(dir, "a").name, "A2");
  assert.equal(manifest(dir, "b").name, "b");
  rmSync(dir, { recursive: true, force: true });
});

test("setMembers preserves the whole existing member object and rejects malformed members", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "ffm.json"), JSON.stringify({ name: "F", members: [{ ref: "Frankfurt_1858", path: "sources/Frankfurt_1858", note: "x", meta: { year: 1858 } }] }));
  assert.deepEqual(applyBatch(dir, { ops: [{ op: "setMembers", id: "ffm", members: [{ path: "sources/wills/box-3" }, { path: "sources/Frankfurt_1858" }] }] }), { ok: true });
  assert.deepEqual(manifest(dir, "ffm").members[1], { ref: "Frankfurt_1858", path: "sources/Frankfurt_1858", note: "x", meta: { year: 1858 } });
  const r = applyBatch(dir, { ops: [{ op: "setMembers", id: "ffm", members: [null as any] }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /setMembers 'ffm': invalid member/);
  rmSync(dir, { recursive: true, force: true });
});

test("setMembers keeps out-of-tree member paths verbatim (relative and absolute) with their meta", () => {
  const dir = ws();
  mkdirSync(join(dir, "other", "B", "png"), { recursive: true });
  writeFileSync(join(dir, "other", "B", "png", "page_0001.png"), "");
  const outside = mkdtempSync(join(tmpdir(), "chronos-outside-"));
  mkdirSync(join(outside, "png"));
  writeFileSync(join(outside, "png", "page_0001.png"), "");
  writeFileSync(join(dir, "collections", "oot.json"), JSON.stringify({ name: "O", members: [
    { path: "other/B", meta: { y: 1 } }, { path: outside, meta: { y: 2 } },
  ] }));
  const rows = readSnapshot(dir).sources;
  const relRow = rows.find((r) => r.outOfTree && r.path.endsWith("other/B"))!;
  assert.ok(relRow);
  const r = applyBatch(dir, { ops: [{ op: "setMembers", id: "oot", members: [
    { path: relRow.path }, { path: outside }, { path: "sources/Frankfurt_1858" },
  ] }] });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(manifest(dir, "oot").members, [
    { path: "other/B", meta: { y: 1 } }, { path: outside, meta: { y: 2 } }, { path: "sources/Frankfurt_1858" },
  ]);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("manifests with non-slug filenames can be renamed and do not block other ops", () => {
  const dir = ws();
  writeFileSync(join(dir, "collections", "FFM.json"), JSON.stringify({ name: "F", description: "d", members: [{ path: "sources/Frankfurt_1858" }] }));
  const r = applyBatch(dir, { ops: [{ op: "rename", id: "FFM", name: "Frankfurt" }] });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(manifest(dir, "FFM"), { name: "Frankfurt", description: "d", members: [{ path: "sources/Frankfurt_1858" }] });
  rmSync(dir, { recursive: true, force: true });
});

test("a collection whose members have no png/ counts as having no sources", () => {
  const dir = ws();
  mkdirSync(join(dir, "sources", "NoPng"), { recursive: true });
  // NoPng is only a snapshot row because another manifest names it.
  writeFileSync(join(dir, "collections", "other.json"), JSON.stringify({ name: "Other", members: [{ path: "sources/NoPng" }] }));
  const r = applyBatch(dir, { ops: [{ op: "create", id: "np", name: "NP", members: [{ path: "sources/NoPng" }] }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /create 'np': no sources/);
  assert.equal(existsSync(join(dir, "collections", "np.json")), false);
  rmSync(dir, { recursive: true, force: true });
});
