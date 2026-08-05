export function sessionTimesForDate(sessionDate: string, sessionStart: string, openingRangeMinutes: number, tradeWindowEnd: string) {
  const start = zonedDateTimeToUtc(sessionDate, sessionStart, "America/New_York");
  const openingRangeEnd = new Date(start.getTime() + openingRangeMinutes * 60_000);
  let signalWindowEnd = zonedDateTimeToUtc(sessionDate, tradeWindowEnd, "America/New_York");
  if (signalWindowEnd <= start) {
    signalWindowEnd = new Date(signalWindowEnd.getTime() + 24 * 60 * 60_000);
  }
  return {
    sessionStartAt: start.toISOString(),
    openingRangeEndAt: openingRangeEnd.toISOString(),
    signalWindowEndAt: signalWindowEnd.toISOString()
  };
}

export function clocks() {
  const now = new Date();
  return {
    utc: now.toISOString(),
    newYork: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(now),
    nepal: new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kathmandu",
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(now)
  };
}

export function newYorkDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function zonedDateTimeToUtc(date: string, hhmm: string, timeZone: string) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const utcGuess = new Date(`${date}T${hhmm}:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(utcGuess);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day), Number(lookup.hour), Number(lookup.minute), Number(lookup.second));
  const wantedAsUtc = Date.UTC(...date.split("-").map(Number).map((value, index) => (index === 1 ? value - 1 : value)) as [number, number, number], hour, minute, 0);
  return new Date(utcGuess.getTime() + (wantedAsUtc - zonedAsUtc));
}
