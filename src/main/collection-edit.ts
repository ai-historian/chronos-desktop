import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  COLLECTION_ID_RE,
  type CollectionApplyResult,
  type CollectionBatch,
  type CollectionOp,
  type CollectionSnapshot,
  type DesiredCollection,
  type MemberRef,
  type SourceRow,
} from "../shared/collection-edit";
import { deriveRef, refFromRelative } from "./data-key";
import { countPages, discoverSources } from "./sources";

/** Resolve a manifest member path the way the agent does (`join(ws, p)` for a
 *  relative one) and classify it as inside `sources/` or not. */
export function normalizeMemberPath(
  workspaceDir: string,
  manifestPath: string,
): { rowPath: string; abs: string; outOfTree: boolean } {
  const abs = isAbsolute(manifestPath) ? manifestPath : join(workspaceDir, manifestPath);
  const root = join(workspaceDir, "sources");
  const rel = relative(root, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return { rowPath: "sources/" + refFromRelative(rel), abs, outOfTree: false };
  }
  return { rowPath: abs, abs, outOfTree: true };
}

const collectionsDir = (ws: string) => join(ws, "collections");
const manifestFile = (ws: string, id: string) => join(collectionsDir(ws), `${id}.json`);

function readManifest(file: string): any | null {
  try {
    const m = JSON.parse(readFileSync(file, "utf-8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

function manifestStems(ws: string): string[] {
  try {
    return readdirSync(collectionsDir(ws))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function readSnapshot(workspaceDir: string): CollectionSnapshot {
  const takenIds = manifestStems(workspaceDir);
  const collections: DesiredCollection[] = [];
  const memberRows = new Map<string, SourceRow>();

  for (const id of takenIds) {
    const m = readManifest(manifestFile(workspaceDir, id));
    if (!m) continue;
    const members: MemberRef[] = [];
    for (const raw of Array.isArray(m.members) ? m.members : []) {
      if (!raw || typeof raw.path !== "string") continue;
      const { rowPath, abs, outOfTree: oot } = normalizeMemberPath(workspaceDir, raw.path);
      const derived = deriveRef(workspaceDir, abs);
      const explicit = typeof raw.ref === "string" && raw.ref ? raw.ref : undefined;
      const member: MemberRef = { path: rowPath };
      if (explicit && explicit !== derived) member.ref = explicit;
      members.push(member);
      if (!memberRows.has(rowPath)) {
        memberRows.set(rowPath, { path: rowPath, ref: explicit ?? derived, pageCount: countPages(abs), outOfTree: oot });
      }
    }
    collections.push({ id, name: typeof m.name === "string" ? m.name : id, members });
  }
  collections.sort((a, b) => a.name.localeCompare(b.name));

  const inTree: SourceRow[] = discoverSources(join(workspaceDir, "sources")).map((s) => ({
    path: "sources/" + s.name,
    ref: s.name,
    pageCount: countPages(s.path),
    outOfTree: false,
  }));
  const discovered = new Set(inTree.map((r) => r.path));
  const extra = [...memberRows.values()].filter((r) => !discovered.has(r.path));
  const sources = [...inTree, ...extra].sort((a, b) => a.ref.localeCompare(b.ref));
  return { sources, collections, takenIds };
}

const label = (op: CollectionOp) => `${op.op} '${op.id}'`;

function validate(ws: string, batch: CollectionBatch): string | null {
  const known = new Set(readSnapshot(ws).sources.map((s) => s.path));
  const onDisk = new Set(manifestStems(ws));
  const parseable = new Set([...onDisk].filter((id) => readManifest(manifestFile(ws, id))));
  for (const op of batch.ops) {
    if (typeof op.id !== "string" || !COLLECTION_ID_RE.test(op.id)) return `${label(op)}: invalid id`;
    if (op.op === "create") {
      if (onDisk.has(op.id)) return `${label(op)}: already exists`;
    } else if (!parseable.has(op.id)) {
      return `${label(op)}: not found`;
    }
    if ((op.op === "create" || op.op === "rename") && !String(op.name ?? "").trim()) {
      return `${label(op)}: name must not be empty`;
    }
    if (op.op === "create" || op.op === "setMembers") {
      if (!op.members?.length) return `${label(op)}: no sources`;
      for (const m of op.members) {
        if (!known.has(m.path)) return `${label(op)}: unknown source ${m.path}`;
      }
    }
    // Track the batch's own effect so later ops see earlier creates/deletes.
    if (op.op === "create") { onDisk.add(op.id); parseable.add(op.id); }
    if (op.op === "delete") { onDisk.delete(op.id); parseable.delete(op.id); }
  }
  return null;
}

function writeManifest(ws: string, id: string, m: unknown): void {
  mkdirSync(collectionsDir(ws), { recursive: true });
  const file = manifestFile(ws, id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, file);
}

function buildMembers(ws: string, members: MemberRef[], existing: unknown): unknown[] {
  const metaByAbs = new Map<string, unknown>();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && typeof e.path === "string" && e.meta !== undefined) {
      metaByAbs.set(normalizeMemberPath(ws, e.path).abs, e.meta);
    }
  }
  return members.map((m) => {
    const out: Record<string, unknown> = {};
    if (m.ref) out.ref = m.ref;
    out.path = m.path;
    const meta = metaByAbs.get(normalizeMemberPath(ws, m.path).abs);
    if (meta !== undefined) out.meta = meta;
    return out;
  });
}

function applyOp(ws: string, op: CollectionOp): void {
  if (op.op === "delete") {
    unlinkSync(manifestFile(ws, op.id));
    return;
  }
  const m = op.op === "create" ? {} : readManifest(manifestFile(ws, op.id)) ?? {};
  if (op.op === "create" || op.op === "rename") m.name = op.name.trim();
  if (op.op === "create" || op.op === "setMembers") m.members = buildMembers(ws, op.members, m.members);
  writeManifest(ws, op.id, m);
}

export function applyBatch(workspaceDir: string, batch: CollectionBatch): CollectionApplyResult {
  const invalid = validate(workspaceDir, batch);
  if (invalid) return { ok: false, error: invalid, applied: 0 };
  let applied = 0;
  for (const op of batch.ops) {
    try {
      applyOp(workspaceDir, op);
    } catch (e) {
      return { ok: false, error: `${label(op)}: ${e instanceof Error ? e.message : String(e)}`, applied };
    }
    applied++;
  }
  return { ok: true };
}
