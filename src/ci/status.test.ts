import { describe, expect, it } from "vitest";
import { type CiCheckRun, classifyCiReadiness } from "./status.ts";

const run = (over: Partial<CiCheckRun> & Pick<CiCheckRun, "name" | "status">): CiCheckRun => ({
  conclusion: null,
  ...over,
});

describe("classifyCiReadiness", () => {
  it("is absent when the commit has no check runs", () => {
    expect(classifyCiReadiness([])).toBe("absent");
  });

  it("waits while any latest check is still in progress", () => {
    expect(
      classifyCiReadiness([
        run({ name: "test", status: "completed", conclusion: "failure" }),
        run({ name: "lint", status: "in_progress" }),
      ]),
    ).toBe("pending");
  });

  it("fails when the latest run for a check failed", () => {
    expect(
      classifyCiReadiness([run({ name: "test", status: "completed", conclusion: "failure" })]),
    ).toBe("failing");
  });

  it("ignores an older failure once the same check has been rerun green", () => {
    expect(
      classifyCiReadiness([
        run({
          name: "test",
          status: "completed",
          conclusion: "failure",
          completedAt: "2026-08-11T12:00:00Z",
        }),
        run({
          name: "test",
          status: "completed",
          conclusion: "success",
          completedAt: "2026-08-11T12:05:00Z",
        }),
      ]),
    ).toBe("passing");
  });

  it("passes when every latest run succeeded, including skipped and neutral", () => {
    expect(
      classifyCiReadiness([
        run({ name: "test", status: "completed", conclusion: "success" }),
        run({ name: "optional", status: "completed", conclusion: "skipped" }),
        run({ name: "note", status: "completed", conclusion: "neutral" }),
      ]),
    ).toBe("passing");
  });

  it("does not let a cancelled sibling block a successful run", () => {
    expect(
      classifyCiReadiness([
        run({ name: "test", status: "completed", conclusion: "success" }),
        run({ name: "lint", status: "completed", conclusion: "cancelled" }),
      ]),
    ).toBe("passing");
  });

  it("fails when every latest run was cancelled", () => {
    expect(
      classifyCiReadiness([run({ name: "test", status: "completed", conclusion: "cancelled" })]),
    ).toBe("failing");
  });
});
