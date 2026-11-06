/**
 * Fallback derivation of a source's `data/<key>/` directory name, for use only
 * when the agent hasn't yet told the host what key it's using for a given
 * source directory this session (a cold `dataKeyBySourceDir` cache entry — see
 * `AgentHost.dataKeyForSourceDir` in `agent-host.ts`).
 *
 * This deliberately mirrors — line for line — the agent's own derivation:
 *   - `toSlug` in `agent/utils/source-discovery.ts`
 *   - `deriveRef` and `dataKeyForRef` in `agent/tools/collection-context.ts`
 *
 * The host bundle cannot import those modules (the agent is a separate ESM
 * package compiled to `agent/dist/` and loaded by pi at runtime, not by the
 * Electron main process), so the trivial slug transform is duplicated across
 * the package boundary on purpose. If the agent's logic in the files above
 * ever changes, update this file to match — that drift is exactly what
 * `test/data-key.test.ts` checks for by running both sides on the same inputs.
 */
import { basename, isAbsolute, join, relative, sep } from "node:path";

/** Mirrors agent/utils/source-discovery.ts's toSlug. */
export function toSlug(rel: string): string {
  return rel.replace(/[\\/]/g, "--").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Mirrors agent/tools/collection-context.ts's refFromRelative. Translates the
 *  PLATFORM separator only — on POSIX a backslash is a legal filename character,
 *  and folding it would collide a dir named `city\Nested` with `city/Nested`. */
export function refFromRelative(rel: string, pathSep: string = sep): string {
  return rel.split(pathSep).join("/");
}

/** Mirrors agent/tools/collection-context.ts's deriveRef. */
export function deriveRef(workspaceDir: string, sourcePath: string): string {
  const rel = relative(join(workspaceDir, "sources"), sourcePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? refFromRelative(rel) : basename(sourcePath);
}

/** Mirrors agent/tools/collection-context.ts's dataKeyForRef. */
export function dataKeyForRef(ref: string, sourcePath: string): string {
  return ref.includes("/") ? toSlug(ref) : basename(sourcePath);
}

/** The full derivation the agent uses for a source's data dir name, applied to
 *  a bare source directory (no pre-computed ref available on the host side). */
export function deriveDataKeyFallback(workspaceDir: string, sourceDir: string): string {
  return dataKeyForRef(deriveRef(workspaceDir, sourceDir), sourceDir);
}
