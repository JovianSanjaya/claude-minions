import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "./polling";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  // let pending microtasks (the fetch promise resolution) settle
  await Promise.resolve();
  await Promise.resolve();
}

describe("createPoller", () => {
  it("polls repeatedly at the base interval until stopped", async () => {
    let calls = 0;
    const updates: number[] = [];
    const poller = createPoller<number>(
      async () => {
        calls += 1;
        return calls;
      },
      (value) => updates.push(value),
      () => undefined,
      { intervalMs: 1000, isTerminal: () => false },
    );

    poller.start();
    await flush();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(3); // no further polls after stop
    expect(updates).toEqual([1, 2, 3]);
  });

  it("stops automatically once isTerminal is reached, without needing an explicit stop()", async () => {
    let calls = 0;
    const poller = createPoller<{ status: string }>(
      async () => {
        calls += 1;
        return { status: calls >= 2 ? "completed" : "running" };
      },
      () => undefined,
      () => undefined,
      { intervalMs: 500, isTerminal: (value) => value.status === "completed" },
    );

    poller.start();
    await flush();
    expect(poller.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(poller.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2); // no poll after reaching terminal state
  });

  it("start() is a no-op while already running — never creates a duplicate loop", async () => {
    let calls = 0;
    const poller = createPoller<number>(
      async () => {
        calls += 1;
        return calls;
      },
      () => undefined,
      () => undefined,
      { intervalMs: 1000, isTerminal: () => false },
    );

    poller.start();
    poller.start();
    poller.start();
    await flush();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2); // still only one loop advancing, not three
  });

  it("backs off exponentially after repeated errors, and a recoverable error does not erase prior updates", async () => {
    let calls = 0;
    const updates: number[] = [];
    const errors: unknown[] = [];
    const poller = createPoller<number>(
      async () => {
        calls += 1;
        if (calls === 2 || calls === 3) throw new Error("transient network error");
        return calls;
      },
      (value) => updates.push(value),
      (error) => errors.push(error),
      { intervalMs: 100, maxIntervalMs: 1000, isTerminal: () => false },
    );

    poller.start();
    await flush(); // call 1: succeeds
    expect(updates).toEqual([1]);

    await vi.advanceTimersByTimeAsync(100);
    await flush(); // call 2: fails, backoff scheduled at 200ms
    expect(errors).toHaveLength(1);
    expect(updates).toEqual([1]); // last valid update is untouched by the error

    // advancing only 100ms should NOT yet trigger call 3 (backoff doubled to 200ms)
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(100);
    await flush(); // now call 3 fires (fails again)
    expect(calls).toBe(3);
    expect(errors).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(400);
    await flush(); // backoff after 2 errors: min(100*4, 1000) = 400ms
    expect(calls).toBe(4);
    expect(updates).toEqual([1, 4]); // recovered, and the stale gap was never shown as a value
  });

  it("stop() cleans up so a fetch resolving after stop never triggers an update", async () => {
    let resolveFetch: (value: number) => void = () => undefined;
    const poller = createPoller<number>(
      () => new Promise<number>((resolve) => (resolveFetch = resolve)),
      () => {
        throw new Error("must not be called after stop()");
      },
      () => undefined,
      { intervalMs: 100, isTerminal: () => false },
    );

    poller.start();
    poller.stop();
    resolveFetch(1);
    await flush();
    // no throw means onUpdate was correctly never invoked
  });
});
