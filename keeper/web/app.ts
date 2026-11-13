/**
 * Lastprint web app. Vanilla DOM + viem, bundled by esbuild into public/js/app.js.
 * Shares EIP-712 types, price math and the market clock with the keeper so both sides compute the same order.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import { erc20Abi, lastprintAbi } from '../src/abis.ts';
import { CANCEL_TYPES, ORDER_TYPES, makeNonce, orderDomain, orderToJson, type Order } from '../src/shared/eip712.ts';
import { closedWindow, currentSession, isUsMarketOpen, marketState, nextSession } from '../src/shared/market-clock.ts';
import { MAX_LIMIT_BPS, WAD, formatFixed, limitPerShareE8, minAmountOutFor, parseDecimal, type Side } from '../src/shared/pricing.ts';
import type { MarketSnapshot, Snapshot } from '../src/snapshot.ts';

// ------------------------------------------------------------------------------------------ types & state

interface AppConfig {
  chainId: number;
  contract: Address | null;
  orderingEnabled: boolean;
  keeperMode: 'send' | 'watch' | 'off';
  telegramBot: string | null;
  repoUrl: string;
}

interface OrderView {
  hash: Hex;
  maker: string;
  ticker: string;
  side: Side;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  minAmountOut: string;
  stockMultiplier: string;
  validUntil: number;
  nonce: string;
  status: 'open' | 'filling' | 'filled' | 'expired' | 'cancelled';
  createdAt: number;
  fillTx: string | null;
  amountOut: string | null;
  note: string | null;
}

const BASE_CHAIN_HEX = '0x2105';
const MIN_ORDER_USD = 5;

const state = {
  config: null as AppConfig | null,
  snap: null as Snapshot | null,
  snapError: null as string | null,
  provider: null as EIP1193Provider | null,
  account: null as Address | null,
  chainId: null as number | null,
  ticker: 'NVDA',
  side: 'buy' as Side,
  balance: null as bigint | null,
  allowance: null as bigint | null,
  busy: false,
  orders: [] as OrderView[],
};

// ------------------------------------------------------------------------------------------ dom helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

// ------------------------------------------------------------------------------------------ formatting

const MINUS = '−';
function fmt(n: number, dp = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }).replace('-', MINUS);
}
function fmtPct(p: number): string {
  const s = p > 0 ? '+' : p < 0 ? MINUS : '';
  return `${s}${Math.abs(p).toFixed(2)}%`;
}
function fmtCompactUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}
function fmtUnits(v: bigint, decimals: number, shown: number): string {
  return formatFixed(v, decimals, shown);
}
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const etDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' });
function etLabel(ms: number): string {
  return `${etFmt.format(ms).replace(',', '')} ET`;
}
function localLabel(ms: number): string {
  return localFmt.format(ms).replace(',', '');
}
function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${hh}h`;
  if (hh > 0) return `${hh}h ${mm}m`;
  return `${mm}m`;
}
function sessionDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return etDayFmt.format(Date.UTC(y, m - 1, d, 17)).replace(/,/g, '');
}

// ------------------------------------------------------------------------------------------ data

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

async function loadConfig(): Promise<void> {
  state.config = await getJson<AppConfig>('/v1/config');
  if (state.config.repoUrl) $('repo-link').setAttribute('href', state.config.repoUrl);
}

async function loadMarkets(): Promise<void> {
  try {
    state.snap = await getJson<Snapshot>('/v1/markets');
    state.snapError = null;
  } catch (e) {
    state.snapError = (e as Error).message;
  }
  renderTape();
  renderMarkets();
  renderTicker();
  renderTicket();
}

function market(): MarketSnapshot | undefined {
  return state.snap?.markets.find((m) => m.ticker === state.ticker);
}

// ------------------------------------------------------------------------------------------ tape & clock

let tapeKey = '';
function renderTape(): void {
  const tape = $('tape');
  const track = $('tape-track');
  const open = isUsMarketOpen(Date.now());
  tape.classList.toggle('live', !open);
  tape.classList.toggle('frozen', open);
  const rows = (state.snap?.markets ?? []).filter((m) => m.lastClose && m.base);
  const key = rows.map((m) => `${m.ticker}${m.lastClose!.price}${m.base!.midPerShare.toFixed(2)}`).join('|');
  if (key === tapeKey) return;
  tapeKey = key;
  if (rows.length === 0) {
    track.replaceChildren(h('span', { class: 'print' }, h('span', { class: 'k' }, state.snapError ?? 'Loading prints')));
    return;
  }
  const prints = () =>
    rows.map((m) => {
      const g = m.gapPct ?? 0;
      return h(
        'span',
        { class: 'print' },
        h('span', { class: 't' }, m.ticker),
        h('span', { class: 'k' }, 'last'),
        h('span', {}, fmt(Number(m.lastClose!.price))),
        h('span', { class: 'k' }, 'base'),
        h('span', {}, fmt(m.base!.midPerShare)),
        h('span', { class: `g ${g < 0 ? 'down' : g > 0 ? 'up' : ''}` }, fmtPct(g)),
      );
    });
  // Two copies so the CSS loop (translateX -50%) is seamless.
  track.replaceChildren(...prints(), ...prints());
  track.style.setProperty('--tape-duration', `${Math.max(30, rows.length * 6)}s`);
  tape.setAttribute('aria-label', `Base prices against the last official close: ${rows.map((m) => `${m.ticker} ${fmtPct(m.gapPct ?? 0)}`).join(', ')}`);
}

function renderClock(): void {
  const now = Date.now();
  const el = $('state');
  let ms;
  try {
    ms = marketState(now);
  } catch {
    el.replaceChildren(h('span', {}, 'The market calendar does not cover today. Ordering is disabled.'));
    return;
  }
  el.classList.toggle('closed', !ms.open);
  if (ms.open) {
    const close = currentSession(now)!.close;
    el.replaceChildren(
      h('span', {}, h('span', { class: 'dot' }), `US market open · closes in ${fmtDuration(close - now)}`),
      h('span', { class: 'when' }, `(${etTimeFmt.format(close)} ET / ${localLabel(close)}). Ordering reopens at the close; the tape is frozen.`),
    );
  } else {
    const why = ms.reason && ms.reason !== 'Overnight' && ms.reason !== 'Weekend' ? ` for ${ms.reason}` : '';
    el.replaceChildren(
      h('span', {}, h('span', { class: 'dot' }), `US market closed${why} · opens in ${fmtDuration(ms.nextOpen - now)}`),
      h('span', { class: 'when' }, `(${etLabel(ms.nextOpen)} / ${localLabel(ms.nextOpen)})`),
    );
  }
  const tape = $('tape');
  if (tape.classList.contains('live') === ms.open) renderTape();
}

// ------------------------------------------------------------------------------------------ markets table

function renderMarkets(): void {
  const body = $('markets-body');
  const snap = state.snap;
  if (!snap) {
    body.replaceChildren(h('tr', { class: 'empty' }, h('td', { colspan: '5' }, state.snapError ?? 'Loading closes and pool prices…')));
    return;
  }
  if (snap.markets.length === 0) {
    body.replaceChildren(h('tr', { class: 'empty' }, h('td', { colspan: '5' }, 'No markets are configured. Run the markets refresh script.')));
    return;
  }
  body.replaceChildren(
    ...snap.markets.map((m) => {
      const g = m.gapPct;
      const tr = h(
        'tr',
        { class: m.ticker === state.ticker ? 'selected' : '' },
        h(
          'td',
          {},
          h(
            'button',
            { class: 'pick', type: 'button', 'aria-pressed': String(m.ticker === state.ticker), 'data-ticker': m.ticker },
            h('span', { class: 't' }, m.ticker),
            h('span', { class: 'n' }, m.name),
          ),
        ),
        h(
          'td',
          { class: 'num' },
          m.lastClose ? fmt(Number(m.lastClose.price)) : h('span', { class: 'muted' }, 'n/a'),
          m.lastClose ? h('span', { class: 'src col-src' }, `${m.lastClose.source === 'yahoo' ? 'Yahoo' : 'Nasdaq'}, ${sessionDay(m.lastClose.sessionDate)}${m.lastClose.final ? '' : ', provisional'}`) : null,
        ),
        h('td', { class: 'num' }, m.base ? fmt(m.base.midPerShare) : h('span', { class: 'muted' }, 'n/a')),
        h('td', { class: `num gap ${g === null ? '' : g < 0 ? 'down' : g > 0 ? 'up' : ''}` }, g === null ? '–' : fmtPct(g)),
        h('td', { class: 'num col-depth' }, m.depthUsd ? fmtCompactUsd(m.depthUsd) : '–'),
      );
      return tr;
    }),
  );
}

function renderTicker(): void {
  const sel = $<HTMLSelectElement>('f-ticker');
  const tickers = state.snap?.markets.map((m) => m.ticker) ?? [];
  const current = [...sel.options].map((o) => o.value).join(',');
  if (current !== tickers.join(',')) {
    sel.replaceChildren(...tickers.map((t) => h('option', { value: t }, t)));
  }
  if (tickers.length && !tickers.includes(state.ticker)) state.ticker = tickers.includes('NVDA') ? 'NVDA' : tickers[0]!;
  sel.value = state.ticker;
}

// ------------------------------------------------------------------------------------------ wallet

let announced: EIP1193Provider | null = null;
window.addEventListener('eip6963:announceProvider', (ev) => {
  const detail = (ev as CustomEvent<{ provider: EIP1193Provider }>).detail;
  if (!announced && detail?.provider) announced = detail.provider;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function getProvider(): EIP1193Provider | null {
  const w = window as unknown as { ethereum?: EIP1193Provider };
  return w.ethereum ?? announced;
}

function clients(): { pub: PublicClient; wallet: WalletClient } {
  const transport = custom(state.provider!);
  return {
    pub: createPublicClient({ chain: base, transport }) as PublicClient,
    wallet: createWalletClient({ chain: base, transport, account: state.account! }),
  };
}

async function connect(): Promise<void> {
  const p = getProvider();
  if (!p) {
    setMsg('No browser wallet found. Install Coinbase Wallet, MetaMask or Rabby, then reload.', 'err');
    return;
  }
  state.provider = p;
  try {
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    state.account = accounts[0] ? getAddress(accounts[0]) : null;
    state.chainId = parseInt((await p.request({ method: 'eth_chainId' })) as string, 16);
  } catch (e) {
    setMsg(walletError(e, 'Connection was rejected in the wallet.'), 'err');
    return;
  }
  p.on?.('accountsChanged', (a: string[]) => {
    state.account = a[0] ? getAddress(a[0]) : null;
    onWalletChange();
  });
  p.on?.('chainChanged', (c: string) => {
    state.chainId = parseInt(c, 16);
    onWalletChange();
  });
  onWalletChange();
}

async function switchToBase(): Promise<void> {
  const p = state.provider;
  if (!p) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4902) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: BASE_CHAIN_HEX, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }],
      });
    } else {
      setMsg(walletError(e, 'Switching network was rejected in the wallet.'), 'err');
    }
  }
}

function walletError(e: unknown, rejected: string): string {
  const err = e as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  if (err.code === 4001 || err.cause?.code === 4001 || /reject|denied/i.test(err.message ?? '')) return rejected;
  return err.shortMessage ?? err.message ?? 'The wallet returned an error.';
}

function onWalletChange(): void {
  const btn = $('connect');
  const addr = $('wallet-addr');
  if (state.account) {
    addr.textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
    btn.textContent = state.chainId === 8453 ? 'Connected' : 'Switch to Base';
  } else {
    addr.textContent = '';
    btn.textContent = 'Connect wallet';
  }
  state.balance = null;
  state.allowance = null;
  void refreshFunds();
  void loadOrders();
  renderTicket();
}

// ------------------------------------------------------------------------------------------ ticket

interface TicketCalc {
  m: MarketSnapshot;
  tokenIn: Address;
  tokenOut: Address;
  inDecimals: number;
  outDecimals: number;
  inSymbol: string;
  outSymbol: string;
  amountIn: bigint | null;
  bps: bigint | null;
  minOut: bigint | null;
  problem: string | null;
}

function ticketCalc(): TicketCalc | null {
  const m = market();
  if (!m) return null;
  const buy = state.side === 'buy';
  const c: TicketCalc = {
    m,
    tokenIn: buy ? m.quoteToken : m.token,
    tokenOut: buy ? m.token : m.quoteToken,
    inDecimals: buy ? m.quoteDecimals : m.decimals,
    outDecimals: buy ? m.decimals : m.quoteDecimals,
    inSymbol: buy ? 'USDC' : m.symbol,
    outSymbol: buy ? m.symbol : 'USDC',
    amountIn: null,
    bps: null,
    minOut: null,
    problem: null,
  };
  const rawAmt = $<HTMLInputElement>('f-amount').value.trim().replace(/,/g, '');
  const rawLim = $<HTMLInputElement>('f-limit').value.trim().replace('−', '-');
  if (rawAmt) {
    try {
      c.amountIn = parseDecimal(rawAmt, c.inDecimals);
      if (c.amountIn === 0n) c.amountIn = null;
    } catch {
      c.problem = 'Enter the amount as a plain number, like 250 or 0.5.';
    }
  }
  if (/^-?\d{1,2}(\.\d{1,2})?$/.test(rawLim)) {
    const neg = rawLim.startsWith('-');
    const bps = parseDecimal(rawLim.replace('-', ''), 2);
    c.bps = neg ? -bps : bps;
    if (c.bps > MAX_LIMIT_BPS || c.bps < -MAX_LIMIT_BPS) {
      c.problem = `Keep the limit within ±${Number(MAX_LIMIT_BPS) / 100}% of the last close.`;
      c.bps = null;
    }
  } else if (!c.problem) {
    c.problem = 'Enter the limit as a percentage, like -1.5 or 0.75.';
  }
  if (!m.lastClose) c.problem = `The last close for ${m.ticker} is unavailable right now.`;
  else if (!m.multiplier) c.problem = `The ${m.ticker} multiplier could not be read right now.`;
  if (!c.problem && c.amountIn && c.bps !== null && m.lastClose && m.multiplier) {
    c.minOut = minAmountOutFor(state.side, c.amountIn, c.bps, {
      closeE8: BigInt(m.lastClose.closeE8),
      multiplier: BigInt(m.multiplier),
      stockDecimals: m.decimals,
      quoteDecimals: m.quoteDecimals,
    });
    const usd = buy ? c.amountIn : c.minOut;
    if (usd < BigInt(MIN_ORDER_USD) * 10n ** BigInt(m.quoteDecimals)) c.problem = `Orders must be at least ${MIN_ORDER_USD} USDC.`;
  }
  if (m.transfersPaused) c.problem = `${m.ticker} transfers are paused by the issuer.`;
  if (m.pendingAction) c.problem = `A corporate action is pending for ${m.ticker} (effective ${etLabel(m.pendingAction.effectiveAt)}). Orders are paused.`;
  return c;
}

type Gate = { kind: 'connect' | 'switch' | 'approve' | 'sign' | 'none'; reason: string | null };

function gate(c: TicketCalc | null): Gate {
  const cfg = state.config;
  const now = Date.now();
  if (!cfg?.orderingEnabled) return { kind: 'none', reason: 'Ordering is off on this instance: no contract is configured. Markets and gaps are live.' };
  let open = false;
  try {
    open = isUsMarketOpen(now);
  } catch {
    return { kind: 'none', reason: 'The market calendar does not cover today, so ordering is disabled.' };
  }
  if (open) return { kind: 'none', reason: `The US market is open. Orders can be placed after the ${etTimeFmt.format(currentSession(now)!.close)} ET close.` };
  if (!getProvider()) return { kind: 'none', reason: 'No browser wallet found. Install Coinbase Wallet, MetaMask or Rabby, then reload.' };
  if (!state.account) return { kind: 'connect', reason: 'Connect a wallet to place an order.' };
  if (state.chainId !== 8453) return { kind: 'switch', reason: 'Your wallet is on another network. Switch to Base to continue.' };
  if (!c) return { kind: 'none', reason: 'Pick a market.' };
  if (c.problem) return { kind: 'none', reason: c.problem };
  if (!c.amountIn || c.minOut === null) return { kind: 'none', reason: 'Enter an amount.' };
  if (state.balance !== null && state.balance < c.amountIn) return { kind: 'none', reason: `Insufficient ${c.inSymbol} balance for this amount.` };
  if (state.allowance === null) return { kind: 'none', reason: 'Checking your allowance…' };
  if (state.allowance < c.amountIn) return { kind: 'approve', reason: `Step 1: approve Lastprint to use exactly ${fmtUnits(c.amountIn, c.inDecimals, c.inDecimals === 6 ? 2 : 4)} ${c.inSymbol}.` };
  return { kind: 'sign', reason: 'Step 2: sign the order. Signing is free; nothing moves until a fill.' };
}

let msgOverride: { text: string; kind: 'err' | 'ok' | '' ; until: number } | null = null;
function setMsg(text: string, kind: 'err' | 'ok' | '' = ''): void {
  msgOverride = { text, kind, until: Date.now() + 12_000 };
  renderTicket();
}

function renderTicket(): void {
  const c = ticketCalc();
  const m = c?.m;
  const buy = state.side === 'buy';
  const now = Date.now();

  $('amount-lbl').textContent = buy ? 'Amount (USDC)' : `Amount (${m?.symbol ?? 'tokens'})`;

  // Limit help: absolute price.
  const limHelp = $('limit-help');
  if (m?.lastClose && c?.bps !== null && c?.bps !== undefined) {
    const limit = limitPerShareE8(BigInt(m.lastClose.closeE8), c.bps);
    limHelp.textContent = `${buy ? 'Pay at most' : 'Receive at least'} ${fmtUnits(limit, 8, 2)} per share; last close ${fmt(Number(m.lastClose.price))}`;
  } else {
    limHelp.textContent = m?.lastClose ? `Last close ${fmt(Number(m.lastClose.price))}` : '';
  }

  // Amount help: shares equivalent for sells.
  const amtHelp = $('amount-help');
  if (!buy && m?.multiplier && c?.amountIn) {
    const shares = (c.amountIn * BigInt(m.multiplier)) / WAD;
    amtHelp.textContent = `= ${fmtUnits(shares, m.decimals, 4)} shares`;
  } else {
    amtHelp.textContent = buy ? `Minimum ${MIN_ORDER_USD} USDC` : '';
  }

  // Expiry & multiplier.
  try {
    const win = closedWindow(now);
    const end = win ? win.end : nextSession(now).open;
    $('f-expiry').textContent = etLabel(end);
    $('f-expiry-local').textContent = localLabel(end);
  } catch {
    $('f-expiry').textContent = 'n/a';
  }
  $('f-mult').textContent = m?.multiplier ? fmtUnits(BigInt(m.multiplier), 18, 6) : '–';

  // Estimates.
  $('est-min').textContent = c?.minOut !== null && c?.minOut !== undefined ? `${fmtUnits(c.minOut, c.outDecimals, c.outDecimals === 6 ? 2 : 4)} ${c.outSymbol}` : '–';
  const estNow = $('est-now');
  if (m?.base && m.multiplier && c?.amountIn) {
    const multF = Number(m.multiplier) / 1e18;
    const inF = Number(c.amountIn) / 10 ** c.inDecimals;
    const px = buy ? m.base.buyPerShare : m.base.sellPerShare;
    if (px) {
      const out = buy ? inF / (px * multF) : inF * multF * px;
      estNow.textContent = `≈ ${fmt(out, buy ? 4 : 2)} ${c.outSymbol}`;
    } else estNow.textContent = '–';
  } else estNow.textContent = '–';
  $('est-bal').textContent = state.balance !== null && c ? `${fmtUnits(state.balance, c.inDecimals, c.inDecimals === 6 ? 2 : 4)} ${c.inSymbol}` : '–';

  // Buttons and message.
  const g = gate(c);
  const approve = $<HTMLButtonElement>('btn-approve');
  const sign = $<HTMLButtonElement>('btn-sign');
  const ticket = $('ticket');
  ticket.classList.toggle('disabled', g.kind === 'none' && !state.busy && (!state.config?.orderingEnabled || safeOpen(now)));
  approve.disabled = state.busy || g.kind !== 'approve';
  approve.classList.toggle('primary', g.kind === 'approve');
  sign.disabled = state.busy || !(g.kind === 'sign' || g.kind === 'connect' || g.kind === 'switch');
  sign.classList.toggle('primary', g.kind !== 'approve');
  sign.lastChild!.textContent = g.kind === 'connect' ? 'Connect wallet' : g.kind === 'switch' ? 'Switch to Base' : 'Sign order';
  if (state.allowance !== null && c?.amountIn && state.allowance >= c.amountIn) approve.lastChild!.textContent = 'Approved';
  else approve.lastChild!.textContent = `Approve ${c?.inSymbol ?? ''}`.trim();

  const msg = $('ticket-msg');
  if (msgOverride && msgOverride.until > now) {
    msg.textContent = msgOverride.text;
    msg.className = `ticket-msg ${msgOverride.kind}`;
  } else {
    msg.textContent = g.reason ?? '';
    msg.className = 'ticket-msg';
  }

  // Page-level notice for instance-wide states.
  const notice = $('notice');
  if (state.config && !state.config.orderingEnabled) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = 'Read-only: this instance has no Lastprint contract configured, so ordering is off. Closes, Base prices and gaps are live.';
  } else if (state.snapError && !state.snap) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.textContent = state.snapError;
  } else {
    notice.hidden = true;
  }
}

function safeOpen(now: number): boolean {
  try {
    return isUsMarketOpen(now);
  } catch {
    return true;
  }
}

let fundsSeq = 0;
async function refreshFunds(): Promise<void> {
  const c = ticketCalc();
  if (!state.account || !state.provider || state.chainId !== 8453 || !c || !state.config?.contract) return;
  const seq = ++fundsSeq;
  try {
    const { pub } = clients();
    const [bal, allow] = await Promise.all([
      pub.readContract({ address: c.tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [state.account] }),
      pub.readContract({ address: c.tokenIn, abi: erc20Abi, functionName: 'allowance', args: [state.account, state.config.contract] }),
    ]);
    if (seq !== fundsSeq) return;
    state.balance = bal;
    state.allowance = allow;
  } catch {
    if (seq !== fundsSeq) return;
    state.balance = null;
    state.allowance = null;
  }
  renderTicket();
}

async function approve(): Promise<void> {
  const c = ticketCalc();
  if (!c?.amountIn || !state.config?.contract || !state.account) return;
  state.busy = true;
  setMsg('Confirm the approval in your wallet…');
  try {
    const { pub, wallet } = clients();
    const tx = await wallet.writeContract({
      address: c.tokenIn,
      abi: erc20Abi,
      functionName: 'approve',
      args: [state.config.contract, c.amountIn],
      account: state.account,
      chain: base,
    });
    setMsg('Approval sent. Waiting for Base to confirm it…');
    await pub.waitForTransactionReceipt({ hash: tx });
    setMsg('Approved. Now sign the order.', 'ok');
  } catch (e) {
    setMsg(walletError(e, 'Approval was rejected in the wallet.'), 'err');
  } finally {
    state.busy = false;
    await refreshFunds();
  }
}

async function signOrder(): Promise<void> {
  const g = gate(ticketCalc());
  if (g.kind === 'connect') return connect();
  if (g.kind === 'switch') return switchToBase();
  const c = ticketCalc();
  if (g.kind !== 'sign' || !c?.amountIn || c.minOut === null || !state.config?.contract || !state.account) return;
  const now = Date.now();
  const win = closedWindow(now);
  if (!win) return;
  const order: Order = {
    maker: state.account,
    tokenIn: c.tokenIn,
    tokenOut: c.tokenOut,
    amountIn: c.amountIn,
    minAmountOut: c.minOut,
    stockToken: c.m.token,
    stockMultiplier: BigInt(c.m.multiplier!),
    validAfter: BigInt(Math.floor(win.start / 1000)),
    validUntil: BigInt(Math.floor(win.end / 1000)),
    nonce: makeNonce(now, crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32),
  };
  state.busy = true;
  setMsg('Check the order in your wallet and sign it…');
  try {
    const { wallet } = clients();
    const signature = await wallet.signTypedData({
      account: state.account,
      domain: orderDomain(8453, state.config.contract),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: order,
    });
    setMsg('Submitting the signed order…');
    await getJson('/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: orderToJson(order), signature }) });
    showStamp(now, win.end);
    setMsg(`Order placed. It is live until ${etLabel(win.end)} and fills only at your limit or better.`, 'ok');
    await loadOrders();
  } catch (e) {
    setMsg(walletError(e, 'Signing was rejected in the wallet. No order was placed.'), 'err');
  } finally {
    state.busy = false;
    renderTicket();
  }
}

function showStamp(at: number, until: number): void {
  const s = $('stamp');
  s.replaceChildren('Signed', h('small', {}, `${etTimeFmt.format(at)} ET, live to ${etLabel(until)}`));
  s.hidden = false;
  s.classList.remove('show');
  void s.offsetWidth;
  s.classList.add('show');
  window.setTimeout(() => {
    s.hidden = true;
  }, 9000);
}

// ------------------------------------------------------------------------------------------ my orders

async function loadOrders(): Promise<void> {
  if (!state.account) {
    state.orders = [];
    renderOrders();
    return;
  }
  try {
    const r = await getJson<{ orders: OrderView[] }>(`/v1/orders?maker=${state.account}`);
    state.orders = r.orders;
  } catch {
    state.orders = [];
  }
  renderOrders();
}

function renderOrders(): void {
  const box = $('orders');
  const sub = $('orders-sub');
  sub.replaceChildren();
  if (state.account && state.config?.telegramBot) {
    sub.append(h('a', { href: `https://t.me/${state.config.telegramBot}?start=${state.account}`, rel: 'noopener' }, 'Notify me on Telegram'));
  }
  if (!state.account) {
    box.replaceChildren(h('p', { class: 'empty-orders' }, 'Connect a wallet to see your orders.'));
    return;
  }
  if (state.orders.length === 0) {
    box.replaceChildren(h('p', { class: 'empty-orders' }, 'No orders yet. Orders you sign appear here with their status.'));
    return;
  }
  const list = h('ul', { class: 'order-list' });
  for (const o of state.orders) {
    const m = state.snap?.markets.find((x) => x.ticker === o.ticker);
    const sd = m?.decimals ?? 8;
    const inDec = o.side === 'buy' ? 6 : sd;
    const outDec = o.side === 'buy' ? sd : 6;
    const inSym = o.side === 'buy' ? 'USDC' : (m?.symbol ?? o.ticker);
    const outSym = o.side === 'buy' ? (m?.symbol ?? o.ticker) : 'USDC';
    const amtIn = `${fmtUnits(BigInt(o.amountIn), inDec, inDec === 6 ? 2 : 4)} ${inSym}`;
    const amtOut = o.amountOut
      ? `${fmtUnits(BigInt(o.amountOut), outDec, outDec === 6 ? 2 : 4)} ${outSym}`
      : `at least ${fmtUnits(BigInt(o.minAmountOut), outDec, outDec === 6 ? 2 : 4)} ${outSym}`;
    const acts = h('div', { class: 'acts' });
    if (o.status === 'open') {
      acts.append(
        h('button', { class: 'btn link', type: 'button', 'data-cancel': o.hash }, 'Cancel'),
        h('button', { class: 'btn link', type: 'button', 'data-cancel-onchain': o.nonce }, 'Cancel onchain'),
      );
    }
    if (o.fillTx) acts.append(h('a', { href: `https://basescan.org/tx/${o.fillTx}`, rel: 'noopener' }, 'View fill'));
    const meta =
      o.status === 'open' || o.status === 'filling'
        ? `Live until ${etLabel(o.validUntil * 1000)}`
        : o.status === 'filled'
          ? 'Filled on Base'
          : o.note ?? o.status;
    list.append(
      h(
        'li',
        { class: 'order' },
        h('span', { class: 'status-cell' }, h('span', { class: `status ${o.status}` }, o.status)),
        h('div', {}, h('div', { class: 'what' }, h('b', {}, `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.ticker}`), ` ${amtIn} for ${amtOut}`), h('div', { class: 'meta' }, meta)),
        acts,
      ),
    );
  }
  box.replaceChildren(list);
}

async function cancelOffchain(hash: Hex): Promise<void> {
  if (!state.account || !state.config?.contract) return;
  try {
    const { wallet } = clients();
    const signature = await wallet.signTypedData({
      account: state.account,
      domain: orderDomain(8453, state.config.contract),
      types: CANCEL_TYPES,
      primaryType: 'CancelOrder',
      message: { orderHash: hash },
    });
    await getJson(`/v1/orders/${hash}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
    setMsg('Cancelled with this keeper. For a guarantee against every filler, also use Cancel onchain.', 'ok');
  } catch (e) {
    setMsg(walletError(e, 'Cancel was rejected in the wallet.'), 'err');
  }
  await loadOrders();
}

async function cancelOnchain(nonce: string): Promise<void> {
  if (!state.account || !state.config?.contract) return;
  if (state.chainId !== 8453) return switchToBase();
  try {
    const { pub, wallet } = clients();
    const tx = await wallet.writeContract({ address: state.config.contract, abi: lastprintAbi, functionName: 'cancel', args: [BigInt(nonce)], account: state.account, chain: base });
    setMsg('Cancel sent. Waiting for Base to confirm it…');
    await pub.waitForTransactionReceipt({ hash: tx });
    setMsg('Cancelled onchain. The order can no longer fill anywhere.', 'ok');
  } catch (e) {
    setMsg(walletError(e, 'Cancel was rejected in the wallet.'), 'err');
  }
  await loadOrders();
}

// ------------------------------------------------------------------------------------------ wiring

function wire(): void {
  $('connect').addEventListener('click', () => {
    if (state.account && state.chainId !== 8453) void switchToBase();
    else if (!state.account) void connect();
  });
  $('markets-body').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-ticker]');
    if (!btn) return;
    state.ticker = btn.dataset.ticker!;
    renderMarkets();
    renderTicker();
    renderTicket();
    void refreshFunds();
    // On narrow screens the ticket sits above the table: bring it back into view.
    if (window.matchMedia('(max-width: 860px)').matches) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('ticket').scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    }
  });
  $<HTMLSelectElement>('f-ticker').addEventListener('change', (ev) => {
    state.ticker = (ev.target as HTMLSelectElement).value;
    renderMarkets();
    renderTicket();
    void refreshFunds();
  });
  for (const id of ['side-buy', 'side-sell']) {
    $(id).addEventListener('change', (ev) => {
      state.side = (ev.target as HTMLInputElement).value as Side;
      $<HTMLInputElement>('f-amount').value = '';
      state.balance = null;
      state.allowance = null;
      renderTicket();
      void refreshFunds();
    });
  }
  let t: number | undefined;
  for (const id of ['f-amount', 'f-limit']) {
    $(id).addEventListener('input', () => {
      msgOverride = null;
      renderTicket();
      window.clearTimeout(t);
      t = window.setTimeout(() => void refreshFunds(), 400);
    });
  }
  $('btn-approve').addEventListener('click', () => void approve());
  $('ticket-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void signOrder();
  });
  $('orders').addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const c = target.closest<HTMLButtonElement>('button[data-cancel]');
    if (c) return void cancelOffchain(c.dataset.cancel as Hex);
    const oc = target.closest<HTMLButtonElement>('button[data-cancel-onchain]');
    if (oc) return void cancelOnchain(oc.dataset.cancelOnchain!);
  });

  const es = new EventSource('/v1/stream');
  es.addEventListener('fill', (ev) => {
    const f = JSON.parse((ev as MessageEvent).data) as { maker: string; ticker: string | null };
    if (state.account && f.maker === state.account.toLowerCase()) {
      setMsg(`Your ${f.ticker ?? ''} order filled on Base.`.replace('  ', ' '), 'ok');
      void loadOrders();
    }
  });
}

async function main(): Promise<void> {
  wire();
  renderClock();
  window.setInterval(renderClock, 15_000);
  try {
    await loadConfig();
  } catch {
    state.config = { chainId: 8453, contract: null, orderingEnabled: false, keeperMode: 'off', telegramBot: null, repoUrl: '' };
  }
  await loadMarkets();
  window.setInterval(() => void loadMarkets(), 15_000);
  window.setInterval(() => {
    if (msgOverride && msgOverride.until <= Date.now()) {
      msgOverride = null;
      renderTicket();
    }
  }, 2000);
  // Reconnect silently if the wallet already authorised this site.
  const p = getProvider();
  if (p) {
    try {
      const accts = (await p.request({ method: 'eth_accounts' })) as string[];
      if (accts.length) await connect();
    } catch {
      /* ignore */
    }
  }
}

void main();
