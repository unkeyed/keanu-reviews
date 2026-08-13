/**
 * Delivery window for reminders (R9). Reminders are only *delivered* during this
 * daily window (default 05:00–14:00 America/New_York); a reminder that comes due
 * outside it stays pending and is delivered when the window next opens. The hour
 * is evaluated in the configured IANA time zone, so it follows DST automatically.
 */
export interface ReminderWindow {
  startHour: number; // inclusive, 0-23
  endHour: number; // exclusive, 0-23 (e.g. 14 = up to 13:59)
  timeZone: string; // IANA, e.g. "America/New_York"
}

/** The wall-clock hour (0-23) at `date` in `timeZone`. */
export function hourInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return raw === 24 ? 0 : raw; // some ICU builds render midnight as "24"
}

export function isWithinWindow(date: Date, window: ReminderWindow): boolean {
  const hour = hourInTimeZone(date, window.timeZone);
  const { startHour, endHour } = window;
  if (startHour === endHour) return true; // degenerate: treat as always-open
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // window wraps midnight (e.g. 22→06)
}
