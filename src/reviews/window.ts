export interface ReminderWindow {
  startHour: number;
  endHour: number;
  timeZone: string;
}

export function hourInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return raw === 24 ? 0 : raw;
}

export function dayOfWeekInTimeZone(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.indexOf(weekday);
}

export function isWeekend(date: Date, timeZone: string): boolean {
  const day = dayOfWeekInTimeZone(date, timeZone);
  return day === 0 || day === 6;
}

export function isWithinWindow(date: Date, window: ReminderWindow): boolean {
  if (isWeekend(date, window.timeZone)) return false;
  const hour = hourInTimeZone(date, window.timeZone);
  const { startHour, endHour } = window;
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}
