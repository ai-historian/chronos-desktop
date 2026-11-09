import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { WebviewToExt } from "../../shared/webview-protocol";
import {
  diffCollections,
  sameMembers,
  slugifyCollectionId,
  type CollectionApplyResult,
  type CollectionBatch,
  type CollectionSnapshot,
  type DesiredCollection,
  type MemberRef,
} from "../../shared/collection-edit";

// The "Organize sources" dialog: a sources × collections grid of checkboxes.
// It edits a desired end state locally and, on Save, sends the diff against
// the host's snapshot as one batch. Nothing touches disk until Save. Light DOM
// so the app stylesheet applies.

const FINISH_EDIT_FIRST = "Finish or cancel the edit first";

type Editing = { kind: "new" } | { kind: "rename"; id: string } | { kind: "delete"; id: string } | null;

export class ChronosOrganizeDialog extends LitElement {
  static properties = {
    snapshot: { attribute: false },
    result: { attribute: false },
    desired: { state: true },
    editing: { state: true },
    inlineInvalid: { state: true },
    confirmDiscard: { state: true },
    saving: { state: true },
    footerError: { state: true },
    showEmpty: { state: true },
    awaitingSnapshot: { state: true },
  };

  declare snapshot: CollectionSnapshot | null;
  declare result: CollectionApplyResult | null;
  declare desired: DesiredCollection[];
  declare editing: Editing;
  /** The inline name input holds an empty or duplicate name. */
  declare inlineInvalid: boolean;
  declare confirmDiscard: boolean;
  declare saving: boolean;
  declare footerError: string;
  /** A Save was refused for empty collections: highlight the ones still empty. */
  declare showEmpty: boolean;
  /** A partial failure re-requested the snapshot: Save waits for it so landed ops are not re-sent. */
  declare awaitingSnapshot: boolean;

  /** Set by the parent: posts a message to the main process. */
  post: (msg: WebviewToExt) => void = () => {};

  /**
   * Collection ids in the first snapshot, which seeds `desired`. Later snapshots
   * (after a partial failure) keep `desired`, adding only collections created
   * on disk meanwhile; ids in here the user deleted are not brought back.
   */
  private originalIds: Set<string> | null = null;

  constructor() {
    super();
    this.snapshot = null;
    this.result = null;
    this.desired = [];
    this.editing = null;
    this.inlineInvalid = false;
    this.confirmDiscard = false;
    this.saving = false;
    this.footerError = "";
    this.showEmpty = false;
    this.awaitingSnapshot = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  get batch(): CollectionBatch {
    return this.snapshot ? diffCollections(this.snapshot.collections, this.desired) : { ops: [] };
  }

  get changeCount(): number {
    return this.batch.ops.length;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("snapshot") && this.snapshot) {
      const copy = (c: DesiredCollection) => ({ ...c, members: [...c.members] });
      if (!this.originalIds) {
        this.originalIds = new Set(this.snapshot.collections.map((c) => c.id));
        this.desired = this.snapshot.collections.map(copy);
      } else {
        const original = this.originalIds;
        const outsiders = this.snapshot.collections.filter(
          (c) => !original.has(c.id) && !this.desired.some((d) => d.id === c.id),
        );
        if (outsiders.length) this.desired = [...this.desired, ...outsiders.map(copy)];
      }
      this.awaitingSnapshot = false;
    }
    if (changed.has("editing") && !this.editing && this.footerError === FINISH_EDIT_FIRST) this.footerError = "";
    if (changed.has("result") && this.result) this.onResult(this.result);
  }

  protected updated(changed: PropertyValues<this>): void {
    // Keep focus inside the modal (on open, and when a render removed the
    // focused button) so Escape reaches its keydown handler.
    if (!this.contains(document.activeElement)) this.querySelector<HTMLElement>(".organize-dialog")?.focus();
    if (changed.has("editing") && this.editing && this.editing.kind !== "delete") {
      const input = this.querySelector<HTMLInputElement>("input.organize-inline");
      input?.focus();
      input?.select();
    }
  }

  private onResult(result: CollectionApplyResult): void {
    if (result.ok) {
      // A warning (agent not re-synced) is shown as a toast by the app.
      this.close();
      return;
    }
    this.saving = false;
    this.footerError = result.error;
    // Some ops landed: diff the next Save against what is on disk now.
    if (result.applied > 0) {
      this.awaitingSnapshot = true;
      this.post({ type: "collections/plan" });
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  /** ✕, Escape, backdrop and Cancel: ask before throwing away pending changes. */
  private requestClose(): void {
    if (this.saving) return;
    if (this.changeCount > 0) {
      this.confirmDiscard = true;
      return;
    }
    this.close();
  }

  /**
   * An empty collection the Save would write (new, or members changed). An
   * untouched empty manifest already on disk yields no op and does not block.
   */
  private blocksSave(col: DesiredCollection): boolean {
    // Members without pages don't count: the agent can't load them.
    const withPages = new Set((this.snapshot?.sources ?? []).filter((r) => r.pageCount > 0).map((r) => r.path));
    if (col.members.some((m) => withPages.has(m.path))) return false;
    const before = this.snapshot?.collections.find((c) => c.id === col.id);
    return !before || !sameMembers(before.members, col.members);
  }

  private save(): void {
    if (this.saving || this.awaitingSnapshot || this.changeCount === 0) return;
    if (this.editing) {
      this.footerError = FINISH_EDIT_FIRST;
      return;
    }
    const empty = this.desired.find((c) => this.blocksSave(c));
    if (empty) {
      this.showEmpty = true;
      this.footerError = `'${empty.name}' has no sources: tick one or delete it`;
      return;
    }
    this.showEmpty = false;
    this.footerError = "";
    this.saving = true;
    this.post({ type: "collections/apply", batch: this.batch });
  }

  // ── edits to the desired state ────────────────────────────────────────────

  private isMember(col: DesiredCollection, path: string): boolean {
    return col.members.some((m) => m.path === path);
  }

  private toggle(col: DesiredCollection, path: string, checked: boolean): void {
    let members: MemberRef[];
    if (checked) {
      // Re-ticking restores the member as the snapshot had it (keeps an explicit ref).
      const original = this.snapshot?.collections.find((c) => c.id === col.id)?.members.find((m) => m.path === path);
      members = [...col.members, original ?? { path }];
    } else {
      members = col.members.filter((m) => m.path !== path);
    }
    this.desired = this.desired.map((c) => (c.id === col.id ? { ...c, members } : c));
    this.clearResolvedEmptyError();
  }

  /** Drop the empty-collection refusal once no collection is empty any more. */
  private clearResolvedEmptyError(): void {
    if (this.showEmpty && !this.desired.some((c) => this.blocksSave(c))) {
      this.showEmpty = false;
      this.footerError = "";
    }
  }

  private startEditing(editing: Editing): void {
    this.inlineInvalid = false;
    this.editing = editing;
  }

  /** A trimmed name that is non-empty and not already used by another column, or null. */
  private validName(raw: string, exceptId?: string): string | null {
    const name = raw.trim();
    if (!name) return null;
    const lower = name.toLowerCase();
    const clash = this.desired.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === lower);
    return clash ? null : name;
  }

  private commitInline(raw: string): void {
    const editing = this.editing;
    if (!editing || editing.kind === "delete") return;
    const name = this.validName(raw, editing.kind === "rename" ? editing.id : undefined);
    if (!name) {
      this.inlineInvalid = true;
      return;
    }
    if (editing.kind === "new") {
      const taken = [...(this.snapshot?.takenIds ?? []), ...this.desired.map((c) => c.id)];
      this.desired = [...this.desired, { id: slugifyCollectionId(name, taken), name, members: [] }];
    } else {
      this.desired = this.desired.map((c) => (c.id === editing.id ? { ...c, name } : c));
    }
    this.editing = null;
  }

  private deleteColumn(id: string): void {
    this.desired = this.desired.filter((c) => c.id !== id);
    this.editing = null;
    this.clearResolvedEmptyError();
  }

  private onInlineKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.commitInline((e.target as HTMLInputElement).value);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      this.editing = null;
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    // Keep every key inside the modal: #app-root forwards keys to the page viewer.
    e.stopPropagation();
    if (e.key !== "Escape") return;
    if (this.editing) this.editing = null;
    else if (this.confirmDiscard) this.confirmDiscard = false;
    else this.requestClose();
  }

  // ── render ────────────────────────────────────────────────────────────────

  private renderInline(value: string, label: string): TemplateResult {
    const isNew = this.editing?.kind === "new";
    return html`<span class="organize-inline-wrap">
      <input
        class="dialog-input organize-inline ${this.inlineInvalid ? "is-invalid" : ""}"
        .value=${value}
        placeholder="Collection name"
        aria-label=${label}
        aria-invalid=${this.inlineInvalid ? "true" : "false"}
        autocomplete="off"
        spellcheck="false"
        @input=${() => (this.inlineInvalid = false)}
        @keydown=${this.onInlineKeydown}
      />
      <button
        class="organize-inline-ok"
        title=${isNew ? "Add this collection (Enter)" : "Apply the new name (Enter)"}
        @click=${() => this.commitInline(this.querySelector<HTMLInputElement>("input.organize-inline")?.value ?? "")}
      >
        ${isNew ? "Add" : "Rename"}
      </button>
      <button class="organize-inline-cancel" title="Cancel (Esc)" aria-label="Cancel" @click=${() => (this.editing = null)}>✕</button>
      <span class="organize-inline-hint">Enter to confirm · Esc to cancel</span>
    </span>`;
  }

  private isEmptyCol(col: DesiredCollection): boolean {
    return this.showEmpty && this.blocksSave(col);
  }

  private renderColHeader(col: DesiredCollection): TemplateResult {
    const e = this.editing;
    const cls = `organize-col ${this.isEmptyCol(col) ? "is-empty" : ""}`;
    if (e?.kind === "rename" && e.id === col.id) {
      return html`<th class=${cls}>${this.renderInline(col.name, `Rename ${col.name}`)}</th>`;
    }
    if (e?.kind === "delete" && e.id === col.id) {
      return html`<th class=${cls}>
        <div class="organize-confirm">Delete '${col.name}'? Its data and memory files stay.</div>
        <button class="btn-secondary organize-confirm-delete" @click=${() => this.deleteColumn(col.id)}>Delete</button>
        <button class="btn-secondary organize-keep" @click=${() => (this.editing = null)}>Keep</button>
      </th>`;
    }
    return html`<th class=${cls}>
      <span class="organize-col-name" title=${col.id}>${col.name}</span>
      <button
        class="organize-rename"
        title="Rename"
        aria-label="Rename ${col.name}"
        ?disabled=${this.saving}
        @click=${() => this.startEditing({ kind: "rename", id: col.id })}
      >✎</button>
      <button
        class="organize-delete"
        title="Delete"
        aria-label="Delete ${col.name}"
        ?disabled=${this.saving}
        @click=${() => this.startEditing({ kind: "delete", id: col.id })}
      >🗑</button>
    </th>`;
  }

  private renderGrid(snapshot: CollectionSnapshot): TemplateResult {
    return html`
      <div class="organize-grid">
        <table class="organize-table">
          <thead>
            <tr>
              <th class="organize-src">Source</th>
              ${this.desired.map((c) => this.renderColHeader(c))}
              <th class="organize-add">
                ${this.editing?.kind === "new"
                  ? this.renderInline("", "New collection name")
                  : html`<button
                      class="organize-add-btn"
                      ?disabled=${this.saving}
                      @click=${() => this.startEditing({ kind: "new" })}
                    >+ New collection</button>`}
              </th>
            </tr>
          </thead>
          <tbody>
            ${snapshot.sources.map(
              (row) => html`<tr>
                <td class="organize-src" title=${row.path}>
                  ${row.ref} <span class="organize-pages">${row.pageCount} p.</span>
                </td>
                ${this.desired.map(
                  (col) => html`<td class="organize-cell ${this.isEmptyCol(col) ? "is-empty" : ""}">
                    <input
                      type="checkbox"
                      aria-label="${row.ref} in ${col.name}"
                      .checked=${this.isMember(col, row.path)}
                      ?disabled=${this.saving}
                      @change=${(e: Event) => this.toggle(col, row.path, (e.target as HTMLInputElement).checked)}
                    />
                  </td>`,
                )}
                <td></td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${snapshot.sources.length === 0
          ? html`<div class="organize-hint">No sources in this workspace yet.</div>`
          : nothing}
      </div>
    `;
  }

  private renderFooter(): TemplateResult {
    const n = this.changeCount;
    const plural = n === 1 ? "change" : "changes";
    if (this.confirmDiscard) {
      return html`<div class="organize-footer">
        <span class="organize-discard">Discard ${n} unsaved ${plural}?</span>
        <div class="dialog-actions">
          <button class="btn-secondary organize-keep-editing" @click=${() => (this.confirmDiscard = false)}>Keep editing</button>
          <button class="btn-send organize-discard-btn" @click=${() => this.close()}>Discard</button>
        </div>
      </div>`;
    }
    return html`<div class="organize-footer">
      <span class="organize-dirty">${this.saving ? "Saving…" : n > 0 ? `● ${n} unsaved ${plural}` : "No changes"}</span>
      <span class="organize-error" role="alert">${this.footerError}</span>
      <div class="dialog-actions">
        <button class="btn-secondary organize-cancel" ?disabled=${this.saving} @click=${this.requestClose}>Cancel</button>
        <button class="btn-send organize-save" ?disabled=${n === 0 || this.saving || this.awaitingSnapshot} @click=${this.save}>Save</button>
      </div>
    </div>`;
  }

  render(): TemplateResult {
    return html`
      <div class="dialog-backdrop organize-backdrop" @click=${this.requestClose}></div>
      <div
        class="dialog organize-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Organize sources"
        tabindex="-1"
        @keydown=${this.onKeydown}
      >
        <div class="dialog-title">
          Organize sources
          <button class="organize-close" title="Close" aria-label="Close" ?disabled=${this.saving} @click=${this.requestClose}>✕</button>
        </div>
        ${this.snapshot ? this.renderGrid(this.snapshot) : html`<div class="organize-hint">Loading sources…</div>`}
        ${this.renderFooter()}
      </div>
    `;
  }
}

customElements.define("chronos-organize-dialog", ChronosOrganizeDialog);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-organize-dialog": ChronosOrganizeDialog;
  }
}
