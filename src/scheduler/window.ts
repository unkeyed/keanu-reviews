/**
 * Delivery window for reminders (R9). Reminders are only *delivered* during this
 * daily window (default 05:00–14:00 America/New_York) on weekdays; a reminder that
 * comes due outside it — off-hours or on a weekend — stays pending and is delivered
 * when the window next opens. The hour and day are evaluated in the configured IANA
 * time zone, so they follow DST automatically and weekends respect that zone.
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

/** The day of week at `date` in `timeZone` (0 = Sunday … 6 = Saturday). */
export function dayOfWeekInTimeZone(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.indexOf(weekday);
}

/** True when `date` falls on Saturday or Sunday in `timeZone`. */
export function isWeekend(date: Date, timeZone: string): boolean {
  const day = dayOfWeekInTimeZone(date, timeZone);
  return day === 0 || day === 6;
}

export function isWithinWindow(date: Date, window: ReminderWindow): boolean {
  if (isWeekend(date, window.timeZone)) return false; // hold reminders over the weekend
  const hour = hourInTimeZone(date, window.timeZone);
  const { startHour, endHour } = window;
  if (startHour === endHour) return true; // degenerate: treat as always-open
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // window wraps midnight (e.g. 22→06)
}
