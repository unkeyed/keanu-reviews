import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { millisecondsUntilUtcHour, startDailyLoop } from "./dailyLoop.ts";

function captureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warns.push(msg),
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("millisecondsUntilUtcHour", () => {
  it("waits until the next occurrence, including across a month boundary", () => {
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T07:59:59.000Z"), 8)).toBe(1000);
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T08:00:00.000Z"), 8)).toBe(
      24 * 60 * 60_000,
    );
    expect(millisecondsUntilUtcHour(new Date("2026-10-31T09:00:00.000Z"), 8)).toBe(
      23 * 60 * 60_000,
    );
  });
});

describe("startDailyLoop", () => {
  it("runs once per day at the UTC hour and skips a slot that overlaps a live run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    let release: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { logger, warns } = captureLogger();
    const loop = startDailyLoop(task, 8, logger, () => new Date());

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(warns).toContain("daily task still running; skipping overlapping slot");

    release?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(task).toHaveBeenCalledTimes(2);

    loop.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
