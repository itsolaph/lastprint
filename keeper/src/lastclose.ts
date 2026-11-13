/**
 * Official close per ticker for the most recent completed session.
 *
 * Sources (free, keyless), evaluated 2026-11-13:
 *   - Yahoo Finance chart API (primary): https://query1.finance.yahoo.com/v8/finance/chart/<T>?range=10d&interval=1d
 *     Daily bars keyed by session-open timestamp; `close` is the consolidated official close.
 *   - Nasdaq.com historical API (fallback): https://api.nasdaq.com/api/quote/<T>/historical?assetclass=stocks
 *     Rows "MM/DD/YYYY" with "Close/Last" as "$166.19".
 *   - Stooq CSV was evaluated and rejected: it now serves a JavaScript proof-of-work page to scripts.
 * Both are unofficial endpoints without an SLA: the value is shown with its source and fetch time in the
 * UI, and it is only an offchain reference — the signed order carries an absolute minAmountOut.
 */
import { lastCompletedSession, nyDate, type Session } from './shared/market-clock.ts';
import { parseDecimal } from './shared/pricing.ts';
import type { Store } from './db.ts';

export interface CloseQuote {
  ticker: string;
  sessionDate: string;
  closeE8: bigint;
  source: 'yahoo' | 'nasdaq';
  fetchedAt: number;
  /** False within FINAL_AFTER_MS of the closing bell: data vendors may still show the last trade. */
  final: boolean;
}

/** A close fetched this long after the bell is treated as the settled official close. */
export const FINAL_AFTER_MS = 30 * 60_000;
const UA = 'Mozilla/5.0 (compatible; lastprint-keeper/0.1)';

/** Round a float price to 4 dp and convert to E8 without binary-float artefacts. */
export function floatToE8(v: number): bigint {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`bad price ${v}`);
  return parseDecimal(v.toFixed(4), 8);
}

export function parseYahooChart(json: unknown, sessionDate: string): bigint | null {
  const r = (json as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> } })
    ?.chart?.result?.[0];
  const ts = r?.timestamp;
  const closes = r?.indicators?.quote?.[0]?.close;
  if (!ts || !closes || ts.length !== closes.length) return null;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (nyDate(ts[i]! * 1000) === sessionDate) {
      const c = closes[i];
      return typeof c === 'number' ? floatToE8(c) : null;
    }
  }
  return null;
}

export function parseNasdaqHistorical(json: unknown, sessionDate: string): bigint | null {
  const rows = (json as { data?: { tradesTable?: { rows?: Array<{ date?: string; close?: string }> } } })?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) return null;
  const [y, m, d] = sessionDate.split('-');
  const want = `${m}/${d}/${y}`;
  const row = rows.find((r) => r.date === want);
  if (!row?.close) return null;
  const s = row.close.replace(/[$,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(s) ? parseDecimal(s, 8) : null;
}

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchYahoo(ticker: string, sessionDate: string): Promise<bigint | null> {
  const sym = encodeURIComponent(ticker.replace('.', '-'));
  return parseYahooChart(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=10d&interval=1d`), sessionDate);
}

export async function fetchNasdaq(ticker: string, sessionDate: string): Promise<bigint | null> {
  const from = sessionDate; // inclusive
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical?assetclass=stocks&limit=10&fromdate=${from}`;
  return parseNasdaqHistorical(await getJson(url), sessionDate);
}

export type Fetcher = (ticker: string, sessionDate: string) => Promise<bigint | null>;

export const DEFAULT_SOURCES: { name: 'yahoo' | 'nasdaq'; fetch: Fetcher }[] = [
  { name: 'yahoo', fetch: fetchYahoo },
  { name: 'nasdaq', fetch: fetchNasdaq },
];

export class LastCloseService {
  private readonly store: Store;
  private readonly sources: { name: 'yahoo' | 'nasdaq'; fetch: Fetcher }[];
  private readonly log: (msg: string) => void;

  constructor(store: Store, sources = DEFAULT_SOURCES, log: (msg: string) => void = () => {}) {
    this.store = store;
    this.sources = sources;
    this.log = log;
  }

  /** Cached close for the session completed most recently before `now`; refetches until it is final. */
  async get(ticker: string, now: number): Promise<CloseQuote | null> {
    const session: Session = lastCompletedSession(now);
    const cached = this.store.getClose(ticker, session.date);
    if (cached && cached.final) return rowToQuote(cached);
    // Not final yet: refetch at most once a minute.
    if (cached && now - cached.fetched_at < 60_000) return rowToQuote(cached);

    for (const src of this.sources) {
      try {
        const closeE8 = await src.fetch(ticker, session.date);
        if (closeE8 === null) continue;
        const final = now >= session.close + FINAL_AFTER_MS;
        this.store.putClose({ ticker, session_date: session.date, close_e8: closeE8.toString(), source: src.name, fetched_at: now, final: final ? 1 : 0 });
        return { ticker, sessionDate: session.date, closeE8, source: src.name, fetchedAt: now, final };
      } catch (e) {
        this.log(`last close ${ticker} via ${src.name} failed: ${(e as Error).message}`);
      }
    }
    return cached ? rowToQuote(cached) : null;
  }
}

function rowToQuote(r: { ticker: string; session_date: string; close_e8: string; source: string; fetched_at: number; final: number }): CloseQuote {
  return {
    ticker: r.ticker,
    sessionDate: r.session_date,
    closeE8: BigInt(r.close_e8),
    source: r.source as 'yahoo' | 'nasdaq',
    fetchedAt: r.fetched_at,
    final: r.final === 1,
  };
}
