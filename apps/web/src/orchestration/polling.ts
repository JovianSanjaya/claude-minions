import type { OrchestrationReadModel } from "./contracts";
import type { OrchestrationApi } from "./api-port";
import { isTerminal, safeReadModel } from "./view-model";

export interface PollHandle { stop(): void }
export function retryDelay(failures: number): number { return Math.min(8_000, 700 * 2 ** Math.min(failures, 4)); }
export function pollOrchestration(api: OrchestrationApi, id: string, onValue: (value: OrchestrationReadModel) => void, onError: (error: Error) => void): PollHandle {
  let stopped = false;
  let timer: number | undefined;
  let failures = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const value = safeReadModel(await api.get(id));
      failures = 0;
      onValue(value);
      if (isTerminal(value.orchestration.status)) return;
      timer = window.setTimeout(tick, 850);
    } catch (reason) {
      failures += 1;
      onError(reason instanceof Error ? reason : new Error(String(reason)));
      timer = window.setTimeout(tick, retryDelay(failures));
    }
  };
  void tick();
  return { stop() { stopped = true; if (timer !== undefined) window.clearTimeout(timer); } };
}
