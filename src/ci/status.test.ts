import { describe, expect, it } from "vitest";
import { type CiSnapshot, classifyCiReadiness } from "./status.ts";

const empty = (): CiSnapshot => ({
  checkRuns: [],
  checkSuites: [],
  commitStatus: { state: "pending", count: 0 },
});

describe("classifyCiReadiness", () => {
  it("is absent when the commit has no checks and no commit statuses", () => {
    expect(classifyCiReadiness(empty())).toBe("absent");
  });

  it("waits while any check run or suite is still in progress", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [
          { name: "test", status: "completed", conclusion: "failure" },
          { name: "lint", status: "in_progress", conclusion: null },
        ],
      }),
    ).toBe("pending");
    expect(
      classifyCiReadiness({
        ...empty(),
        checkSuites: [{ status: "queued" }],
      }),
    ).toBe("pending");
  });

  it("waits on a pending commit status that actually has contexts", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
        commitStatus: { state: "pending", count: 1 },
      }),
    ).toBe("pending");
  });

  it("fails when the latest run for a check failed", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("failing");
  });

  it("ignores an older failure once the same check has been rerun green", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [
          {
            name: "test",
            status: "completed",
            conclusion: "failure",
            completedAt: "2026-08-11T12:00:00Z",
          },
          {
            name: "test",
            status: "completed",
            conclusion: "success",
            completedAt: "2026-08-11T12:05:00Z",
          },
        ],
      }),
    ).toBe("passing");
  });

  it("passes when every latest run succeeded, including skipped and neutral", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [
          { name: "test", status: "completed", conclusion: "success" },
          { name: "optional", status: "completed", conclusion: "skipped" },
          { name: "note", status: "completed", conclusion: "neutral" },
        ],
        checkSuites: [{ status: "completed" }],
        commitStatus: { state: "success", count: 1 },
      }),
    ).toBe("passing");
  });

  it("does not let a cancelled sibling block a successful run", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [
          { name: "test", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "cancelled" },
        ],
      }),
    ).toBe("passing");
  });

  it("fails when every latest run was cancelled", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        checkRuns: [{ name: "test", status: "completed", conclusion: "cancelled" }],
        checkSuites: [{ status: "completed" }],
      }),
    ).toBe("failing");
  });

  it("fails on a failing legacy commit status", () => {
    expect(
      classifyCiReadiness({
        ...empty(),
        commitStatus: { state: "error", count: 2 },
      }),
    ).toBe("failing");
  });
});
