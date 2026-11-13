/**
 * Daily gap report for build-in-public posts: plain text to stdout + a 1200x675 PNG of the hidden /report route.
 *   node scripts/gap-report.ts [--url http://127.0.0.1:18797] [--out reports/gap-YYYY-MM-DD.png] [--top 8]
 * Requires a running keeper (it serves /v1/markets and /report). Descriptive data only, never advice.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fmtPct, fmtUsd, rankedGaps } from '../src/report.ts';
import { nyDate } from '../src/shared/market-clock.ts';
import type { Snapshot } from '../src/snapshot.ts';
import { launch } from './browser.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.PUBLIC_URL ?? 'http://127.0.0.1:18797' },
    out: { type: 'string' },
    top: { type: 'string', default: '8' },
  },
});
const url = values.url!.replace(/\/$/, '');
const top = Number(values.top);

const res = await fetch(`${url}/v1/markets`);
if (!res.ok) throw new Error(`GET /v1/markets: HTTP ${res.status}`);
const snap = (await res.json()) as Snapshot;
const rows = rankedGaps(snap).slice(0, top);
const session = rows[0]?.lastClose?.sessionDate ?? 'n/a';

const lines = [
  `Lastprint gap report, ${nyDate(snap.updatedAt)} (New York)`,
  `US market ${snap.market.open ? 'open' : 'closed'}. Base pool mid vs the ${session} official close.`,
  '',
  ...rows.map((m) => {
    const dir = m.gapPct! < 0 ? 'below' : 'above';
    return `${m.ticker.padEnd(6)} trades ${Math.abs(m.gapPct!).toFixed(2)}% ${dir} last close (${fmtPct(m.gapPct!)}): last ${fmtUsd(Number(m.lastClose!.price))}, Base ${fmtUsd(m.base!.midPerShare)}`;
  }),
  '',
  'Data: Aerodrome pools on Base (mid), Yahoo Finance / Nasdaq closes. Not investment advice.',
];
console.log(lines.join('\n'));

const out = resolve(values.out ?? `reports/gap-${nyDate(snap.updatedAt)}.png`);
mkdirSync(dirname(out), { recursive: true });
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  await page.goto(`${url}/report`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body[data-ready="1"]');
  await page.screenshot({ path: out });
  console.log(`\nPNG: ${out}`);
} finally {
  await browser.close();
}
