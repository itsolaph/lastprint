/**
 * Keeper loop: every ~5 s while the US market is closed, quote every open order and fill the ones whose
 * quote clears minAmountOut by a safety margin. Simulates `fill` with eth_call before sending.
 * Without KEEPER_PRIVATE_KEY it runs watch-only (decides and simulates, never sends).
 */
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { actionFeedAbi, lastprintAbi, metaQuoterAbi, slipstreamRouterAbi } from './abis.ts';
import { isRateLimit, sleep } from './chain.ts';
import type { Config } from './config.ts';
import type { OrderRow, Store } from './db.ts';
import type { Bus } from './events.ts';
import type { MarketDef } from './markets.ts';
import { isUsMarketOpen } from './shared/market-clock.ts';
import { clearsWithMargin } from './shared/pricing.ts';
import { DATA_SUFFIX } from './shared/attribution.ts';

export type Decision =
  | { action: 'expire'; reason: string }
  | { action: 'void'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'fill'; quoteOut: bigint };

export interface DecideInput {
  order: Pick<OrderRow, 'status' | 'valid_after' | 'valid_until' | 'min_amount_out' | 'stock_multiplier' | 'next_attempt_at'>;
  nowMs: number;
  marketOpen: boolean;
  inFlight: boolean;
  liveMultiplier: bigint | null;
  /** effectiveAt (ms) of a scheduled multiplier change, if any. */
  pendingEffectiveAtMs: number | null;
  transfersPaused: boolean;
  guardWindowSec: number;
  quoteOut: bigint | null;
  safetyBps: bigint;
}

/** Pure decision for one order. Mirrors the contract's checks so the keeper never sends a doomed fill. */
export function decide(i: DecideInput): Decision {
  const nowSec = Math.floor(i.nowMs / 1000);
  if (i.order.status !== 'open') return { action: 'skip', reason: `status ${i.order.status}` };
  if (nowSec >= i.order.valid_until) return { action: 'expire', reason: 'reached next opening bell' };
  if (i.inFlight) return { action: 'skip', reason: 'fill in flight' };
  if (i.nowMs < i.order.next_attempt_at) return { action: 'skip', reason: 'backing off' };
  if (i.marketOpen) return { action: 'wait', reason: 'US market open' };
  if (nowSec < i.order.valid_after) return { action: 'wait', reason: 'not yet valid' };
  if (i.liveMultiplier === null) return { action: 'wait', reason: 'multiplier unknown' };
  if (i.liveMultiplier !== BigInt(i.order.stock_multiplier)) {
    return { action: 'void', reason: 'stock multiplier changed since signing; order can never fill' };
  }
  if (i.transfersPaused) return { action: 'wait', reason: 'transfers paused' };
  if (i.pendingEffectiveAtMs !== null && i.pendingEffectiveAtMs <= i.nowMs + i.guardWindowSec * 1000) {
    return { action: 'wait', reason: 'corporate action pending within guard window' };
  }
  if (i.quoteOut === null) return { action: 'wait', reason: 'no quote' };
  if (!clearsWithMargin(i.quoteOut, BigInt(i.order.min_amount_out), i.safetyBps)) {
    return { action: 'wait', reason: 'limit not reached' };
  }
  return { action: 'fill', quoteOut: i.quoteOut };
}

/** Exponential backoff for failed fill attempts: 15 s, 30 s, 60 s ... capped at 10 min. */
export function backoffMs(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

export function buildRouterCalldata(o: OrderRow, m: MarketDef, recipient: Address, deadlineSec: bigint): Hex {
  return encodeFunctionData({
    abi: slipstreamRouterAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: o.token_in as Address,
        tokenOut: o.token_out as Address,
        tickSpacing: m.tickSpacing,
        recipient,
        deadline: deadlineSec,
        amountIn: BigInt(o.amount_in),
        amountOutMinimum: BigInt(o.min_amount_out), // defense in depth; the contract checks again
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

export function orderArgs(o: OrderRow) {
  return {
    maker: o.maker as Address,
    tokenIn: o.token_in as Address,
    tokenOut: o.token_out as Address,
    amountIn: BigInt(o.amount_in),
    minAmountOut: BigInt(o.min_amount_out),
    stockToken: o.stock_token as Address,
    stockMultiplier: BigInt(o.stock_multiplier),
    validAfter: BigInt(o.valid_after),
    validUntil: BigInt(o.valid_until),
    nonce: BigInt(o.nonce),
  };
}

type Log = (msg: string) => void;

export class Keeper {
  private readonly inFlight = new Set<string>();
  private readonly account: PrivateKeyAccount | null;
  private readonly wallet: WalletClient | null;
  private stopped = false;
  private globalBackoffMs = 0;
  guardWindowSec = 86_400;
  private readonly client: PublicClient;
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly markets: MarketDef[];
  private readonly bus: Bus;
  private readonly log: Log;

  constructor(client: PublicClient, cfg: Config, store: Store, markets: MarketDef[], bus: Bus, log: Log) {
    this.client = client;
    this.cfg = cfg;
    this.store = store;
    this.markets = markets;
    this.bus = bus;
    this.log = log;
    if (cfg.keeperPrivateKey) {
      this.account = privateKeyToAccount(cfg.keeperPrivateKey, { nonceManager });
      this.wallet = createWalletClient({ account: this.account, chain: base, transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 500 }), dataSuffix: DATA_SUFFIX });
      this.log(`keeper: sending from ${this.account.address}`);
    } else {
      this.account = null;
      this.wallet = null;
      this.log('keeper: KEEPER_PRIVATE_KEY not set, running watch-only (no transactions)');
    }
  }

  get contract(): Address {
    return this.cfg.lastprintAddress!;
  }

  async init(): Promise<void> {
    try {
      this.guardWindowSec = Number(await this.client.readContract({ address: this.contract, abi: lastprintAbi, functionName: 'guardWindow' }));
    } catch (e) {
      this.log(`keeper: could not read guardWindow, using ${this.guardWindowSec}s: ${(e as Error).message}`);
    }
  }

  async run(): Promise<void> {
    await this.init();
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.tick(Date.now());
        this.globalBackoffMs = 0;
      } catch (e) {
        if (isRateLimit(e)) {
          this.globalBackoffMs = Math.min(Math.max(this.globalBackoffMs * 2, 10_000), 300_000);
          this.log(`keeper: RPC rate limited, backing off ${this.globalBackoffMs / 1000}s`);
        } else {
          this.log(`keeper: tick failed: ${(e as Error).message}`);
        }
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(this.cfg.loopIntervalMs - elapsed, 250) + this.globalBackoffMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private market(o: OrderRow): MarketDef | undefined {
    return this.markets.find((m) => m.ticker === o.ticker);
  }

  async tick(nowMs: number): Promise<void> {
    const open = this.store.ordersByStatus('open');
    if (open.length === 0) return;
    const marketOpen = isUsMarketOpen(nowMs);

    // Expire first; it needs no RPC.
    const live: OrderRow[] = [];
    for (const o of open) {
      if (Math.floor(nowMs / 1000) >= o.valid_until) this.expire(o, 'reached next opening bell', nowMs);
      else live.push(o);
    }
    if (marketOpen || live.length === 0) return;

    // One multicall: ActionFeed status per stock token, plus an exact-input quote per order.
    const tokens = [...new Set(live.map((o) => o.stock_token))] as Address[];
    const quotable = live.filter((o) => this.market(o));
    const res = await this.client.multicall({
      allowFailure: true,
      contracts: [
        ...tokens.map((t) => ({ address: this.cfg.actionFeed, abi: actionFeedAbi, functionName: 'status', args: [t] }) as const),
        ...quotable.map((o) => ({
          address: this.cfg.metaQuoter,
          abi: metaQuoterAbi,
          functionName: 'quoteExactInputSingleV3',
          args: [this.market(o)!.pool, o.token_in as Address, BigInt(o.amount_in), 0n],
        }) as const),
      ],
    });
    const status = new Map<string, { uiMultiplier: bigint; effectiveAt: bigint; pendingLive: boolean; transferPaused: boolean }>();
    tokens.forEach((t, i) => {
      const r = res[i];
      if (r?.status === 'success') status.set(t.toLowerCase(), r.result as never);
    });
    const quotes = new Map<string, bigint>();
    quotable.forEach((o, i) => {
      const r = res[tokens.length + i];
      if (r?.status === 'success') quotes.set(o.hash, (r.result as readonly [bigint, bigint, number])[0]);
    });

    for (const o of live) {
      const st = status.get(o.stock_token.toLowerCase());
      const d = decide({
        order: o,
        nowMs,
        marketOpen,
        inFlight: this.inFlight.has(o.hash),
        liveMultiplier: st?.uiMultiplier ?? null,
        pendingEffectiveAtMs: st?.pendingLive ? Number(st.effectiveAt) * 1000 : null,
        transfersPaused: st?.transferPaused ?? false,
        guardWindowSec: this.guardWindowSec,
        quoteOut: quotes.get(o.hash) ?? null,
        safetyBps: this.cfg.safetyBps,
      });
      if (d.action === 'expire') this.expire(o, d.reason, nowMs);
      else if (d.action === 'void') this.expire(o, d.reason, nowMs);
      else if (d.action === 'fill') void this.fill(o, d.quoteOut, nowMs);
    }
  }

  private expire(o: OrderRow, reason: string, nowMs: number): void {
    this.store.setStatus(o.hash, 'expired', nowMs, { last_error: reason });
    if (!o.expiry_notified) {
      this.store.markExpiryNotified(o.hash);
      this.bus.emit('expired', { orderHash: o.hash, maker: o.maker, ticker: o.ticker, side: o.side, reason });
    }
  }

  /** One fill in flight per order, guarded both in memory and by an atomic DB status transition. */
  private async fill(o: OrderRow, quoteOut: bigint, nowMs: number): Promise<void> {
    const m = this.market(o);
    if (!m || this.inFlight.has(o.hash)) return;
    if (!this.store.claimForFill(o.hash, nowMs)) return;
    this.inFlight.add(o.hash);
    const attempts = o.attempts + 1;
    try {
      const deadline = BigInt(Math.min(o.valid_until, Math.floor(nowMs / 1000) + 120));
      const routerCalldata = buildRouterCalldata(o, m, this.contract, deadline);
      const args = [orderArgs(o), o.signature as Hex, this.cfg.router, routerCalldata] as const;
      const from = this.account?.address ?? ('0x000000000000000000000000000000000000dEaD' as Address);

      // eth_call simulation of the full fill (signature, guard, multiplier, swap, minOut).
      const sim = await this.client.simulateContract({ address: this.contract, abi: lastprintAbi, functionName: 'fill', args, account: from });
      this.log(`keeper: ${o.ticker} ${o.side} ${o.hash.slice(0, 10)} simulates OK, out=${sim.result} (quote ${quoteOut}, min ${o.min_amount_out})`);

      if (!this.wallet || !this.account) {
        this.store.backoff(o.hash, Date.now(), 60_000, 'watch-only keeper: fill not sent');
        return;
      }

      const gas = await this.client.estimateContractGas({ address: this.contract, abi: lastprintAbi, functionName: 'fill', args, account: this.account });
      const gasLimit = (gas * 125n) / 100n;
      if (gasLimit > this.cfg.gasLimitCap) throw new Error(`gas ${gasLimit} above cap ${this.cfg.gasLimitCap}`);
      const fees = await this.client.estimateFeesPerGas();
      const maxFeeCap = parseGwei(String(this.cfg.maxFeeGwei));
      const maxPriorityCap = parseGwei(String(this.cfg.maxPriorityFeeGwei));
      const maxFeePerGas = fees.maxFeePerGas;
      if (maxFeePerGas > maxFeeCap) throw new Error(`gas price ${maxFeePerGas} above cap ${maxFeeCap}`);
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > maxPriorityCap ? maxPriorityCap : fees.maxPriorityFeePerGas;

      const tx = await this.wallet.writeContract({
        address: this.contract,
        abi: lastprintAbi,
        functionName: 'fill',
        args,
        account: this.account,
        chain: base,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      this.store.setStatus(o.hash, 'filling', Date.now(), { fill_tx: tx });
      this.log(`keeper: sent fill ${tx} for ${o.hash}`);
      const receipt = await this.client.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
      if (receipt.status === 'success') {
        // The indexer is the source of truth and will mark it filled with amounts; set status now for the UI.
        this.store.setStatus(o.hash, 'filled', Date.now(), { fill_tx: tx });
      } else {
        throw new Error(`fill tx ${tx} reverted`);
      }
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      this.store.backoff(o.hash, Date.now(), backoffMs(attempts), msg);
      this.log(`keeper: ${o.hash.slice(0, 10)} not filled (${msg}); retry in ${backoffMs(attempts) / 1000}s`);
      if (isRateLimit(e)) this.globalBackoffMs = Math.max(this.globalBackoffMs, 10_000);
    } finally {
      this.inFlight.delete(o.hash);
    }
  }
}
