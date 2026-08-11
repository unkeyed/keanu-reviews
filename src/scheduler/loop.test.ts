import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.ts";
import { startReminderLoop } from "./loop.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("startReminderLoop", () => {
  it("does not overlap scans and stops scheduling new work", async () => {
    vi.useFakeTimers();
    let finishScan: (() => void) | undefined;
    const processDue = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishScan = () => resolve(1);
        }),
    );
    const loop = startReminderLoop(processDue, 10, createLogger("error"));

    await vi.advanceTimersByTimeAsync(30);
    expect(processDue).toHaveBeenCalledTimes(1);

    finishScan?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(processDue).toHaveBeenCalledTimes(2);

    loop.stop();
    finishScan?.();
    await vi.advanceTimersByTimeAsync(30);
    expect(processDue).toHaveBeenCalledTimes(2);
  });
});
