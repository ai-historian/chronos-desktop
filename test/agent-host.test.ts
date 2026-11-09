import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost, shouldResync } from "../src/main/agent-host";
import type { ExtToWebview } from "../src/shared/webview-protocol";

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "chronos-agent-host-"));
  mkdirSync(join(dir, "sources", "TestSource", "png"), { recursive: true });
  writeFileSync(join(dir, "sources", "TestSource", "png", "page_0001.png"), PNG_1X1);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

function writeCollection(ws: string, id: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(ws, "collections"), { recursive: true });
  writeFileSync(join(ws, "collections", `${id}.json`), JSON.stringify(manifest));
}

function makeHost(workspaceDir: string) {
  const posted: ExtToWebview[] = [];
  const host = new AgentHost({
    workspaceDir,
    transport: { post: (m) => posted.push(m) },
    launch: (port) => ({
      bin: process.execPath,
      args: [join(__dirname, "mock-pi.mjs"), "--mode", "rpc"],
      env: { CHRONOS_HTTP_PORT: String(port) },
    }),
    imageUri: (p) => `test-img://${p}`,
  });
  return { host, posted };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

test("start seeds webview with state, models, commands, sources, sessions", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    assert.equal(host.status, "ready");
    const want = ["state", "yolo", "sources", "sessions", "history", "models", "loginRequired", "commands"];
    await waitFor(() => want.every((t) => posted.some((m) => m.type === t)) || undefined);
    // state comes first, before the async model/command replies
    assert.equal(posted[0].type, "state");
    const sources = posted.find((m) => m.type === "sources");
    assert.deepEqual(sources && sources.type === "sources" && sources.sources, [
      { name: "TestSource", pageCount: 1, dataKey: "TestSource" },
    ]);
    // No collections/ dir yet → an empty catalogue on the auto collection.
    const collections = posted.find((m) => m.type === "collections");
    assert.deepEqual(collections, { type: "collections", collections: [], active: null });
    const login = posted.find((m) => m.type === "loginRequired");
    assert.equal(login && login.type === "loginRequired" && login.required, false);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("show_page over http posts viewer/showPage with imageUri from callback", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "select: TestSource" });
    const show = await waitFor(() => {
      const m = posted.find((x) => x.type === "viewer/showPage");
      return m && m.type === "viewer/showPage" ? m : undefined;
    });
    // mock-pi derives sourceDir from its cwd (the workspace), which is realpath'd.
    const page = join(realpathSync(ws), "sources", "TestSource", "png", "page_0001.png");
    assert.equal(show.imageUri, `test-img://${page}`);
    assert.equal(show.pageId, 1);
    assert.equal(show.sourceName, "TestSource");
    assert.equal(show.lastPage, 1);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("exit cancels pending ui requests", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "ask: pick one" });
    await waitFor(() => posted.find((m) => m.type === "uiRequest"));
    assert.equal(host.pendingUiRequestCount, 1);
    const pid = host.agentPid;
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    const exited = await waitFor(() => posted.find((m) => m.type === "agentExited"));
    // The renderer relies on uiRequest arriving before agentExited to clear it.
    const uiIdx = posted.findIndex((m) => m.type === "uiRequest");
    const exitIdx = posted.indexOf(exited);
    assert.ok(uiIdx >= 0 && uiIdx < exitIdx, "uiRequest must precede agentExited");
    assert.equal(typeof (exited.type === "agentExited" && exited.stderr), "string");
    assert.equal(host.status, "exited");
    assert.equal(host.pendingUiRequestCount, 0);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("stop cancels pending ui requests and clears the set", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "ask: pick one" });
    await waitFor(() => posted.find((m) => m.type === "uiRequest"));
    await host.stop();
    assert.equal(host.pendingUiRequestCount, 0);
    assert.equal(host.agentPid, undefined);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("onStateChange fires after seeding and after setYolo", async () => {
  const ws = makeWorkspace();
  const { host } = makeHost(ws);
  const seen: { currentModel?: string; yolo: boolean; models: unknown[] }[] = [];
  const off = host.onStateChange((s) => seen.push(s));
  try {
    await host.start();
    const first = await waitFor(() => seen.find((s) => s.models.length > 0));
    assert.equal(first.currentModel, "mock/mock-model");
    assert.equal(first.yolo, false);
    await host.handleWebviewMessage({ type: "setYolo", enabled: true });
    assert.equal(seen[seen.length - 1].yolo, true);
  } finally {
    off();
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("login messages route to onLogin and login/open carries providers", async () => {
  const posted: ExtToWebview[] = [];
  const calls: string[] = [];
  const host = new AgentHost({
    workspaceDir: tmpdir(),
    transport: { post: (m) => posted.push(m) },
    launch: () => ({ bin: process.execPath, args: [], env: {} }),
    imageUri: (p) => p,
    loginProviders: () => [{ id: "anthropic", label: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY" }],
    onLogin: {
      apiKey: async (envVar) => void calls.push(`apiKey:${envVar}`),
      oauthStart: async () => void calls.push("oauth"),
      oauthCode: (code) => void calls.push(`code:${code}`),
      cancel: () => void calls.push("cancel"),
    },
  });
  await host.handleWebviewMessage({ type: "login" });
  const open = posted.find((m) => m.type === "login/open");
  assert.ok(open && open.type === "login/open" && open.providers[0].id === "anthropic");
  await host.handleWebviewMessage({ type: "login/apiKey", envVar: "ANTHROPIC_API_KEY", key: "sk-test" });
  await host.handleWebviewMessage({ type: "login/oauth" });
  await host.handleWebviewMessage({ type: "login/oauthCode", code: "c" });
  await host.handleWebviewMessage({ type: "login/cancel" });
  assert.deepEqual(calls, ["apiKey:ANTHROPIC_API_KEY", "oauth", "code:c", "cancel"]);
});

test("workspace/import routes to onImport", async () => {
  let imports = 0;
  const host = new AgentHost({
    workspaceDir: tmpdir(),
    transport: { post: () => {} },
    launch: () => ({ bin: process.execPath, args: [], env: {} }),
    imageUri: (p) => p,
    onImport: () => void imports++,
  });
  await host.handleWebviewMessage({ type: "workspace/import" });
  assert.equal(imports, 1);
});

async function postHttp(port: number, msg: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/message`, { method: "POST", body: JSON.stringify(msg) });
  if (!res.ok) throw new Error(`POST failed: ${res.status}`);
  await res.text();
}

test("collection message is stored and rediscoverSources re-selects all sources", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await waitFor(() => posted.some((m) => m.type === "models") || undefined);
    posted.length = 0;
    await postHttp(host.httpPort, { type: "collection", id: null, name: null, dataDir: ws });
    await waitFor(() => host.activeCollectionName === null || undefined);
    assert.equal(await host.rediscoverSources(), "rebuilt");
    assert.ok(posted.some((m) => m.type === "sources"), "picker refreshed");
    await postHttp(host.httpPort, { type: "collection", id: "parish", name: "Parish books", dataDir: ws });
    await waitFor(() => (host.activeCollectionName === "Parish books" ? true : undefined));
    assert.equal(await host.rediscoverSources(), "named-collection");
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("collections message lists manifests from collections/ with the active id", async () => {
  const ws = makeWorkspace();
  writeCollection(ws, "parish", { name: "Parish books", description: "Baptisms", members: [{ path: "TestSource" }] });
  writeFileSync(join(ws, "collections", "zz-broken.json"), "{ nope");
  writeCollection(ws, "bare", { members: [] });
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    const msg = await waitFor(() => {
      const m = posted.find((x) => x.type === "collections");
      return m && m.type === "collections" ? m : undefined;
    });
    // Sorted by display name; an unparseable manifest is skipped; name falls back to the id.
    assert.deepEqual(msg.collections, [
      { id: "parish", name: "Parish books", description: "Baptisms", memberCount: 1 },
      { id: "bare", name: "bare", description: undefined, memberCount: 0 },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    assert.equal(msg.active, null);

    // The agent announcing a collection over HTTP re-posts the picker state.
    posted.length = 0;
    await postHttp(host.httpPort, { type: "collection", id: "parish", name: "Parish books", dataDir: join(ws, "data", "_collections", "parish") });
    const after = await waitFor(() => {
      const m = posted.find((x) => x.type === "collections");
      return m && m.type === "collections" ? m : undefined;
    });
    assert.equal(after.active, "parish");
    assert.equal(host.activeCollectionId, "parish");

    // A new session falls back to the auto collection until the agent says otherwise.
    posted.length = 0;
    await host.newSession();
    const reset = posted.find((x) => x.type === "collections");
    assert.ok(reset && reset.type === "collections" && reset.active === null);
    assert.equal(host.activeCollectionId, null);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("selectCollection prompts /select-collection with the id or the all-sources sentinel", async () => {
  const ws = makeWorkspace();
  writeCollection(ws, "parish", { name: "Parish books", members: [{ path: "TestSource" }] });
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "selectCollection", id: "parish" });
    // mock-pi answers the command by announcing the collection over HTTP.
    await waitFor(() => (host.activeCollectionId === "parish" ? true : undefined));
    const picked = posted.filter((m) => m.type === "collections").pop();
    assert.ok(picked && picked.type === "collections" && picked.active === "parish");

    await host.handleWebviewMessage({ type: "selectCollection", id: null });
    await waitFor(() => (host.activeCollectionId === null ? true : undefined));
    assert.equal(host.activeCollectionName, null);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Data tab merges the active collection's files with the source's (source wins on a clash)", async () => {
  const ws = makeWorkspace();
  mkdirSync(join(ws, "data", "TestSource"), { recursive: true });
  writeFileSync(join(ws, "data", "TestSource", "rows.csv"), "from-source");
  writeFileSync(join(ws, "data", "TestSource", "shared.md"), "source copy");
  const collDir = join(ws, "data", "_collections", "parish");
  mkdirSync(collDir, { recursive: true });
  writeFileSync(join(collDir, "entities.csv"), "from-collection");
  writeFileSync(join(collDir, "shared.md"), "collection copy");
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    // Bind the source (show_page over HTTP), then activate the collection.
    await host.handleWebviewMessage({ type: "prompt", text: "select: TestSource" });
    await waitFor(() => posted.find((m) => m.type === "viewer/showPage"));
    posted.length = 0;
    await postHttp(host.httpPort, { type: "collection", id: "parish", name: "Parish books", dataDir: collDir });
    const list = await waitFor(() => {
      const m = posted.find((x) => x.type === "data/list");
      return m && m.type === "data/list" ? m : undefined;
    });
    assert.equal(list.sourceName, "TestSource");
    assert.deepEqual(list.files, ["entities.csv", "rows.csv", "shared.md"]);

    posted.length = 0;
    await host.handleWebviewMessage({ type: "data/load", filename: "entities.csv" });
    await host.handleWebviewMessage({ type: "data/load", filename: "shared.md" });
    const shown = posted.filter((m) => m.type === "data/show").map((m) => m.type === "data/show" && m.content);
    assert.deepEqual(shown, ["from-collection", "source copy"]);

    // Back on the auto collection, only the source's files are listed.
    posted.length = 0;
    await postHttp(host.httpPort, { type: "collection", id: null, name: null, dataDir: join(ws, "data") });
    const again = await waitFor(() => {
      const m = posted.find((x) => x.type === "data/list");
      return m && m.type === "data/list" ? m : undefined;
    });
    assert.deepEqual(again.files, ["rows.csv", "shared.md"]);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

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

test("collections/apply always answers, even when the batch is malformed", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.handleWebviewMessage({ type: "collections/apply", batch: { ops: null as any } });
    const m = posted.find((x) => x.type === "collections/applied");
    assert.ok(m && m.type === "collections/applied");
    assert.equal(m.result.ok, false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("shouldResync is true for success and for a partial failure, false for a clean refusal", () => {
  assert.equal(shouldResync({ ok: true }), true);
  assert.equal(shouldResync({ ok: false, error: "x", applied: 2 }), true);
  assert.equal(shouldResync({ ok: false, error: "x", applied: 0 }), false);
});
