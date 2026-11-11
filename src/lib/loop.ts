import { errMessage } from "./errors.ts";
import type { Logger } from "./logger.ts";

export interface Loop {
  wake(): void;
  stop(): Promise<void>;
}

export interface LoopSpec {
  delayMs: () => number;
  run: (stopping: AbortSignal) => Promise<unknown>;
  logger: Logger;
  failure: string;
  overlap?: string;
}

export function every(spec: LoopSpec): Loop {
  const stopping = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;

  const arm = (ms: number) => {
    clearTimeout(timer);
    if (stopping.signal.aborted) return;
    timer = setTimeout(fire, ms);
    timer.unref?.();
  };

  function fire(): void {
    if (stopping.signal.aborted) return;
    arm(spec.delayMs());
    if (running) {
      if (spec.overlap) spec.logger.warn(spec.overlap);
      return;
    }
    running = spec
      .run(stopping.signal)
      .then(
        () => undefined,
        (err) => spec.logger.error(spec.failure, { err: errMessage(err) }),
      )
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          arm(0);
        } else {
          arm(spec.delayMs());
        }
      });
  }

  arm(spec.delayMs());
  return {
    wake: () => {
      if (running) again = true;
      else arm(0);
    },
    stop: async () => {
      stopping.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
