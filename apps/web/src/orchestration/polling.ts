/**
 * Framework-agnostic polling helper — deliberately not a React hook itself,
 * so its behavior (terminal-state stop, duplicate-loop prevention, cleanup,
 * error backoff) is testable without a DOM/React test stack. `OrchestrationPanel`
 * wraps this in a small `useEffect`.
 */

export interface PollerOptions<T> {
  /** Base delay between successful polls, in ms. Default 1500. */
  intervalMs?: number;
  /** Ceiling for the exponential backoff after repeated errors, in ms. Default 15000. */
  maxIntervalMs?: number;
  /** Polling stops (without needing an explicit `stop()`) once this returns true. */
  isTerminal: (value: T) => boolean;
}

export interface Poller {
  /** No-op if already running — prevents a duplicate concurrent polling loop. */
  start(): void;
  /** Cancels any pending timer. Safe to call multiple times, and from an unmount cleanup. */
  stop(): void;
  isRunning(): boolean;
}

export function createPoller<T>(
  fetchOnce: () => Promise<T>,
  onUpdate: (value: T) => void,
  onError: (error: unknown) => void,
  options: PollerOptions<T>,
): Poller {
  const baseInterval = options.intervalMs ?? 1500;
  const maxInterval = options.maxIntervalMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let consecutiveErrors = 0;

  const scheduleNext = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const value = await fetchOnce();
      if (stopped) return; // stopped while the fetch was in flight
      consecutiveErrors = 0;
      // A recoverable error must not erase the last valid view — onUpdate
      // is only called on success, so the caller's prior state persists
      // across a transient failure below.
      onUpdate(value);
      if (options.isTerminal(value)) {
        stopped = true;
        return;
      }
      scheduleNext(baseInterval);
    } catch (error) {
      if (stopped) return;
      consecutiveErrors += 1;
      onError(error);
      const backoff = Math.min(baseInterval * 2 ** consecutiveErrors, maxInterval);
      scheduleNext(backoff);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      consecutiveErrors = 0;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isRunning() {
      return !stopped;
    },
  };
}
