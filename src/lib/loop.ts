import { errMessage } from "./errors.ts";
import type { Logger } from "./logger.ts";

export interface Loop {
  /** Run now, or again as soon as the run in flight ends. */
  wake(): void;
  /** Arm no further runs and resolve once the run in flight ends. */
  stop(): Promise<void>;
}

export interface LoopSpec {
  /** Milliseconds until the next run, read each time the timer is armed. */
  delayMs: () => number;
  /** `stopping` aborts when `stop` is called, so a run can end between items. */
  run: (stopping: AbortSignal) => Promise<unknown>;
  logger: Logger;
  /** Logged at error, with the error message, when a run throws. */
  failure: string;
  /** Logged at warn when the timer fires while a run is still going. */
  overlap?: string;
}

/**
 * Run work on a timer, one run at a time. The next slot is armed before each
 * run starts, so a run that outlasts its delay skips the slots it overlaps
 * instead of stacking, and a hung run still leaves a slot on the timer. When a
 * run ends the timer is armed again from that moment.
 */
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
