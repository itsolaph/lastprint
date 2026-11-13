/**
 * US equity market clock (NYSE regular session).
 *
 * Regular session: 09:30–16:00 America/New_York, Monday–Friday, excluding NYSE holidays.
 * Early close: 13:00 America/New_York on the listed days.
 *
 * Holiday and early-close tables: NYSE "Holidays & Trading Hours",
 * https://www.nyse.com/markets/hours-calendars (retrieved 2026-11-13).
 * Only 2026 and 2027 are encoded. Outside that range every function throws `CalendarRangeError`,
 * so callers fail closed (no ordering) instead of guessing.
 *
 * Shared by the keeper (Node) and the web app (browser bundle): no Node-only imports here.
 */

export const NY_TZ = 'America/New_York';

/** Full-day closures. */
export const NYSE_HOLIDAYS: ReadonlyMap<string, string> = new Map([
  // 2026
  ['2026-01-01', "New Year's Day"],
  ['2026-01-19', 'Martin Luther King, Jr. Day'],
  ['2026-02-16', "Washington's Birthday"],
  ['2026-04-03', 'Good Friday'],
  ['2026-05-25', 'Memorial Day'],
  ['2026-06-19', 'Juneteenth National Independence Day'],
  ['2026-07-03', 'Independence Day (observed)'],
  ['2026-09-07', 'Labor Day'],
  ['2026-11-26', 'Thanksgiving Day'],
  ['2026-12-25', 'Christmas Day'],
  // 2027
  ['2027-01-01', "New Year's Day"],
  ['2027-01-18', 'Martin Luther King, Jr. Day'],
  ['2027-02-15', "Washington's Birthday"],
  ['2027-03-26', 'Good Friday'],
  ['2027-05-31', 'Memorial Day'],
  ['2027-06-18', 'Juneteenth National Independence Day (observed)'],
  ['2027-07-05', 'Independence Day (observed)'],
  ['2027-09-06', 'Labor Day'],
  ['2027-11-25', 'Thanksgiving Day'],
  ['2027-12-24', 'Christmas Day (observed)'],
]);

/** 13:00 ET early closes. */
export const NYSE_EARLY_CLOSES: ReadonlyMap<string, string> = new Map([
  ['2026-11-27', 'Day after Thanksgiving'],
  ['2026-12-24', 'Christmas Eve'],
  ['2027-11-26', 'Day after Thanksgiving'],
]);

export const CALENDAR_FIRST_DAY = '2026-01-01';
export const CALENDAR_LAST_DAY = '2027-12-31';

export class CalendarRangeError extends Error {
  constructor(date: string) {
    super(`Market calendar does not cover ${date} (supported ${CALENDAR_FIRST_DAY}..${CALENDAR_LAST_DAY})`);
    this.name = 'CalendarRangeError';
  }
}

export interface Session {
  /** New York calendar date, YYYY-MM-DD. */
  date: string;
  /** Opening bell, ms since epoch. */
  open: number;
  /** Closing bell, ms since epoch. */
  close: number;
  early: boolean;
}

const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 14;

let nyFormatter: Intl.DateTimeFormat | undefined;
function formatter(): Intl.DateTimeFormat {
  nyFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return nyFormatter;
}

interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function nyParts(t: number): NyParts {
  const out: Record<string, number> = {};
  for (const p of formatter().formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** New York calendar date (YYYY-MM-DD) of instant `t`. */
export function nyDate(t: number): string {
  const p = nyParts(t);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Offset of New York from UTC at instant t, in ms (negative: EST = -5h, EDT = -4h). */
function nyOffset(t: number): number {
  const p = nyParts(t);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Instant for a New York wall-clock time. Market hours never fall in the DST gap/overlap (02:00–03:00). */
export function nyWallTimeToUtc(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const off1 = nyOffset(guess);
  let t = guess - off1;
  const off2 = nyOffset(t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + n * DAY_MS;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function assertCovered(date: string): void {
  if (date < CALENDAR_FIRST_DAY || date > CALENDAR_LAST_DAY) throw new CalendarRangeError(date);
}

export function calendarCovers(t: number): boolean {
  const d = nyDate(t);
  return d >= CALENDAR_FIRST_DAY && d <= CALENDAR_LAST_DAY;
}

/** The regular session on a New York date, or null if the market is closed all day. */
export function sessionOn(date: string): Session | null {
  assertCovered(date);
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return null;
  if (NYSE_HOLIDAYS.has(date)) return null;
  const early = NYSE_EARLY_CLOSES.has(date);
  return {
    date,
    open: nyWallTimeToUtc(date, 9, 30),
    close: early ? nyWallTimeToUtc(date, 13, 0) : nyWallTimeToUtc(date, 16, 0),
    early,
  };
}

/** True during the regular session: open <= t < close. */
export function isUsMarketOpen(t: number): boolean {
  const s = sessionOn(nyDate(t));
  return s !== null && t >= s.open && t < s.close;
}

/** The session in progress at t, if any. */
export function currentSession(t: number): Session | null {
  const s = sessionOn(nyDate(t));
  return s !== null && t >= s.open && t < s.close ? s : null;
}

/** Most recent completed session (close <= t). */
export function lastCompletedSession(t: number): Session {
  let date = nyDate(t);
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const s = sessionOn(date);
    if (s && s.close <= t) return s;
    date = addDays(date, -1);
  }
  throw new Error('no session found in scan range');
}

/** Instant of the most recent official close at or before t. */
export function lastClose(t: number): number {
  return lastCompletedSession(t).close;
}

/** Next session whose opening bell is strictly after t. */
export function nextSession(t: number): Session {
  let date = nyDate(t);
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const s = sessionOn(date);
    if (s && s.open > t) return s;
    date = addDays(date, 1);
  }
  throw new Error('no session found in scan range');
}

/** Instant of the next opening bell strictly after t. */
export function nextOpen(t: number): number {
  return nextSession(t).open;
}

/** Close of the session in progress, or of the next session if the market is shut. */
export function nextClose(t: number): number {
  return (currentSession(t) ?? nextSession(t)).close;
}

export interface MarketState {
  open: boolean;
  /** When open: the current session close. When closed: the last completed close. */
  lastClose: number;
  /** Date (NY) of the session whose close is the reference "last close". */
  lastCloseDate: string;
  nextOpen: number;
  nextClose: number;
  /** Why the market is shut right now (weekend, holiday name, overnight), when closed. */
  reason: string | null;
}

export function marketState(t: number): MarketState {
  const cur = currentSession(t);
  const last = lastCompletedSession(t);
  const next = nextSession(t);
  let reason: string | null = null;
  if (!cur) {
    const today = nyDate(t);
    const wd = weekday(today);
    if (NYSE_HOLIDAYS.has(today)) reason = NYSE_HOLIDAYS.get(today)!;
    else if (wd === 0 || wd === 6) reason = 'Weekend';
    else reason = 'Overnight';
  }
  return {
    open: cur !== null,
    lastClose: last.close,
    lastCloseDate: last.date,
    nextOpen: next.open,
    nextClose: (cur ?? next).close,
    reason,
  };
}

/**
 * The closed-market window that contains t: [last close, next open). Null while the market is open.
 * Orders are only accepted with validAfter >= start and validUntil <= end.
 */
export function closedWindow(t: number): { start: number; end: number } | null {
  if (isUsMarketOpen(t)) return null;
  return { start: lastClose(t), end: nextOpen(t) };
}
