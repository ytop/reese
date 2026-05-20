/**
 * Tiny serialized job queue with per-key debounce.
 *
 * - `schedule(key, fn, debounceMs)` collapses repeated schedules for the same
 *   key within the debounce window into a single trailing run. Each subsequent
 *   call extends the timer (trailing-debounce semantics).
 * - All actually-runnable jobs (across all keys) execute serially through a
 *   single mutex chain, so we never have N consolidation calls hitting the
 *   LLM at once when N sessions burst at the same time.
 *
 * Used to keep memory consolidation off the user-facing request path and
 * prevent runaway parallel LLM traffic.
 */
export class BackgroundQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Latest scheduled job per key — newer schedules replace older ones. */
  private pending = new Map<string, () => Promise<void>>();
  /** Serial execution chain across all keys. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * Schedule `fn` for the given `key` after `debounceMs`. If another schedule
   * for the same key arrives before the timer fires, the timer resets and the
   * newer `fn` wins.
   */
  schedule(key: string, fn: () => Promise<void>, debounceMs: number): void {
    this.pending.set(key, fn);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const job = this.pending.get(key);
      if (!job) return;
      this.pending.delete(key);
      // Append to the serial chain — failures are absorbed so one bad job
      // doesn't poison subsequent ones.
      this.chain = this.chain.then(() => job().catch((err) => {
        console.error(`[BackgroundQueue] job ${key} failed:`, err);
      }));
    }, debounceMs);
    this.timers.set(key, timer);
  }

  /** Cancel any pending job for `key`. */
  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.pending.delete(key);
  }

  /** Cancel everything — best-effort cleanup on shutdown. */
  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }
}
