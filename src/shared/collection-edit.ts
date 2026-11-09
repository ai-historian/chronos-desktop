/**
 * Types and pure helpers for the collections editor (the sources × collections
 * grid). Shared by the Electron main process and the renderer, so this module
 * must stay dependency-free: no Electron, no Node-only imports, no agent code.
 */

/** One source directory as the editor sees it. */
export interface SourceRow {
  path: string;
  ref: string;
  pageCount: number;
  outOfTree: boolean;
}

/** A member of a collection: a source path, optionally with its agent ref. */
export interface MemberRef {
  path: string;
  ref?: string;
}

export interface DesiredCollection {
  id: string;
  name: string;
  members: MemberRef[];
}

/**
 * What the editor loads: the sources, the collections it could parse, and
 * `takenIds`, every `collections/*.json` stem (parseable or not), so new ids
 * can be slugged against files the renderer cannot otherwise see.
 */
export interface CollectionSnapshot {
  sources: SourceRow[];
  collections: DesiredCollection[];
  takenIds: string[];
}

export type CollectionOp =
  | { op: "create"; id: string; name: string; members: MemberRef[] }
  | { op: "rename"; id: string; name: string }
  | { op: "delete"; id: string }
  | { op: "setMembers"; id: string; members: MemberRef[] };

export interface CollectionBatch {
  ops: CollectionOp[];
}

export type CollectionApplyResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string; applied: number };

export const COLLECTION_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Derive a collection id from a display name. NFKD-normalises, strips Unicode
 * combining marks (so `ü` becomes `u`), lower-cases, replaces each run of
 * characters outside `[a-z0-9_-]` with `-`, and trims `-` from both ends. An empty result becomes `collection`. If the candidate
 * is already in `taken`, the first free `<base>-2`, `<base>-3`, … is used.
 */
export function slugifyCollectionId(name: string, taken: Iterable<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "collection";
  const used = new Set(taken);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Order-insensitive comparison of two member lists by `path` and `ref`. */
export function sameMembers(a: MemberRef[], b: MemberRef[]): boolean {
  if (a.length !== b.length) return false;
  const keys = (members: MemberRef[]) =>
    members.map((m) => JSON.stringify([m.path, m.ref ?? null])).sort();
  const ka = keys(a);
  const kb = keys(b);
  return ka.every((k, i) => k === kb[i]);
}

/**
 * Diff two collection lists into a batch of operations. Order: every
 * `delete`, then every `create`, then `rename`, then `setMembers`. An id in
 * both lists yields `rename` only when `name` differs and `setMembers` only
 * when the members differ.
 */
export function diffCollections(
  before: DesiredCollection[],
  after: DesiredCollection[],
): CollectionBatch {
  const beforeById = new Map(before.map((c) => [c.id, c]));
  const afterById = new Map(after.map((c) => [c.id, c]));
  const deletes: CollectionOp[] = [];
  const creates: CollectionOp[] = [];
  const renames: CollectionOp[] = [];
  const setMembers: CollectionOp[] = [];

  for (const c of before) {
    if (!afterById.has(c.id)) deletes.push({ op: "delete", id: c.id });
  }
  for (const c of after) {
    const prev = beforeById.get(c.id);
    if (!prev) {
      creates.push({ op: "create", id: c.id, name: c.name, members: c.members });
      continue;
    }
    if (prev.name !== c.name) renames.push({ op: "rename", id: c.id, name: c.name });
    if (!sameMembers(prev.members, c.members)) {
      setMembers.push({ op: "setMembers", id: c.id, members: c.members });
    }
  }
  return { ops: [...deletes, ...creates, ...renames, ...setMembers] };
}
