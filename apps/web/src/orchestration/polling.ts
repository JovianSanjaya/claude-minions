/**
 * Polling helpers for the orchestration panel.
 *
 * These are deliberately framework-free so the behaviour required by
 * specification 8.8 can be tested without a DOM test stack:
 *
 *   - polling stops at a terminal state;
 *   - a second `start()` never creates a duplicate loop;
 *   - `stop()` (unmount, Agent switch) cancels the pending timer and ignores
 *     any in-flight response;
 *   - repeated network errors back off exponentially with a cap;
 *   - a recoverable error never clears the last valid data - the poller
 *     reports the error and keeps polling, and the caller keeps its state.
 */

export interface BackoffOptions {
  /** Delay between successful polls. */
  intervalMs: number;
  /** Upper bound for the error backoff delay. */
  maxIntervalMs: number;
  /** Multiplier applied per consecutive error. */
  backoffFactor: number;
  /** Stop polling after this many consecutive errors. 0 disables the cap. */
  maxConsecutiveErrors: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  intervalMs: 1_200,
  maxIntervalMs: 20_000,
  backoffFactor: 2,
  maxConsecutiveErrors: 8,
};

export interface PollState {
  consecutiveErrors: number;
  /** Delay that should be used before the next attempt. */
  nextDelayMs: number;
  /** True once the poller must not schedule another attempt. */
  stopped: boolean;
  stopReason: "terminal" | "too-many-errors" | "cancelled" | null;
}

export function initialPollState(options: BackoffOptions = DEFAULT_BACKOFF): PollState {
  return {
    consecutiveErrors: 0,
    nextDelayMs: options.intervalMs,
    stopped: false,
    stopReason: null,
  };
}

export type PollEvent =
  | { kind: "success"; terminal: boolean }
  | { kind: "error" }
  | { kind: "cancel" };

/** Pure state reducer. The loop in `createPoller` is a thin shell over this. */
export function reducePollState(
  state: PollState,
  event: PollEvent,
  options: BackoffOptions = DEFAULT_BACKOFF,
): PollState {
  if (state.stopped) return state;
  if (event.kind === "cancel") {
    return { ...state, stopped: true, stopReason: "cancelled" };
  }
  if (event.kind === "success") {
    return {
      consecutiveErrors: 0,
      nextDelayMs: options.intervalMs,
      stopped: event.terminal,
      stopReason: event.terminal ? "terminal" : null,
    };
  }
  const consecutiveErrors = state.consecutiveErrors + 1;
  const exhausted =
    options.maxConsecutiveErrors > 0 &&
    consecutiveErrors >= options.maxConsecutiveErrors;
  const delay = Math.min(
    options.maxIntervalMs,
    Math.round(options.intervalMs * Math.pow(options.backoffFactor, consecutiveErrors)),
  );
  return {
    consecutiveErrors,
    nextDelayMs: delay,
    stopped: exhausted,
    stopReason: exhausted ? "too-many-errors" : null,
  };
}

export interface Scheduler {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export const browserScheduler: Scheduler = {
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export interface PollerConfig<T> {
  /** One fetch attempt. Rejections are treated as recoverable errors. */
  poll: () => Promise<T>;
  /** Decides whether the poller has reached a terminal state. */
  isTerminal: (value: T) => boolean;
  /** Called with every successful result, including the terminal one. */
  onData: (value: T) => void;
  /** Called on a recoverable failure. The last good data must be kept. */
  onError?: (error: unknown, state: PollState) => void;
  /** Called once when polling stops for any reason. */
  onStopped?: (state: PollState) => void;
  options?: Partial<BackoffOptions>;
  scheduler?: Scheduler;
  /** Poll immediately on start instead of waiting one interval. */
  immediate?: boolean;
}

export interface Poller {
  start(): void;
  stop(): void;
  readonly running: boolean;
  readonly state: PollState;
}

export function createPoller<T>(config: PollerConfig<T>): Poller {
  const options: BackoffOptions = { ...DEFAULT_BACKOFF, ...(config.options ?? {}) };
  const scheduler = config.scheduler ?? browserScheduler;
  let state = initialPollState(options);
  let running = false;
  let timer: number | null = null;
  // Incremented on every stop so a response that lands after `stop()` is dropped.
  let generation = 0;

  const clearTimer = () => {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  };

  const finish = () => {
    running = false;
    clearTimer();
    config.onStopped?.(state);
  };

  const schedule = (delayMs: number, currentGeneration: number) => {
    clearTimer();
    timer = scheduler.setTimeout(() => {
      timer = null;
      void attempt(currentGeneration);
    }, delayMs);
  };

  const attempt = async (currentGeneration: number): Promise<void> => {
    if (!running || currentGeneration !== generation) return;
    try {
      const value = await config.poll();
      if (!running || currentGeneration !== generation) return;
      config.onData(value);
      state = reducePollState(state, { kind: "success", terminal: config.isTerminal(value) }, options);
    } catch (error) {
      if (!running || currentGeneration !== generation) return;
      state = reducePollState(state, { kind: "error" }, options);
      // The caller keeps its last valid view; only the error is surfaced.
      config.onError?.(error, state);
    }
    if (!running || currentGeneration !== generation) return;
    if (state.stopped) {
      finish();
      return;
    }
    schedule(state.nextDelayMs, currentGeneration);
  };

  return {
    start() {
      // A duplicate start is a no-op, so an effect re-run cannot double-poll.
      if (running) return;
      running = true;
      state = initialPollState(options);
      generation += 1;
      const currentGeneration = generation;
      if (config.immediate ?? true) {
        void attempt(currentGeneration);
      } else {
        schedule(options.intervalMs, currentGeneration);
      }
    },
    stop() {
      if (!running) {
        clearTimer();
        return;
      }
      generation += 1;
      state = { ...state, stopped: true, stopReason: "cancelled" };
      finish();
    },
    get running() {
      return running;
    },
    get state() {
      return state;
    },
  };
}
