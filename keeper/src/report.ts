/**
 * Plain-data text: gap tables (Telegram /gap, daily report) and stats. Descriptive only — never advice.
 */
import type { Store } from './db.ts';
import type { MarketSnapshot, Snapshot } from './snapshot.ts';

export function fmtPct(p: number): string {
  const sign = p > 0 ? '+' : p < 0 ? '−' : '';
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

export function fmtUsd(v: number, dp = 2): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Markets with both a close and a Base price, sorted by absolute gap, largest first. */
export function rankedGaps(s: Snapshot): MarketSnapshot[] {
  return s.markets
    .filter((m) => m.gapPct !== null && m.lastClose && m.base)
    .sort((a, b) => Math.abs(b.gapPct!) - Math.abs(a.gapPct!));
}

export function gapLine(m: MarketSnapshot): string {
  const dir = m.gapPct! < 0 ? 'below' : 'above';
  return `${m.ticker.padEnd(6)} last ${fmtUsd(Number(m.lastClose!.price)).padStart(9)}  base ${fmtUsd(m.base!.midPerShare).padStart(9)}  ${fmtPct(m.gapPct!).padStart(7)}  (trades ${Math.abs(m.gapPct!).toFixed(2)}% ${dir} last close)`;
}

export function gapTable(s: Snapshot, limit = 10): string {
  const rows = rankedGaps(s).slice(0, limit);
  if (rows.length === 0) return 'No gap data right now.';
  const state = s.market.open ? 'US market open' : `US market closed (${s.market.reason ?? 'closed'})`;
  return [`Base vs last close · ${state}`, ...rows.map(gapLine)].join('\n');
}

export interface Stats {
  ordersCreated: number;
  fills: number;
  volumeUsd: number;
  uniqueMakers: number;
  source: string;
}

/** Fill-derived numbers come from indexed onchain Filled events; ordersCreated from the keeper DB. */
export function computeStats(store: Store, usdc: string): Stats {
  const fills = store.allFills();
  const u = usdc.toLowerCase();
  let volume = 0n;
  for (const f of fills) {
    if (f.token_in === u) volume += BigInt(f.amount_in);
    else if (f.token_out === u) volume += BigInt(f.amount_out);
  }
  return {
    ordersCreated: store.countOrders(),
    fills: fills.length,
    volumeUsd: Number(volume) / 1e6,
    uniqueMakers: new Set(fills.map((f) => f.maker)).size,
    source: 'fills, volume and makers from onchain Filled events; orders created from this keeper',
  };
}
