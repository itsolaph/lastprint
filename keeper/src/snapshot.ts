/**
 * Market snapshots: last close, B20 multiplier, Base price (pool mid + reference-size quotes), gap vs close.
 * Refreshed in the background; the API serves the cached snapshot.
 */
import type { Address, PublicClient } from 'viem';
import { actionFeedAbi, clPoolAbi, metaQuoterAbi } from './abis.ts';
import type { Config } from './config.ts';
import type { LastCloseService } from './lastclose.ts';
import type { MarketDef } from './markets.ts';
import { marketState, type MarketState } from './shared/market-clock.ts';
import { WAD, formatFixed, gapFraction, stockMidFromSqrtX96 } from './shared/pricing.ts';

export interface MarketSnapshot {
  ticker: string;
  symbol: string;
  name: string;
  token: Address;
  decimals: number;
  pool: Address;
  tickSpacing: number;
  quoteToken: Address;
  quoteDecimals: number;
  lastClose: {
    price: string; // per share, USD
    closeE8: string;
    sessionDate: string;
    source: string;
    fetchedAt: number;
    final: boolean;
  } | null;
  multiplier: string | null; // WAD
  pendingAction: { newMultiplier: string; effectiveAt: number } | null;
  transfersPaused: boolean;
  /** Close expressed per token: close * multiplier. */
  tokenClose: string | null;
  base: {
    midPerShare: number;
    midPerToken: number;
    buyPerShare: number | null; // executable, buying `refUsd` of stock
    sellPerShare: number | null; // executable, selling `refUsd` of stock
    refUsd: number;
    updatedAt: number;
  } | null;
  gapPct: number | null;
  depthUsd: number | null;
  impactBps: number | null;
  error: string | null;
}

export interface Snapshot {
  updatedAt: number;
  market: MarketState;
  markets: MarketSnapshot[];
}

type Log = (msg: string) => void;

export class SnapshotService {
  private current: Snapshot | null = null;
  private depth = new Map<string, number>();
  private depthFetchedAt = 0;

  private readonly client: PublicClient;
  private readonly cfg: Config;
  private readonly markets: MarketDef[];
  private readonly closes: LastCloseService;
  private readonly log: Log;

  constructor(client: PublicClient, cfg: Config, markets: MarketDef[], closes: LastCloseService, log: Log = () => {}) {
    this.client = client;
    this.cfg = cfg;
    this.markets = markets;
    this.closes = closes;
    this.log = log;
    for (const m of markets) this.depth.set(m.pool.toLowerCase(), m.liquidityUsd);
  }

  get(): Snapshot | null {
    return this.current;
  }

  market(ticker: string): MarketDef | undefined {
    return this.markets.find((m) => m.ticker === ticker);
  }

  marketByToken(token: string): MarketDef | undefined {
    const t = token.toLowerCase();
    return this.markets.find((m) => m.token.toLowerCase() === t);
  }

  async refresh(now = Date.now()): Promise<Snapshot> {
    const ms = marketState(now);
    const reads = await this.client.multicall({
      allowFailure: true,
      contracts: this.markets.flatMap((m) => [
        { address: this.cfg.actionFeed, abi: actionFeedAbi, functionName: 'status', args: [m.token] },
        { address: m.pool, abi: clPoolAbi, functionName: 'slot0' },
      ] as const),
    });

    const statuses = this.markets.map((m, i) => {
      const st = reads[i * 2];
      const s0 = reads[i * 2 + 1];
      return {
        status: st?.status === 'success' ? (st.result as { uiMultiplier: bigint; newUIMultiplier: bigint; effectiveAt: bigint; pendingLive: boolean; transferPaused: boolean }) : null,
        sqrt: s0?.status === 'success' ? (s0.result as readonly [bigint, ...unknown[]])[0] : null,
      };
    });

    const mids = this.markets.map((m, i) => {
      const s = statuses[i]!.sqrt;
      return s ? stockMidFromSqrtX96(s, m.stockIsToken0, m.decimals, m.quoteDecimals) : null;
    });

    // Reference-size quotes in both directions (one multicall).
    const refUsd = this.cfg.referenceUsd;
    const quoteReads = await this.client.multicall({
      allowFailure: true,
      contracts: this.markets.flatMap((m, i) => {
        const mid = mids[i];
        const buyIn = refUsd * 10n ** BigInt(m.quoteDecimals);
        const sellIn = mid && mid > 0 ? BigInt(Math.floor((Number(refUsd) / mid) * 10 ** m.decimals)) : 1n;
        return [
          { address: this.cfg.metaQuoter, abi: metaQuoterAbi, functionName: 'quoteExactInputSingleV3', args: [m.pool, m.quoteToken, buyIn, 0n] },
          { address: this.cfg.metaQuoter, abi: metaQuoterAbi, functionName: 'quoteExactInputSingleV3', args: [m.pool, m.token, sellIn, 0n] },
        ] as const;
      }),
    });

    await this.refreshDepth(now);

    const out: MarketSnapshot[] = [];
    for (let i = 0; i < this.markets.length; i++) {
      const m = this.markets[i]!;
      const st = statuses[i]!.status;
      const mid = mids[i] ?? null;
      let error: string | null = null;
      let close = null as Awaited<ReturnType<LastCloseService['get']>>;
      try {
        close = await this.closes.get(m.ticker, now);
      } catch (e) {
        error = `last close unavailable: ${(e as Error).message}`;
      }
      if (!close && !error) error = 'last close unavailable';

      const mult = st?.uiMultiplier ?? null;
      const multF = mult ? Number(mult) / 1e18 : null;
      const closeF = close ? Number(close.closeE8) / 1e8 : null;

      let base: MarketSnapshot['base'] = null;
      let impactBps: number | null = null;
      if (mid && multF) {
        const qb = quoteReads[i * 2];
        const qs = quoteReads[i * 2 + 1];
        const buyIn = Number(refUsd);
        let buyPerShare: number | null = null;
        let sellPerShare: number | null = null;
        if (qb?.status === 'success') {
          const outTokens = Number((qb.result as readonly [bigint, bigint, number])[0]) / 10 ** m.decimals;
          if (outTokens > 0) buyPerShare = buyIn / outTokens / multF;
        }
        if (qs?.status === 'success') {
          const sellTokens = Math.floor((buyIn / mid) * 10 ** m.decimals) / 10 ** m.decimals;
          const outUsd = Number((qs.result as readonly [bigint, bigint, number])[0]) / 10 ** m.quoteDecimals;
          if (sellTokens > 0) sellPerShare = outUsd / sellTokens / multF;
        }
        const midPerShare = mid / multF;
        if (buyPerShare) impactBps = Math.round((buyPerShare / midPerShare - 1) * 10_000);
        base = { midPerShare, midPerToken: mid, buyPerShare, sellPerShare, refUsd: buyIn, updatedAt: now };
      } else if (!error) {
        error = 'Base price unavailable';
      }

      out.push({
        ticker: m.ticker,
        symbol: m.symbol,
        name: m.name,
        token: m.token,
        decimals: m.decimals,
        pool: m.pool,
        tickSpacing: m.tickSpacing,
        quoteToken: m.quoteToken,
        quoteDecimals: m.quoteDecimals,
        lastClose: close
          ? {
              price: formatFixed(close.closeE8, 8, 2).replace(/,/g, ''),
              closeE8: close.closeE8.toString(),
              sessionDate: close.sessionDate,
              source: close.source,
              fetchedAt: close.fetchedAt,
              final: close.final,
            }
          : null,
        multiplier: mult?.toString() ?? null,
        pendingAction: st?.pendingLive ? { newMultiplier: st.newUIMultiplier.toString(), effectiveAt: Number(st.effectiveAt) * 1000 } : null,
        transfersPaused: st?.transferPaused ?? false,
        tokenClose: close && mult ? formatFixed((close.closeE8 * mult) / WAD, 8, 4).replace(/,/g, '') : null,
        base,
        gapPct: base && closeF ? gapFraction(base.midPerShare, closeF) * 100 : null,
        depthUsd: this.depth.get(m.pool.toLowerCase()) ?? null,
        impactBps,
        error,
      });
    }

    this.current = { updatedAt: now, market: ms, markets: out };
    return this.current;
  }

  /** Pool liquidity (USD) from DexScreener's pairs endpoint, at most every 10 minutes. */
  private async refreshDepth(now: number): Promise<void> {
    if (now - this.depthFetchedAt < 10 * 60_000) return;
    this.depthFetchedAt = now;
    try {
      const ids = this.markets.map((m) => m.pool).join(',');
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${ids}`, {
        headers: { accept: 'application/json', 'user-agent': 'lastprint-keeper/0.1' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { pairs?: { pairAddress: string; liquidity?: { usd?: number } }[] | null };
      for (const p of body.pairs ?? []) {
        if (p.liquidity?.usd) this.depth.set(p.pairAddress.toLowerCase(), Math.round(p.liquidity.usd));
      }
    } catch (e) {
      this.log(`depth refresh failed: ${(e as Error).message}`);
    }
  }
}
