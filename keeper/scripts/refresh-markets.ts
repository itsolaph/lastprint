/**
 * Refresh keeper/markets.json from DexScreener, then verify every candidate pool onchain.
 *
 *   node scripts/refresh-markets.ts [--min-liquidity 100000] [--out markets.json]
 *
 * A market is kept when:
 *   - DexScreener lists a Base pair B20-token / USDC with liquidity >= min (default $100k), and
 *   - the pool's factory() is the Aerodrome Slipstream V3 factory our router allowlist can trade, and
 *   - ActionFeed.status(token) returns a non-zero multiplier (i.e. it really is a B20 token).
 * The most liquid qualifying pool per ticker wins. Data: DexScreener public API (https://docs.dexscreener.com).
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getAddress, isAddress, type Address } from 'viem';
import { actionFeedAbi, clPoolAbi, erc20Abi } from '../src/abis.ts';
import { BASE, loadConfig } from '../src/config.ts';
import { makePublicClient } from '../src/chain.ts';
import type { MarketDef, MarketsFile } from '../src/markets.ts';

const B20_PREFIX = '0xb2000000000000000000';
const QUERIES = [
  B20_PREFIX,
  'NVDAc', 'AAPLc', 'TSLAc', 'MSFTc', 'AMZNc', 'METAc', 'GOOGLc', 'COINc', 'MSTRc', 'PLTRc', 'AMDc',
  'NFLXc', 'SNDKc', 'HOODc', 'AVGOc', 'SPYc', 'QQQc', 'CRCLc', 'ORCLc', 'INTCc', 'MUc', 'GMEc',
];

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  liquidity?: { usd?: number };
}

async function search(q: string): Promise<DsPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'lastprint-markets/0.1' } });
  if (!res.ok) throw new Error(`DexScreener ${res.status} for ${q}`);
  const body = (await res.json()) as { pairs?: DsPair[] | null };
  return body.pairs ?? [];
}

function isB20(addr: string): boolean {
  return addr.toLowerCase().startsWith(B20_PREFIX);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'min-liquidity': { type: 'string', default: '100000' }, out: { type: 'string', default: 'markets.json' } },
  });
  const minLiq = Number(values['min-liquidity']);
  const cfg = loadConfig();
  const client = makePublicClient(cfg);
  const usdc = BASE.usdc.toLowerCase();

  const candidates = new Map<string, DsPair>();
  for (const q of QUERIES) {
    try {
      for (const p of await search(q)) {
        if (p.chainId !== 'base') continue;
        if (!isAddress(p.pairAddress, { strict: false })) continue; // skips Uniswap v4 32-byte pool ids
        const b = p.baseToken.address, qt = p.quoteToken.address;
        const stockSide = isB20(b) && qt.toLowerCase() === usdc ? p : isB20(qt) && b.toLowerCase() === usdc ? p : null;
        if (!stockSide) continue;
        if ((p.liquidity?.usd ?? 0) < minLiq) continue;
        candidates.set(p.pairAddress.toLowerCase(), p);
      }
    } catch (e) {
      console.error(`search "${q}" failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`${candidates.size} DexScreener candidates with liquidity >= $${minLiq}`);

  const pairs = [...candidates.values()];
  const reads = await client.multicall({
    allowFailure: true,
    contracts: pairs.flatMap((p) => {
      const pool = getAddress(p.pairAddress);
      return [
        { address: pool, abi: clPoolAbi, functionName: 'factory' },
        { address: pool, abi: clPoolAbi, functionName: 'token0' },
        { address: pool, abi: clPoolAbi, functionName: 'tickSpacing' },
      ] as const;
    }),
  });

  const byTicker = new Map<string, MarketDef>();
  const stockTokens: Address[] = [];
  const kept: { p: DsPair; token: Address; token0: Address; tickSpacing: number }[] = [];
  pairs.forEach((p, i) => {
    const [f, t0, ts] = [reads[i * 3], reads[i * 3 + 1], reads[i * 3 + 2]];
    if (f?.status !== 'success' || t0?.status !== 'success' || ts?.status !== 'success') return;
    if ((f.result as string).toLowerCase() !== BASE.slipstreamFactory.toLowerCase()) return;
    const token = getAddress(isB20(p.baseToken.address) ? p.baseToken.address : p.quoteToken.address);
    kept.push({ p, token, token0: getAddress(t0.result as string), tickSpacing: Number(ts.result) });
    stockTokens.push(token);
  });

  const tokenReads = await client.multicall({
    allowFailure: true,
    contracts: stockTokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: 'decimals' },
      { address: BASE.actionFeed, abi: actionFeedAbi, functionName: 'status', args: [t] },
    ] as const),
  });

  kept.forEach((k, i) => {
    const dec = tokenReads[i * 2], st = tokenReads[i * 2 + 1];
    if (dec?.status !== 'success' || st?.status !== 'success') return;
    const status = st.result as { uiMultiplier: bigint };
    if (status.uiMultiplier === 0n) return;
    const symbol = isB20(k.p.baseToken.address) ? k.p.baseToken.symbol : k.p.quoteToken.symbol;
    const name = isB20(k.p.baseToken.address) ? k.p.baseToken.name : k.p.quoteToken.symbol;
    // Tokenized US stocks use "<TICKER>c" (NVDAc). Coinbase-wrapped crypto (cbZEC, cbHYPE) shares the B20
    // address space but has no exchange close, so it is excluded.
    if (!/^[A-Z][A-Z0-9.]{0,9}c$/.test(symbol)) return;
    const ticker = symbol.slice(0, -1);
    const def: MarketDef = {
      ticker,
      symbol,
      name,
      token: k.token,
      decimals: Number(dec.result),
      pool: getAddress(k.p.pairAddress),
      dex: 'aerodrome-slipstream-v3',
      tickSpacing: k.tickSpacing,
      quoteToken: BASE.usdc,
      quoteDecimals: 6,
      stockIsToken0: k.token0.toLowerCase() === k.token.toLowerCase(),
      liquidityUsd: Math.round(k.p.liquidity?.usd ?? 0),
    };
    const prev = byTicker.get(ticker);
    if (!prev || prev.liquidityUsd < def.liquidityUsd) byTicker.set(ticker, def);
  });

  const markets = [...byTicker.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const file: MarketsFile = {
    generatedAt: new Date().toISOString(),
    source: 'DexScreener search API + onchain factory/ActionFeed checks',
    minLiquidityUsd: minLiq,
    markets,
  };
  writeFileSync(values.out!, JSON.stringify(file, null, 2) + '\n');
  console.log(`wrote ${markets.length} markets to ${values.out}: ${markets.map((m) => m.ticker).join(', ')}`);
}

await main();
