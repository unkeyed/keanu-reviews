import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_ENV } from "./testing/context.ts";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

interface Run {
  code: number | null;
  lines: { level: string; msg: string; [field: string]: unknown }[];
}

/** Boot the service with no reachable database, run `inject` after it listens, and wait for exit. */
function boot(inject: string): Promise<Run> {
  const preload = `data:text/javascript,${encodeURIComponent(
    `setTimeout(() => { ${inject} }, 500);`,
  )}`;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--import", preload, ENTRY],
    {
      env: {
        PATH: process.env.PATH,
        ...TEST_ENV,
        DATABASE_URL: "postgres://user:pass@127.0.0.1:1/db",
        PORT: String(40_000 + Math.floor(Math.random() * 20_000)),
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      const lines = [output.stdout, output.stderr]
        .flatMap((text) => text.split("\n"))
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      resolve({ code, lines });
    });
  });
}

describe("process guards", () => {
  it("logs an unhandled rejection, drains and exits 1", async () => {
    const run = await boot(`Promise.reject(new Error("boom from a stray promise"));`);

    expect(run.code).toBe(1);
    expect(run.lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "unhandled rejection",
        err: "boom from a stray promise",
        service: "keanu-reviews",
      }),
    );
    expect(run.lines).toContainEqual(
      expect.objectContaining({ msg: "shutting down", signal: "unhandled rejection" }),
    );
  }, 30_000);

  it("logs an uncaught exception, drains and exits 1", async () => {
    const run = await boot(`throw new Error("boom from a timer");`);

    expect(run.code).toBe(1);
    expect(run.lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "uncaught exception",
        err: "boom from a timer",
      }),
    );
    expect(run.lines).toContainEqual(
      expect.objectContaining({ msg: "shutting down", signal: "uncaught exception" }),
    );
  }, 30_000);

  it("still exits 0 on SIGTERM", async () => {
    const run = await boot(`process.kill(process.pid, "SIGTERM");`);

    expect(run.code).toBe(0);
    expect(run.lines).toContainEqual(
      expect.objectContaining({ msg: "shutting down", signal: "SIGTERM" }),
    );
    expect(run.lines.map((line) => line.msg)).toContain("service listening");
  }, 30_000);
});
