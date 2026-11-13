import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address } from 'viem';

export interface MarketDef {
  /** US ticker of the underlying share, e.g. "NVDA". */
  ticker: string;
  /** Token symbol, e.g. "NVDAc". */
  symbol: string;
  name: string;
  token: Address;
  decimals: number;
  pool: Address;
  dex: 'aerodrome-slipstream-v3';
  tickSpacing: number;
  quoteToken: Address;
  quoteDecimals: number;
  /** True when the B20 token is token0 of the pool. */
  stockIsToken0: boolean;
  /** Pool liquidity in USD reported by DexScreener at refresh time (informational). */
  liquidityUsd: number;
}

export interface MarketsFile {
  generatedAt: string;
  source: string;
  minLiquidityUsd: number;
  markets: MarketDef[];
}

export function parseMarketsFile(json: unknown): MarketsFile {
  const f = json as MarketsFile;
  if (!f || !Array.isArray(f.markets)) throw new Error('markets.json: missing markets[]');
  const seen = new Set<string>();
  for (const m of f.markets) {
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(m.ticker)) throw new Error(`markets.json: bad ticker ${m.ticker}`);
    if (seen.has(m.ticker)) throw new Error(`markets.json: duplicate ticker ${m.ticker}`);
    seen.add(m.ticker);
    for (const k of ['token', 'pool', 'quoteToken'] as const) {
      if (!isAddress(m[k])) throw new Error(`markets.json: ${m.ticker}.${k} is not an address`);
      m[k] = getAddress(m[k]);
    }
    if (m.dex !== 'aerodrome-slipstream-v3') throw new Error(`markets.json: ${m.ticker} unsupported dex ${m.dex}`);
    if (!Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 36) throw new Error(`markets.json: ${m.ticker} decimals`);
    if (!Number.isInteger(m.tickSpacing) || m.tickSpacing <= 0) throw new Error(`markets.json: ${m.ticker} tickSpacing`);
  }
  return f;
}

export function loadMarkets(path: string): MarketsFile {
  return parseMarketsFile(JSON.parse(readFileSync(path, 'utf8')));
}
