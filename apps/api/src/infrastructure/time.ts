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

type NewYorkTimeParts = {
  date: string;
  weekday: string;
  minutes: number;
};

function newYorkTimeParts(value: string | Date): NewYorkTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    weekday: lookup.weekday,
    minutes: Number(lookup.hour) * 60 + Number(lookup.minute)
  };
}

export function isXauUsdTradableCandle(symbol: string, timestamp: string | Date) {
  if (symbol.replace("/", "").toUpperCase() !== "XAUUSD") return true;
  const { weekday, minutes } = newYorkTimeParts(timestamp);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return minutes >= 18 * 60;
  if (weekday === "Fri") return minutes < 17 * 60;

  // Twelve Data labels the partially tradable reopening bucket at 18:00 New York.
  return minutes < 17 * 60 || minutes >= 18 * 60;
}

export function xauUsdDailyMarketClose(value: string | Date) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  let date = newYorkTimeParts(instant).date;
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = shiftIsoDate(date, offset);
    const candidate = zonedDateTimeToUtc(candidateDate, "17:00", "America/New_York");
    const weekday = newYorkTimeParts(candidate).weekday;
    if (!["Sat", "Sun"].includes(weekday) && candidate > instant) return candidate;
  }
  return null;
}

export function candleReachesXauUsdDailyClose(symbol: string, timestamp: string | Date, timeframeMinutes: number) {
  if (symbol.replace("/", "").toUpperCase() !== "XAUUSD") return false;
  const start = new Date(timestamp);
  const close = xauUsdDailyMarketClose(start);
  if (!close || !Number.isFinite(start.getTime())) return false;
  const end = new Date(start.getTime() + Math.max(1, timeframeMinutes) * 60_000);
  return start < close && end >= close;
}

export function zonedDateTimeToUtc(date: string, hhmm: string, timeZone: string) {
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

function shiftIsoDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
