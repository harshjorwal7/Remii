/**
 * Human-friendly cron building, translation and formatting helpers.
 */

export type ScheduleFrequency =
  | "weekdays"
  | "daily"
  | "weekly"
  | "hourly"
  | "custom";

export const DAYS_OF_WEEK = [
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
  { value: 0, label: "Sunday", short: "Sun" },
] as const;

export const FREQUENCY_OPTIONS = [
  { value: "weekdays", label: "Every weekday (Mon–Fri)" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Weekly on a specific day" },
  { value: "hourly", label: "Hourly" },
  { value: "custom", label: "Custom cron expression" },
] as const;

/** Format 24-hour hour and minute into friendly 12-hour string (e.g. 9:00 AM, 2:30 PM). */
export function formatTime12h(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mStr = minute.toString().padStart(2, "0");
  return `${h12}:${mStr} ${period}`;
}

/** Construct a standard 5-field cron expression from user selection. */
export function buildCronExpression({
  frequency,
  time,
  dayOfWeek = 1,
  customCron = "",
}: {
  frequency: ScheduleFrequency;
  time: string; // "HH:MM"
  dayOfWeek?: number;
  customCron?: string;
}): string {
  if (frequency === "custom") {
    return customCron.trim();
  }

  const [hourStr, minStr] = (time || "09:00").split(":");
  const hour = Number.parseInt(hourStr ?? "9", 10);
  const min = Number.parseInt(minStr ?? "0", 10);
  const validHour = Number.isNaN(hour) ? 9 : Math.min(Math.max(hour, 0), 23);
  const validMin = Number.isNaN(min) ? 0 : Math.min(Math.max(min, 0), 59);

  switch (frequency) {
    case "weekdays":
      return `${validMin} ${validHour} * * 1-5`;
    case "daily":
      return `${validMin} ${validHour} * * *`;
    case "weekly":
      return `${validMin} ${validHour} * * ${dayOfWeek}`;
    case "hourly":
      return `${validMin} * * * *`;
  }
}

/** Parse simple 5-field cron strings into human-readable English. */
export function describeCron(expression: string): string {
  const trimmed = expression.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return `Cron (${trimmed})`;
  }

  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;

  // Step minutes: */15 * * * *
  if (
    minPart?.startsWith("*/") &&
    hourPart === "*" &&
    domPart === "*" &&
    monthPart === "*" &&
    dowPart === "*"
  ) {
    const step = minPart.slice(2);
    return `Every ${step} minutes`;
  }

  // Hourly: 0 * * * * or 15 * * * *
  if (
    hourPart === "*" &&
    domPart === "*" &&
    monthPart === "*" &&
    dowPart === "*"
  ) {
    const min = Number.parseInt(minPart ?? "0", 10);
    if (!Number.isNaN(min)) {
      if (min === 0) return "Every hour at the top of the hour";
      return `Every hour at :${min.toString().padStart(2, "0")} past the hour`;
    }
  }

  const min = Number.parseInt(minPart ?? "0", 10);
  const hour = Number.parseInt(hourPart ?? "0", 10);

  if (!Number.isNaN(min) && !Number.isNaN(hour)) {
    const timeStr = formatTime12h(hour, min);

    // Weekdays: 0 9 * * 1-5 or 0 9 * * MON-FRI
    if (
      domPart === "*" &&
      monthPart === "*" &&
      (dowPart === "1-5" || dowPart?.toUpperCase() === "MON-FRI")
    ) {
      return `Every weekday at ${timeStr}`;
    }

    // Weekends: 0 9 * * 6,0 or 0 9 * * 0,6 or 0 9 * * 6,7
    if (
      domPart === "*" &&
      monthPart === "*" &&
      (dowPart === "6,0" ||
        dowPart === "0,6" ||
        dowPart === "6,7" ||
        dowPart === "SAT,SUN")
    ) {
      return `Every weekend at ${timeStr}`;
    }

    // Daily: 0 9 * * *
    if (domPart === "*" && monthPart === "*" && dowPart === "*") {
      return `Every day at ${timeStr}`;
    }

    // Specific day of week: 0 9 * * 1
    if (domPart === "*" && monthPart === "*") {
      const dowMap: Record<string, string> = {
        "0": "Sunday",
        "1": "Monday",
        "2": "Tuesday",
        "3": "Wednesday",
        "4": "Thursday",
        "5": "Friday",
        "6": "Saturday",
        "7": "Sunday",
        MON: "Monday",
        TUE: "Tuesday",
        WED: "Wednesday",
        THU: "Thursday",
        FRI: "Friday",
        SAT: "Saturday",
        SUN: "Sunday",
      };
      const dayName = dowMap[dowPart?.toUpperCase() ?? ""];
      if (dayName) {
        return `Every ${dayName} at ${timeStr}`;
      }
    }

    // Monthly: 0 9 1 * *
    if (monthPart === "*" && dowPart === "*") {
      const dom = Number.parseInt(domPart ?? "1", 10);
      if (!Number.isNaN(dom)) {
        const ordinal = getOrdinalSuffix(dom);
        return `On the ${dom}${ordinal} of every month at ${timeStr}`;
      }
    }
  }

  return `Cron: ${trimmed}`;
}

function getOrdinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/** Get the local browser timezone. */
export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
