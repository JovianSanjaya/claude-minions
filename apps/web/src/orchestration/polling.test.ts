import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKOFF,
  createPoller,
  initialPollState,
  reducePollState,
} from "./polling";
import type { Scheduler } from "./polling";

/** Deterministic scheduler: timers only fire when the test advances them. */
class ManualScheduler implements Scheduler {
  private handle = 0;
  private readonly pending = new Map<number, { run: () => void; delayMs: number }>();

  setTimeout(run: () => void, delayMs: number): number {
    this.handle += 1;
    this.pending.set(this.handle, { run, delayMs });
    return this.handle;
  }

  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get nextDelay(): number | null {
    const first = [...this.pending.values()][0];
    return first ? first.delayMs : null;
  }

  /** Fires every currently pending timer once. */
  flush(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) entry.run();
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("poll state reducer", () => {
  it("resets the delay after a success and stops at a terminal result", () => {
    let state = initialPollState();
    state = reducePollState(state, { kind: "error" });
    expect(state.consecutiveErrors).toBe(1);
    state = reducePollState(state, { kind: "success", terminal: false });
    expect(state.consecutiveErrors).toBe(0);
    expect(state.nextDelayMs).toBe(DEFAULT_BACKOFF.intervalMs);
    expect(state.stopped).toBe(false);

    state = reducePollState(state, { kind: "success", terminal: true });
    expect(state.stopped).toBe(true);
    expect(state.stopReason).toBe("terminal");

    // A stopped poller ignores further events.
    expect(reducePollState(state, { kind: "error" })).toBe(state);
  });

  it("backs off exponentially and caps at the maximum interval", () => {
    const options = { ...DEFAULT_BACKOFF, intervalMs: 100, maxIntervalMs: 1_000, maxConsecutiveErrors: 0 };
    let state = initialPollState(options);
    const delays: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      state = reducePollState(state, { kind: "error" }, options);
      delays.push(state.nextDelayMs);
    }
    expect(delays).toEqual([200, 400, 800, 1_000, 1_000, 1_000]);
    expect(state.stopped).toBe(false);
  });

  it("gives up after the configured number of consecutive errors", () => {
    const options = { ...DEFAULT_BACKOFF, maxConsecutiveErrors: 3 };
    let state = initialPollState(options);
    state = reducePollState(state, { kind: "error" }, options);
    state = reducePollState(state, { kind: "error" }, options);
    expect(state.stopped).toBe(false);
    state = reducePollState(state, { kind: "error" }, options);
    expect(state.stopped).toBe(true);
    expect(state.stopReason).toBe("too-many-errors");
  });

  it("stops on cancel", () => {
    const state = reducePollState(initialPollState(), { kind: "cancel" });
    expect(state.stopped).toBe(true);
    expect(state.stopReason).toBe("cancelled");
  });
});

describe("poller loop", () => {
  it("polls until a terminal value and then schedules nothing", async () => {
    const scheduler = new ManualScheduler();
    const values = ["running", "running", "completed"];
    const seen: string[] = [];
    let stoppedWith: string | null = null;

    const poller = createPoller<string>({
      poll: async () => values.shift() ?? "completed",
      isTerminal: (value) => value === "completed",
      onData: (value) => seen.push(value),
      onStopped: (state) => {
        stoppedWith = state.stopReason;
      },
      scheduler,
    });

    poller.start();
    await flushMicrotasks();
    expect(seen).toEqual(["running"]);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.flush();
    await flushMicrotasks();
    scheduler.flush();
    await flushMicrotasks();

    expect(seen).toEqual(["running", "running", "completed"]);
    expect(poller.running).toBe(false);
    expect(stoppedWith).toBe("terminal");
    expect(scheduler.pendingCount).toBe(0);
  });

  it("ignores a duplicate start so an effect re-run cannot double poll", async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const poller = createPoller<number>({
      poll: async () => {
        calls += 1;
        return calls;
      },
      isTerminal: () => false,
      onData: () => undefined,
      scheduler,
    });

    poller.start();
    poller.start();
    poller.start();
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    poller.stop();
  });

  it("stops cleanly on unmount and drops a response that lands afterwards", async () => {
    const scheduler = new ManualScheduler();
    const deferred: Array<(value: string) => void> = [];
    const seen: string[] = [];

    const poller = createPoller<string>({
      poll: () =>
        new Promise<string>((resolve) => {
          deferred.push(resolve);
        }),
      isTerminal: () => false,
      onData: (value) => seen.push(value),
      scheduler,
    });

    poller.start();
    await flushMicrotasks();
    poller.stop();
    expect(poller.running).toBe(false);
    expect(scheduler.pendingCount).toBe(0);

    deferred[0]?.("late response");
    await flushMicrotasks();
    // The late response never reaches the component.
    expect(seen).toEqual([]);
  });

  it("keeps polling after a recoverable error and never clears the last value", async () => {
    const scheduler = new ManualScheduler();
    const responses: Array<() => Promise<string>> = [
      async () => "first",
      async () => {
        throw new Error("network down");
      },
      async () => "second",
    ];
    const seen: string[] = [];
    const errors: string[] = [];

    const poller = createPoller<string>({
      poll: async () => (responses.shift() ?? (async () => "second"))(),
      isTerminal: () => false,
      onData: (value) => seen.push(value),
      onError: (error) => errors.push((error as Error).message),
      options: { intervalMs: 100, backoffFactor: 3, maxIntervalMs: 5_000 },
      scheduler,
    });

    poller.start();
    await flushMicrotasks();
    expect(seen).toEqual(["first"]);
    expect(scheduler.nextDelay).toBe(100);

    scheduler.flush();
    await flushMicrotasks();
    expect(errors).toEqual(["network down"]);
    // The last valid value is untouched, and the retry is delayed.
    expect(seen).toEqual(["first"]);
    expect(scheduler.nextDelay).toBe(300);

    scheduler.flush();
    await flushMicrotasks();
    expect(seen).toEqual(["first", "second"]);
    expect(scheduler.nextDelay).toBe(100);
    poller.stop();
  });

  it("stops after too many consecutive errors", async () => {
    const scheduler = new ManualScheduler();
    let stopReason: string | null = null;
    const poller = createPoller<string>({
      poll: async () => {
        throw new Error("still down");
      },
      isTerminal: () => false,
      onData: () => undefined,
      onStopped: (state) => {
        stopReason = state.stopReason;
      },
      options: { maxConsecutiveErrors: 2 },
      scheduler,
    });

    poller.start();
    await flushMicrotasks();
    scheduler.flush();
    await flushMicrotasks();

    expect(poller.running).toBe(false);
    expect(stopReason).toBe("too-many-errors");
    expect(scheduler.pendingCount).toBe(0);
  });
});
