// pi's own settings.json inside the app's isolated agent dir
// (PI_CODING_AGENT_DIR = <userData>/pi-agent). pi reads `defaultProvider` /
// `defaultModel` from it at startup; pi 1.5.0 would otherwise fall back to its
// built-in per-provider default (Claude Opus 4.8 for Anthropic), so the app
// seeds a current-generation choice on first run and remembers the user's picks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelRef {
  provider: string;
  id: string;
}

/** Best-first; the first one the user has auth for becomes the standard model. */
export const PREFERRED_DEFAULT_MODELS: readonly string[] = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "google/gemini-pro-latest",
  "openai/gpt-5.5",
];

type PiSettings = Record<string, unknown>;

export function readPiSettings(agentDir: string): PiSettings {
  try {
    const j = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as PiSettings) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into pi's settings.json (re-read first; pi writes it too). Atomic. */
export function writePiSettings(agentDir: string, patch: PiSettings): void {
  mkdirSync(agentDir, { recursive: true });
  const merged = { ...readPiSettings(agentDir), ...patch };
  const file = join(agentDir, "settings.json");
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

/** The first preferred model that is available, else undefined. */
export function chooseDefaultModel(available: readonly ModelRef[]): ModelRef | undefined {
  for (const spec of PREFERRED_DEFAULT_MODELS) {
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    if (available.some((m) => m.provider === provider && m.id === id)) return { provider, id };
  }
  return undefined;
}

/**
 * Seed pi's default model once: when settings.json has no `defaultModel` yet,
 * pick the best available preferred model, persist it, and return it so the
 * caller can switch the running session. Returns undefined when a default is
 * already stored (the user's choice wins) or nothing preferred is available.
 */
export function ensurePiDefaultModel(agentDir: string, available: readonly ModelRef[]): ModelRef | undefined {
  const current = readPiSettings(agentDir);
  if (typeof current.defaultModel === "string" && current.defaultModel) return undefined;
  const choice = chooseDefaultModel(available);
  if (!choice) return undefined;
  writePiSettings(agentDir, { defaultProvider: choice.provider, defaultModel: choice.id });
  return choice;
}

/** Remember a model the user picked so new sessions start on it. */
export function rememberModelChoice(agentDir: string, model: ModelRef): void {
  writePiSettings(agentDir, { defaultProvider: model.provider, defaultModel: model.id });
}
