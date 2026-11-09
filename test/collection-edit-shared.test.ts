import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyCollectionId, diffCollections, sameMembers, COLLECTION_ID_RE } from "../src/shared/collection-edit";

test("slugifyCollectionId lower-cases, collapses runs, trims, and suffixes on collision", () => {
  assert.equal(slugifyCollectionId("Frankfurt Directories!", []), "frankfurt-directories");
  assert.equal(slugifyCollectionId("  --Parish 1840s--  ", []), "parish-1840s");
  assert.equal(slugifyCollectionId("???", []), "collection");
  assert.equal(slugifyCollectionId("Parish", ["parish"]), "parish-2");
  assert.equal(slugifyCollectionId("Parish", ["parish", "parish-2"]), "parish-3");
  assert.equal(slugifyCollectionId("ünïcödé", []), "unicode");
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

test("slugifyCollectionId compares against taken ids case-insensitively", () => {
  assert.equal(slugifyCollectionId("ffm", ["FFM"]), "ffm-2");
});
