/**
 * Pure revision guard for presentation event synchronization (Phase 2).
 *
 * The backend bumps a single presentation revision per logical mutation and
 * broadcasts every affected event wrapped with that revision
 * (`{ <field>, revision }`). Every production window (operator main, output,
 * stage) runs the same guard so a stale broadcast can never overwrite newer
 * live/staged/settings/lower-third/props state.
 *
 * Semantics:
 * - `apply(revision, fn)` runs `fn` only when the event is AT-OR-NEWER than
 *   the local revision. Equal revisions apply because one logical mutation
 *   bumps once and then emits several events all at the same revision (e.g.
 *   `op_apply_scene`); each event carries full sub-state, so duplicate
 *   application is idempotent.
 * - Before `open()` events are BUFFERED, never dropped.
 * - `open()` (called once the authoritative snapshot is applied) replays the
 *   buffer, skipping any event older than the snapshot revision.
 * - `applySnapshot(revision, fn)` applies a snapshot only when it is not older
 *   than state this window has already seen.
 *
 * Missing/NaN revisions are treated defensively as "apply always": they are
 * normalized to the local revision so they never advance the guard.
 */
export class PresentationSync {
  private _revision = 0;
  private _open = false;
  private buffer: Array<{ revision: number; apply: () => void }> = [];

  /** Highest revision this window has observed and applied. */
  get revision(): number {
    return this._revision;
  }

  /**
   * Buffer (pre-open) or apply (post-open) one revision-tagged event. `fn`
   * carries the full sub-state of the event and is skipped when the event is
   * older than what this window already applied.
   */
  apply(revision: number, fn: () => void): void {
    const rev = Number.isFinite(revision) ? revision : this._revision;
    if (!this._open) {
      this.buffer.push({ revision: rev, apply: fn });
      return;
    }
    if (rev < this._revision) return;
    if (rev > this._revision) this._revision = rev;
    fn();
  }

  /**
   * Apply the authoritative hydration snapshot, but only when it is not older
   * than state this window has already applied.
   */
  applySnapshot(revision: number, fn: () => void): void {
    const rev = Number.isFinite(revision) ? revision : this._revision;
    if (rev < this._revision) return;
    this._revision = rev;
    fn();
  }

  /**
   * End hydration: replay buffered events at-or-newer than the snapshot
   * revision, then let live events apply directly. Idempotent.
   */
  open(): void {
    if (this._open) return;
    for (const { revision, apply } of this.buffer) {
      if (revision >= this._revision) {
        if (revision > this._revision) this._revision = revision;
        apply();
      }
    }
    this.buffer = [];
    this._open = true;
  }
}