/** When a scheduled automation should fire. Mirrors `Schedule` in the Mac app. */
export type Schedule =
  | { kind: "interval"; minutes: number }
  /** `time` is "HH:MM" in the Mac's timezone; `days` are 0 (Sunday) to 6, empty meaning every day. */
  | { kind: "daily"; time: string; days: number[] };

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(at: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The instant at which clocks in `timeZone` read the given wall time. */
function zonedToUtc(p: LocalParts, timeZone: string): number {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Find the zone's offset near that time, then once more in case the first
  // guess landed on the other side of a daylight-saving change.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const seen = localParts(guess, timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess = wall - (seenAsUtc - guess);
  }
  return guess;
}

/** The first time the schedule fires strictly after `after` (ms since epoch). */
export function nextFire(schedule: Schedule, after: number, timeZone: string): number {
  if (schedule.kind === "interval") {
    return after + Math.max(1, schedule.minutes) * 60_000;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = localParts(after, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    // Date.UTC normalises day overflow, giving the calendar date `offset` days on.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const candidate = zonedToUtc(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute },
      timeZone,
    );
    const allowed = schedule.days.length === 0 || schedule.days.includes(date.getUTCDay());
    if (allowed && candidate > after) return candidate;
  }
  return after + 24 * 60 * 60_000;
}
