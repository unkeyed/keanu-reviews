import { afterEach, describe, expect, it, vi } from "vitest";
import { millisecondsUntilUtcHour } from "../app/background.ts";
import { type Logger, createLogger } from "./logger.ts";
import { every } from "./loop.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function captureLogger(): { logger: Logger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warns.push(msg),
    error: (msg) => errors.push(msg),
    child: () => logger,
  };
  return { logger, warns, errors };
}

function heldRuns() {
  let finish: (() => void) | undefined;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return { run, finish: () => finish?.() };
}

describe("every (reminder scan)", () => {
  const scanLoop = (run: () => Promise<unknown>, logger = createLogger("error")) =>
    every({ delayMs: () => 10, run, logger, failure: "reminder scan failed" });

  it("does not overlap scans and stops scheduling new work", async () => {
    vi.useFakeTimers();
    const { run, finish } = heldRuns();
    const loop = scanLoop(run);

    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);

    loop.stop();
    finish();
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stop resolves only after the in-flight scan finishes", async () => {
    vi.useFakeTimers();
    const { run, finish } = heldRuns();
    const loop = scanLoop(run);
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("logs a failed scan and keeps scanning", async () => {
    vi.useFakeTimers();
    const { logger, errors } = captureLogger();
    const run = vi.fn(async () => {
      throw new Error("db down");
    });
    const loop = scanLoop(run, logger);

    await vi.advanceTimersByTimeAsync(20);
    expect(errors).toEqual(["reminder scan failed", "reminder scan failed"]);
    await loop.stop();
  });
});

describe("every (daily task)", () => {
  const dailyLoop = (run: () => Promise<unknown>, logger: Logger) =>
    every({
      delayMs: () => millisecondsUntilUtcHour(new Date(), 8),
      run,
      logger,
      failure: "daily task failed",
      overlap: "daily task still running; skipping overlapping slot",
    });

  it("runs once per day at the UTC hour and skips a slot that overlaps a live run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    const { run, finish } = heldRuns();
    const { logger, warns } = captureLogger();
    const loop = dailyLoop(run, logger);

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warns).toContain("daily task still running; skipping overlapping slot");

    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);

    loop.stop();
    finish();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stop waits for the daily task in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T07:59:59.000Z"));
    const { run, finish } = heldRuns();
    const loop = dailyLoop(run, captureLogger().logger);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});
