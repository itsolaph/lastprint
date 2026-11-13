/** Hidden /report route: a 1200x675 gap card rendered for build-in-public screenshots. Data only. */
import type { MarketSnapshot, Snapshot } from '../src/snapshot.ts';

const MINUS = '−';
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (p: number) => `${p > 0 ? '+' : p < 0 ? MINUS : ''}${Math.abs(p).toFixed(2)}%`;
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' });
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return day.format(Date.UTC(y, m - 1, d, 17)).replace(/,/g, '');
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function main(): Promise<void> {
  const res = await fetch('/v1/markets');
  const snap = (await res.json()) as Snapshot;
  const rows = snap.markets
    .filter((m): m is MarketSnapshot & { gapPct: number } => m.gapPct !== null && !!m.lastClose && !!m.base)
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
    .slice(0, 8);

  const tape = document.getElementById('r-tape')!;
  for (const m of snap.markets.filter((x) => x.lastClose && x.base).slice(0, 9)) {
    const p = el('span', 'print');
    p.append(el('span', 't', m.ticker), el('span', 'k', 'last'), el('span', '', fmt(Number(m.lastClose!.price))), el('span', 'k', 'base'), el('span', '', fmt(m.base!.midPerShare)));
    const g = m.gapPct ?? 0;
    p.append(el('span', `g ${g < 0 ? 'down' : 'up'}`, pct(g)));
    tape.append(p);
  }

  const session = snap.markets.find((m) => m.lastClose)?.lastClose?.sessionDate;
  document.getElementById('r-title')!.textContent = 'Base vs last close: largest gaps';
  const when = document.getElementById('r-when')!;
  when.append(
    el('span', '', `Snapshot ${et.format(snap.updatedAt).replace(',', '')} ET`),
    document.createElement('br'),
    el('span', '', `${snap.market.open ? 'US market open' : 'US market closed'}${session ? `, against the ${dayLabel(session)} close` : ''}`),
  );

  const max = Math.max(1, ...rows.map((r) => Math.abs(r.gapPct)));
  const list = document.getElementById('r-rows')!;
  for (const m of rows) {
    const li = el('li', 'r-row');
    const last = el('span', '');
    last.append(el('span', 'k', 'last'), document.createTextNode(fmt(Number(m.lastClose!.price))));
    const baseP = el('span', '');
    baseP.append(el('span', 'k', 'base'), document.createTextNode(fmt(m.base!.midPerShare)));
    const dir = m.gapPct < 0 ? 'down' : 'up';
    const bar = el('div', 'r-bar');
    const fill = el('span', dir);
    const w = (Math.abs(m.gapPct) / max) * 50;
    fill.style.width = `${w}%`;
    fill.style.left = dir === 'down' ? `${50 - w}%` : '50%';
    bar.append(fill);
    li.append(el('span', 't', m.ticker), last, baseP, el('span', `g ${dir}`, pct(m.gapPct)), bar);
    list.append(li);
  }
  if (rows.length === 0) list.append(el('li', 'r-row', 'No gap data.'));
  document.body.dataset.ready = '1';
}

void main();
