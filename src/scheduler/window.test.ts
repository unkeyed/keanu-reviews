import { describe, expect, it } from "vitest";
import {
  type ReminderWindow,
  dayOfWeekInTimeZone,
  hourInTimeZone,
  isWeekend,
  isWithinWindow,
} from "./window.ts";

const EASTERN: ReminderWindow = { startHour: 5, endHour: 14, timeZone: "America/New_York" };

// 2026-08-13T13:00:00Z == 09:00 America/New_York (EDT, UTC-4) -> inside 5–14.
const at = (iso: string) => new Date(iso);

describe("reminder delivery window", () => {
  it("evaluates the hour in the configured time zone (DST-aware)", () => {
    expect(hourInTimeZone(at("2026-08-13T13:00:00Z"), "America/New_York")).toBe(9); // EDT
    expect(hourInTimeZone(at("2026-01-13T13:00:00Z"), "America/New_York")).toBe(8); // EST
  });

  it("is inside the window during Eastern business hours", () => {
    expect(isWithinWindow(at("2026-08-13T13:00:00Z"), EASTERN)).toBe(true); // 09:00 ET
    expect(isWithinWindow(at("2026-08-13T09:00:00Z"), EASTERN)).toBe(true); // 05:00 ET (start, inclusive)
  });

  it("is outside the window before 5am and at/after 2pm Eastern", () => {
    expect(isWithinWindow(at("2026-08-13T08:00:00Z"), EASTERN)).toBe(false); // 04:00 ET
    expect(isWithinWindow(at("2026-08-13T18:00:00Z"), EASTERN)).toBe(false); // 14:00 ET (end, exclusive)
    expect(isWithinWindow(at("2026-08-13T04:00:00Z"), EASTERN)).toBe(false); // 00:00 ET
  });

  it("supports a window that wraps midnight", () => {
    const overnight: ReminderWindow = { startHour: 22, endHour: 6, timeZone: "UTC" };
    expect(isWithinWindow(at("2026-08-13T23:00:00Z"), overnight)).toBe(true);
    expect(isWithinWindow(at("2026-08-13T03:00:00Z"), overnight)).toBe(true);
    expect(isWithinWindow(at("2026-08-13T12:00:00Z"), overnight)).toBe(false);
  });

  it("is closed on weekends even during business hours", () => {
    // 2026-08-15 is Saturday, 2026-08-16 is Sunday.
    expect(isWithinWindow(at("2026-08-15T13:00:00Z"), EASTERN)).toBe(false); // Sat 09:00 ET
    expect(isWithinWindow(at("2026-08-16T13:00:00Z"), EASTERN)).toBe(false); // Sun 09:00 ET
  });

  it("evaluates weekend membership in the configured time zone", () => {
    // 2026-08-16T03:00:00Z is 23:00 ET on Saturday -> weekend in Eastern.
    expect(isWeekend(at("2026-08-16T03:00:00Z"), "America/New_York")).toBe(true);
    // 2026-08-17T02:00:00Z is 22:00 ET on Sunday -> still weekend in Eastern.
    expect(isWeekend(at("2026-08-17T02:00:00Z"), "America/New_York")).toBe(true);
    // Same instant is already Monday in UTC.
    expect(isWeekend(at("2026-08-17T02:00:00Z"), "UTC")).toBe(false);
  });

  it("maps days of the week in the configured time zone", () => {
    expect(dayOfWeekInTimeZone(at("2026-08-13T13:00:00Z"), "America/New_York")).toBe(4); // Thursday
    expect(dayOfWeekInTimeZone(at("2026-08-15T13:00:00Z"), "America/New_York")).toBe(6); // Saturday
    expect(dayOfWeekInTimeZone(at("2026-08-16T13:00:00Z"), "America/New_York")).toBe(0); // Sunday
  });
});
