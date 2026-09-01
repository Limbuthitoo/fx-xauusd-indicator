import { load } from "cheerio";
import { DateTime } from "luxon";
import ical, { type VEvent } from "node-ical";

const NEW_YORK_ZONE = "America/New_York";
const REQUEST_HEADERS = {
  accept: "text/calendar,text/html;q=0.9,*/*;q=0.8",
  "user-agent": "XAUUSDSignalCalendar/1.0 (+https://fx.bijaysubbalimbu.com.np)"
};

export const OFFICIAL_US_PROVIDER = "OFFICIAL_US";

export type OfficialCalendarEvent = {
  externalEventId: string;
  title: string;
  eventTimeUtc: string;
  sourceUpdatedAt: string | null;
  metadata: Record<string, unknown>;
};

export type OfficialCalendarSourceResult = {
  sourceCode: "BLS" | "BEA" | "CENSUS" | "FED";
  sourceUrl: string;
  fetchedAt: string;
  coverageEndAt: string;
  events: OfficialCalendarEvent[];
};

export type OfficialCalendarFetchResult = {
  successful: OfficialCalendarSourceResult[];
  failures: Array<{ sourceCode: string; sourceUrl: string; error: string }>;
};

const SOURCES = {
  BLS: "https://www.bls.gov/schedule/news_release/bls.ics",
  BEA: "https://www.bea.gov/news/schedule/full",
  CENSUS: "https://www.census.gov/economic-indicators/calendar-listview.html",
  FED: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
} as const;

export function parseBlsCalendar(body: string, fetchedAt = new Date()): OfficialCalendarSourceResult {
  const calendar = ical.sync.parseICS(body.replace(/TZID=US-Eastern/gi, "TZID=America/New_York"));
  const releases = Object.values(calendar).filter((entry): entry is VEvent => Boolean(entry && entry.type === "VEVENT" && "start" in entry && entry.start instanceof Date));
  assertScheduleRows("BLS", releases.length);
  return sourceResult("BLS", SOURCES.BLS, fetchedAt, releases.map((release) => ({
    title: String(release.summary ?? "").trim(),
    date: release.start,
    id: String(release.uid ?? "").trim()
  })), ({ title, date, id }) => {
    if (!isHighImpactBlsRelease(title)) return null;
    return officialEvent(`BLS:${id || stableId(title, date)}`, title, date, "BLS", SOURCES.BLS);
  });
}

export function parseBeaSchedule(body: string, fetchedAt = new Date()): OfficialCalendarSourceResult {
  const $ = load(body);
  const headingYear = Number($("#release-schedule-table thead th").text().match(/Year\s+(\d{4})/i)?.[1]
    ?? $("h1, h2").text().match(/Year\s+(\d{4})/i)?.[1]);
  const releases = $("#release-schedule-table tbody tr").toArray().flatMap((row) => {
    const title = $(row).find("td.release-title").text().replace(/\s+/g, " ").trim();
    const dateText = $(row).find(".release-date").text().replace(/\s+/g, " ").trim();
    const timeText = $(row).find("small.text-muted").first().text().replace(/\s+/g, " ").trim();
    const year = Number(dateText.match(/\b(20\d{2})\b/)?.[1] ?? headingYear);
    const date = parseNewYorkDate(`${dateText.replace(/,?\s*20\d{2}\b/, "")} ${year} ${timeText}`, "LLLL d yyyy h:mm a");
    return title && date ? [{ title, date, id: stableId(title, date) }] : [];
  });
  assertScheduleRows("BEA", releases.length);
  return sourceResult("BEA", SOURCES.BEA, fetchedAt, releases, ({ title, date, id }) => {
    if (!isHighImpactBeaRelease(title)) return null;
    return officialEvent(`BEA:${id}`, title, date, "BEA", SOURCES.BEA);
  });
}

export function parseCensusSchedule(body: string, fetchedAt = new Date()): OfficialCalendarSourceResult {
  const $ = load(body);
  const releases = $("#calendar tbody tr").toArray().flatMap((row) => {
    const cells = $(row).find("td");
    const title = cells.eq(0).text().replace(/\s+/g, " ").trim();
    const dateText = cells.eq(1).text().replace(/\s+/g, " ").trim();
    const timeText = cells.eq(2).text().replace(/\s+/g, " ").trim();
    const sortKey = cells.eq(1).attr("sorttable_customkey") ?? $(row).attr("data-date") ?? "";
    if (/suspended|cancelled|to be announced|tba/i.test(`${dateText} ${timeText}`)) return [];
    const date = parseNewYorkDate(`${dateText} ${timeText}`, "LLLL d, yyyy h:mm a")
      ?? parseSortKey(sortKey);
    return title && date ? [{ title, date, id: `${sortKey || date.toISOString()}:${slug(title)}` }] : [];
  });
  assertScheduleRows("CENSUS", releases.length);
  return sourceResult("CENSUS", SOURCES.CENSUS, fetchedAt, releases, ({ title, date, id }) => {
    if (!isHighImpactCensusRelease(title)) return null;
    return officialEvent(`CENSUS:${id}`, title, date, "CENSUS", SOURCES.CENSUS);
  });
}

export function parseFedSchedule(body: string, fetchedAt = new Date()): OfficialCalendarSourceResult {
  const $ = load(body);
  const releases: Array<{ title: string; date: Date; id: string }> = [];
  $(".panel").each((_, panel) => {
    const year = Number($(panel).find(".panel-heading, h2, h3").first().text().match(/(20\d{2})\s+FOMC Meetings/i)?.[1]);
    if (!Number.isFinite(year)) return;
    $(panel).find(".fomc-meeting").each((__, meeting) => {
      const month = $(meeting).find(".fomc-meeting__month strong").text().replace(/\s+/g, " ").trim();
      const dateRange = $(meeting).find(".fomc-meeting__date").text().replace(/\s+/g, " ").trim();
      const days = dateRange.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
      const decisionDay = days.at(-1);
      const date = decisionDay ? parseNewYorkDate(`${month} ${decisionDay} ${year} 2:00 PM`, "LLLL d yyyy h:mm a") : null;
      if (date) releases.push({ title: "Federal Open Market Committee statement", date, id: date.toISOString().slice(0, 10) });
    });
  });
  assertScheduleRows("FED", releases.length);
  return sourceResult("FED", SOURCES.FED, fetchedAt, releases, ({ title, date, id }) =>
    officialEvent(`FED:FOMC:${id}`, title, date, "FED", SOURCES.FED)
  );
}

export async function fetchOfficialUsCalendar(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<OfficialCalendarFetchResult> {
  const adapters = [
    ["BLS", SOURCES.BLS, parseBlsCalendar],
    ["BEA", SOURCES.BEA, parseBeaSchedule],
    ["CENSUS", SOURCES.CENSUS, parseCensusSchedule],
    ["FED", SOURCES.FED, parseFedSchedule]
  ] as const;
  const settled = await Promise.allSettled(adapters.map(async ([sourceCode, sourceUrl, parser]) => {
    const response = await fetchImpl(sourceUrl, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`${sourceCode} returned HTTP ${response.status}`);
    return parser(await response.text(), now);
  }));
  return settled.reduce<OfficialCalendarFetchResult>((result, item, index) => {
    const [sourceCode, sourceUrl] = adapters[index];
    if (item.status === "fulfilled") result.successful.push(item.value);
    else result.failures.push({ sourceCode, sourceUrl, error: errorMessage(item.reason) });
    return result;
  }, { successful: [], failures: [] });
}

function sourceResult<T extends { date: Date }>(
  sourceCode: OfficialCalendarSourceResult["sourceCode"],
  sourceUrl: string,
  fetchedAt: Date,
  releases: T[],
  normalize: (release: T) => OfficialCalendarEvent | null
): OfficialCalendarSourceResult {
  const coverageEnd = new Date(Math.max(...releases.map((release) => release.date.getTime())));
  if (!Number.isFinite(coverageEnd.getTime())) throw new Error(`${sourceCode} schedule has no valid coverage date`);
  const events = releases.map(normalize).filter((event): event is OfficialCalendarEvent => Boolean(event));
  return {
    sourceCode,
    sourceUrl,
    fetchedAt: fetchedAt.toISOString(),
    coverageEndAt: coverageEnd.toISOString(),
    events: [...new Map(events.map((event) => [event.externalEventId, event])).values()]
  };
}

function officialEvent(externalEventId: string, title: string, date: Date, sourceCode: string, sourceUrl: string): OfficialCalendarEvent {
  return {
    externalEventId,
    title,
    eventTimeUtc: date.toISOString(),
    sourceUpdatedAt: null,
    metadata: { country: "United States", sourceCode, sourceUrl, officialSource: true }
  };
}

function isHighImpactBlsRelease(title: string) {
  return /^(Employment Situation|Consumer Price Index|Producer Price Index|Job Openings and Labor Turnover Survey|Employment Cost Index)\b/i.test(title);
}

function isHighImpactBeaRelease(title: string) {
  if (/\b(by State|by County|by Industry)\b/i.test(title)) return false;
  return /^(GDP\s*\(|Gross Domestic Product\b|Personal Income and Outlays\b)/i.test(title);
}

function isHighImpactCensusRelease(title: string) {
  return /(Advance Monthly Sales for Retail and Food Services|Advance Report on Durable Goods)/i.test(title);
}

function parseNewYorkDate(value: string, format: string) {
  const parsed = DateTime.fromFormat(value.replace(/\s+/g, " ").trim(), format, { zone: NEW_YORK_ZONE, locale: "en-US" });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
}

function parseSortKey(value: string) {
  if (!/^\d{12}$/.test(value)) return null;
  return parseNewYorkDate(value, "yyyyLLddHHmm");
}

function stableId(title: string, date: Date) {
  return `${date.toISOString()}:${slug(title)}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

function assertScheduleRows(sourceCode: string, count: number) {
  if (count === 0) throw new Error(`${sourceCode} schedule contained no recognizable release rows`);
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
