# Organize sources — a grid for putting sources into collections

Date: 2026-11-06. Status: approved in conversation, ready to plan.

## Intent

Collections exist (see `agent/utils/collection-manifest.ts` and the header
picker), but the only way to make or change one is to hand-edit
`collections/<id>.json`. Historians will not do that. They want to look at
their sources, look at their collections, and tick boxes.

This adds an **Organize sources** button in the header, beside the collection
picker, that opens a modal grid: one row per source, one column per
collection, a checkbox at each intersection. New collections are created in
the same grid. Nothing is written until **Save**.

## Goals

- Put any discovered source into any number of collections, or take it out,
  by ticking boxes.
- Create a collection by name from inside the grid.
- Rename and delete collections from inside the grid.
- Batch semantics: edits accumulate in the dialog; **Save** writes everything
  at once, **Cancel** (or closing) discards everything.
- After Save the header picker and the agent's catalogue reflect the new
  state without restarting the app or the agent.

## Non-goals

- Editing per-member `meta` or the collection `description`. Both survive a
  Save untouched (see "Preserving what the grid doesn't show").
- Adding sources that live outside `sources/`. That stays the agent's
  `change_source` tool.
- Reordering members. Member order in the manifest is the row order of the
  grid (sorted source refs), which is fine.
- Importing sources from this dialog. The File ▸ Import flow is unchanged.

## Anti-goals (would make this a failure even if it "works")

- Silently losing data: a Save must never drop a manifest member, `meta`,
  or `description` the grid didn't display, and must never delete
  `data/_collections/<id>/` or memory files.
- Breaking existing sessions: the collection **id** (filename stem) is what
  `.chronos/session-collections.json` and `data/_collections/<id>/` key on.
  Rename must not change it.
- Writing half a batch. If one manifest write fails, report it; do not leave
  the user believing the whole batch landed.

## The UI

### Entry point

A `header-btn` labelled **Organize sources** rendered in `renderHeader()` of
`src/renderer/components/chronos-app.ts`, immediately after the collection
`<select>`. Unlike the picker it is shown even when there are no collections
yet (that is exactly when you need it). It only touches files, so it stays
enabled even when no provider is connected and the agent is not running.

### The dialog

A new Lit component `src/renderer/components/organize-dialog.ts`
(`<chronos-organize-dialog>`), rendered by `chronos-app` the same way
`chronos-provider-dialog` is, on top of the existing `.dialog-backdrop` /
`.dialog` styles in `src/renderer/styles.css` (new rules go under a
`.organize-*` prefix).

Layout, as agreed in the mockup:

```
┌ Organize sources ─────────────────────────────────────────── ✕ ┐
│ Source            │ frankfurt ✎🗑 │ parish-1840s ✎🗑 │ [name ↵] │ + New collection │
│ Frankfurt_1858 214p│      ☑       │        ☐         │    ☐     │                  │
│ Frankfurt_1864 230p│      ☑       │        ☐         │    ☐     │                  │
│ st-mary-1842    96p│      ☐       │        ☑         │    ☑     │                  │
│ wills/box-3     17p│      ☐       │        ☐         │    ☐     │                  │
├───────────────────────────────────────────────────────────────┤
│ ● 4 unsaved changes                          [Cancel]  [Save] │
└───────────────────────────────────────────────────────────────┘
```

- **Rows**: one per source **directory**, keyed by path, from the
  snapshot (see "Host side"): everything discovered under `sources/` plus
  any out-of-tree member some manifest names by absolute path. Each row
  shows its ref and page count, sorted by ref. A manifest member with an
  explicit `ref` that differs from the derived one is still the same row
  (same directory); its custom ref is carried through untouched. The first column is sticky on horizontal
  scroll; the header row is sticky on vertical scroll. The grid scrolls
  inside the dialog; the dialog itself is at most ~80vh × 90vw.
- **Columns**: every collection from the host's `collections` message, in
  that order (sorted by display name). Each column header shows the display
  name and two small icon buttons: rename (✎) and delete (🗑).
- **Cells**: a native `<input type="checkbox">` so keyboard and screen
  readers work for free. Checked = that source is a member.
- **+ New collection**: a dashed pill in the last header cell. Clicking it
  turns the cell into an inline text input. Enter commits (adds a column,
  all boxes unticked), Escape cancels. Empty or duplicate names are refused
  inline (the input shakes / shows red; no toast).
- **Rename**: the column header turns into the same inline input prefilled
  with the current display name. Enter commits, Escape cancels.
- **Delete**: asks inline ("Delete 'frankfurt'? Its data and memory files
  stay.") with Delete / Keep buttons in the header cell, then removes the
  column from the grid. Until Save nothing is on disk.
- **Footer**: the number of pending changes (ticks + creates + renames +
  deletes), **Cancel**, **Save**. Save is disabled when there are no
  changes.
- **Closing**: ✕, Escape, or clicking the backdrop. With pending changes
  this first asks "Discard N unsaved changes?" (Discard / Keep editing).
- **Busy state**: while a Save is in flight the buttons are disabled and
  the footer shows "Saving…". On success the dialog closes. On failure it
  stays open with the error in the footer so nothing typed is lost.

### Ids for new collections

The id (filename stem) is derived once, at creation, from the typed name:
lower-case, non `[a-z0-9_-]` runs collapsed to `-`, trimmed of leading and
trailing `-`; if the result is empty or collides with an existing id,
append `-2`, `-3`, …. The display name is stored verbatim as `name`.

Rename later changes **only** `name`. The id, and therefore the file,
`data/_collections/<id>/`, and any session selection, stay put. The grid
shows the id in a tooltip on the column header so users can see it.

## Host side

### New protocol messages (`src/shared/webview-protocol.ts`)

Renderer → host:

```ts
| { type: "collections/plan" }               // ask for the editable snapshot
| { type: "collections/apply"; batch: CollectionBatch }
```

Host → renderer:

```ts
| { type: "collections/snapshot"; snapshot: CollectionSnapshot }
| { type: "collections/applied"; result: CollectionApplyResult }
```

Types live in a new `src/shared/collection-edit.ts` so both sides share
them:

```ts
/** One source directory as a grid row. `path` is the row key: workspace-
 *  relative (`sources/<...>`) for in-tree sources, absolute for out-of-tree
 *  members found in some manifest. `ref` is the derived ref shown in the UI. */
export interface SourceRow { path: string; ref: string; pageCount: number; outOfTree: boolean }

/** A membership. `ref` is present only when the manifest carries an explicit
 *  ref that differs from the derived one; it is written back verbatim. */
export interface MemberRef { path: string; ref?: string }

export interface CollectionSnapshot {
  sources: SourceRow[];
  collections: { id: string; name: string; members: MemberRef[] }[];
}

export type CollectionOp =
  | { op: "create"; id: string; name: string; members: MemberRef[] }
  | { op: "rename"; id: string; name: string }
  | { op: "delete"; id: string }
  | { op: "setMembers"; id: string; members: MemberRef[] };

export interface CollectionBatch { ops: CollectionOp[] }

export type CollectionApplyResult =
  | { ok: true; warning?: string }           // all written; warning = agent could not re-sync
  | { ok: false; error: string; applied: number }; // ops[0..applied) landed, the rest did not
```

The dialog is built from `collections/snapshot`, not from the lighter
`collections` header message, because it needs members and the header
message only carries counts. The snapshot is requested when the dialog
opens, so it always reflects the disk at that moment.

**Rows are keyed by directory path, not by ref.** A ref is derived from the
path for in-tree sources and is the basename for out-of-tree ones, so two
out-of-tree directories can share a ref; the path is the only safe key. A
manifest member may also carry an explicit `ref` that differs from the
derived one; the grid never shows two rows for one directory, and that
custom ref rides along in `MemberRef.ref` so a Save writes it back
unchanged.

**The dialog holds a desired end state, not a list of edits.** It keeps
`collections[]` (id, name, members) as the user wants them; the batch sent
on Save is the diff between the snapshot it loaded and that end state. This
is what makes retries safe (see "Outcomes of apply").

### Manifest editing module (`src/main/collection-edit.ts`)

Pure Node, no Electron, unit-testable. Responsibilities:

- `readSnapshot(workspaceDir)`: `discoverSources` + every manifest in
  `collections/`. Each member is normalised to `{ path, ref? }`: the path
  made workspace-relative when it lies under `sources/`, left absolute
  otherwise; the derived ref computed with `deriveRef` from
  `src/main/data-key.ts`; `ref` kept only if the manifest's explicit ref
  differs from the derived one. Out-of-tree members become `SourceRow`s
  with `outOfTree: true` (page count via `countPages`) so they show up and
  stay editable. Members whose directory has no `png/` are still listed
  (the agent skips them with a warning; the grid should not lose them).
- `applyBatch(workspaceDir, batch)`: validates the whole batch first
  (ids are safe filename stems, create ids don't exist, rename/delete/
  setMembers ids do exist, every member path is a known row, **no create
  or setMembers leaves a collection with zero members**), then writes.
  - Each written manifest is produced by **loading the existing JSON,
    changing only what the op touches, and writing it back**. `description`
    and every member's `meta` survive. A member's `path` is written
    workspace-relative (`sources/<ref>`) for in-tree sources and left as
    it was for out-of-tree ones; the `ref` field is written only when it
    differs from the derived ref.
  - Writes are atomic per file (write `<id>.json.tmp`, rename over).
  - `delete` unlinks `collections/<id>.json` and nothing else.
  - Returns a `CollectionApplyResult`. Validation failures apply nothing
    (`applied: 0`). A write failure mid-batch reports which op failed and
    how many landed before it.

**Empty collections are refused.** The agent's `loadCollection` returns
null for a manifest with no resolvable members, so an empty collection is
un-selectable and the re-sync in step 4 would silently fail. The dialog
therefore refuses Save while any collection has no ticked source, with the
offending column highlighted and a footer message ("'baptisms' has no
sources: tick one or delete it"), and `applyBatch` enforces the same rule
as a validation error. Creating a column and then ticking nothing is fine
until you press Save.

### Wiring in `AgentHost` (`src/main/agent-host.ts`)

- `collections/plan` → `readSnapshot` → post `collections/snapshot`.
- `collections/apply` →
  1. If `isStreaming`: reply `applied ok:false error:"The agent is
     mid-answer; try again when it finishes."` and apply nothing. (Same
     reasoning as `rediscoverSources`: the catalogue can't be swapped under
     a running turn.)
  2. `applyBatch`.
  3. `postCollections()` (refreshes the header picker from disk).
  4. If the agent is running, re-sync its catalogue with **one** prompt:
     - active collection is a named one that still exists →
       `/select-collection <id>` (its membership may have changed);
     - active collection was deleted → `/select-collection (all sources)`
       (the picker falls back to "All sources");
     - active is "all sources" → nothing, its membership can't change here.
  5. Reply `collections/applied` with the result.

The re-select costs one agent turn, exactly like picking a collection in
the header does today; the user already accepted that.

### Outcomes of apply (what the dialog does with the result)

- `ok: true`, no warning: close the dialog.
- `ok: true` with `warning` (manifests written but the agent could not be
  re-synced, e.g. it exited between the `isStreaming` check and the
  prompt): close the dialog and show the warning as a toast. The disk is
  right; the agent will pick it up on its next session start.
- `ok: false`, `applied: 0` (validation or the streaming refusal): stay
  open, show the error in the footer, keep everything the user typed.
- `ok: false`, `applied > 0` (a write failed mid-batch): stay open, show
  the error, **re-request the snapshot** and keep the desired end state;
  the next Save diffs against the fresh snapshot, so ops that already
  landed are not re-sent and a `create` never collides with itself.

### Tests

- `test/collection-edit.test.ts` (node:test): snapshot resolves refs and
  out-of-tree members; create/rename/delete/setMembers each produce the
  expected JSON; `description` and `meta` survive a `setMembers`; atomic
  write leaves no `.tmp`; validation rejects unknown ids, bad ids, unknown
  refs, and applies nothing on rejection; mid-batch failure reports the op.
- `test/agent-host.test.ts`: `collections/apply` while streaming is refused;
  after apply the host posts `collections` and sends the right
  `/select-collection` prompt (or none) for each of the three active cases.
- `test/e2e/boot.spec.ts`: open the dialog, create a collection, tick a
  source, Save, assert the manifest on disk and the new option in the picker.

## Preserving what the grid doesn't show

A manifest can carry `description`, per-member `meta`, explicit `ref`
fields, and absolute paths. The grid displays none of these. The rule for
every write is **read-modify-write of the existing file**; the grid never
regenerates a manifest from its own state alone. Out-of-tree members appear
as rows so their membership is still editable.

## Left to the builder

- Exact CSS. Reuse `.dialog-backdrop`/`.dialog`; the grid, sticky headers,
  inline inputs and the dashed "+ New collection" pill are new.
- How the pending-change count is computed (diff against the snapshot is
  simplest and makes "no changes" exact after undoing a tick).
- Whether the ✎/🗑 icons are glyphs or inline SVG (match what the header
  already does).
- Keyboard: Tab order through checkboxes is native; Enter/Escape on the
  inline inputs as above.

## Calls I made (user can veto while reading)

1. Rename changes the display name only; the id/file stays.
2. Delete removes the manifest only; collection data and memory stay.
3. Closing with pending changes asks before discarding.
4. Save is refused while the agent is mid-answer, with the reason shown.
5. Out-of-tree members (absolute paths) appear as extra rows.
6. New-collection ids are slugged from the name with `-2`, `-3` suffixes on
   collision.
7. The dialog has its own snapshot message rather than fattening the
   `collections` header message.
8. Empty collections are refused at Save (the agent cannot load them), in
   the dialog and in the host's validation.
9. Rows are keyed by directory path; custom manifest refs are preserved
   but not editable.
10. Apply reports three outcomes (done / done-but-agent-not-resynced /
    failed-after-N-ops); the dialog keeps a desired end state and re-diffs
    against a fresh snapshot after a partial failure.
