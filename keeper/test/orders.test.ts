import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address, Hex } from 'viem';
import type { MarketDef } from '../src/markets.ts';
import { intakeOrder, OrderRejected, resolveMarket, validateOrderTerms, type IntakeDeps, type MarketContext } from '../src/orders.ts';
import { orderToJson, type Order } from '../src/shared/eip712.ts';
import { minAmountOutFor } from '../src/shared/pricing.ts';
import { CONTRACT, MULT, NVDAC, USDC, baseOrder } from './helpers.ts';

const NVDA: MarketDef = {
  ticker: 'NVDA',
  symbol: 'NVDAc',
  name: 'NVIDIA Corporation',
  token: NVDAC,
  decimals: 8,
  pool: '0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC',
  dex: 'aerodrome-slipstream-v3',
  tickSpacing: 10,
  quoteToken: USDC,
  quoteDecimals: 6,
  stockIsToken0: false,
  liquidityUsd: 1_400_000,
};
const MAKER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const NOW = Date.parse('2026-11-13T03:00:00Z'); // Thu 22:00 ET, market closed
const CLOSE = 16_619_000_000n;

function ctx(over: Partial<MarketContext> = {}): MarketContext {
  return { def: NVDA, closeE8: CLOSE, multiplier: MULT, pendingEffectiveAtMs: null, transfersPaused: false, ...over };
}

function terms(order: Order, over: Partial<MarketContext> = {}, nowMs = NOW) {
  return validateOrderTerms({ order, nowMs, guardWindowSec: 86_400n, market: ctx(over) });
}

function rejects(fn: () => unknown, re: RegExp, status?: number) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof OrderRejected, String(e));
    assert.match(e.message, re);
    if (status) assert.equal(e.status, status);
    return true;
  });
}

describe('order terms', () => {
  it('accepts a closed-window buy within the limit band', () => {
    const t = terms(baseOrder(MAKER));
    assert.equal(t.side, 'buy');
    assert.equal(t.ticker, 'NVDA');
    assert.ok(t.deviationBps > -10n && t.deviationBps < 20n);
  });

  it('accepts a sell built with the shared pricing helper', () => {
    const amountIn = 300_000_000n; // 3 tokens
    const minOut = minAmountOutFor('sell', amountIn, 150n, { closeE8: CLOSE, multiplier: MULT, stockDecimals: 8, quoteDecimals: 6 });
    const t = terms(baseOrder(MAKER, { tokenIn: NVDAC, tokenOut: USDC, amountIn, minAmountOut: minOut }));
    assert.equal(t.side, 'sell');
    // minOut is rounded up for the seller, so the implied price is at (never below) +1.50%
    assert.equal(t.deviationBps, 150n);
  });

  it('rejects while the US market is open', () => {
    rejects(() => terms(baseOrder(MAKER), {}, Date.parse('2026-11-13T15:00:00Z')), /market is open/, 409);
  });

  it('rejects an expiry after the next opening bell', () => {
    rejects(() => terms(baseOrder(MAKER, { validUntil: 1_794_580_201n })), /next opening bell/);
  });

  it('rejects a start before the last close', () => {
    rejects(() => terms(baseOrder(MAKER, { validAfter: 1_794_517_199n })), /after the last close/);
  });

  it('rejects an order about to expire', () => {
    rejects(() => terms(baseOrder(MAKER), {}, Date.parse('2026-11-13T14:29:30Z')), /within a minute/);
  });

  it('rejects a stale multiplier', () => {
    rejects(() => terms(baseOrder(MAKER, { stockMultiplier: 10n ** 18n })), /multiplier changed/, 409);
  });

  it('rejects when a corporate action lands before expiry + guard window; allows one far away', () => {
    const soon = Number(1_794_580_200n) * 1000 + 3_600_000;
    rejects(() => terms(baseOrder(MAKER), { pendingEffectiveAtMs: soon }), /corporate action/, 409);
    const far = Number(1_794_580_200n) * 1000 + 2 * 86_400_000;
    assert.equal(terms(baseOrder(MAKER), { pendingEffectiveAtMs: far }).ticker, 'NVDA');
  });

  it('rejects when transfers are paused', () => {
    rejects(() => terms(baseOrder(MAKER), { transfersPaused: true }), /paused/, 409);
  });

  it('rejects limits more than 30% from the last close', () => {
    // minOut for a buy 40% below the close: far more tokens per dollar
    const minOut = minAmountOutFor('buy', 1_000_000_000n, -4000n, { closeE8: CLOSE, multiplier: MULT, stockDecimals: 8, quoteDecimals: 6 });
    rejects(() => terms(baseOrder(MAKER, { minAmountOut: minOut })), /allowed range/);
  });

  it('rejects dust orders and missing close', () => {
    rejects(() => terms(baseOrder(MAKER, { amountIn: 1_000_000n, minAmountOut: 600_000n })), /at least/);
    rejects(() => terms(baseOrder(MAKER), { closeE8: null }), /last close/, 503);
  });

  it('rejects a stockToken that is not the stock side', () => {
    rejects(() => terms(baseOrder(MAKER, { stockToken: USDC })), /stock side/);
  });

  it('resolves only listed pairs', () => {
    assert.equal(resolveMarket(baseOrder(MAKER), [NVDA]).side, 'buy');
    assert.throws(() => resolveMarket(baseOrder(MAKER, { tokenOut: '0x4200000000000000000000000000000000000006' }), [NVDA]), OrderRejected);
  });
});

describe('order intake pipeline', () => {
  function deps(over: Partial<IntakeDeps['chain']> & { open?: number; known?: boolean } = {}): IntakeDeps {
    return {
      chainId: 8453,
      contract: CONTRACT,
      markets: [NVDA],
      marketContext: () => ctx(),
      guardWindowSec: 86_400n,
      openOrdersOf: () => over.open ?? 0,
      nonceKnown: () => over.known ?? false,
      now: () => NOW,
      chain: {
        checkSignature: over.checkSignature ?? (async () => ({ ok: true as const })),
        isNonceUsed: over.isNonceUsed ?? (async () => false),
        allowance: over.allowance ?? (async () => 10n ** 30n),
        balanceOf: over.balanceOf ?? (async () => 10n ** 30n),
      },
    };
  }
  const body = { order: orderToJson(baseOrder(MAKER)), signature: ('0x' + '11'.repeat(65)) as Hex };

  async function rejectsAsync(p: Promise<unknown>, re: RegExp, status: number) {
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof OrderRejected, String(e));
      assert.match(e.message, re);
      assert.equal(e.status, status);
      return true;
    });
  }

  it('accepts a valid order and returns its EIP-712 hash', async () => {
    const r = await intakeOrder(body, deps());
    assert.match(r.hash, /^0x[0-9a-f]{64}$/);
    assert.equal(r.terms.side, 'buy');
  });

  it('rejects malformed input', async () => {
    await rejectsAsync(intakeOrder({ order: { ...body.order, amountIn: '1.5' }, signature: body.signature }, deps()), /amountIn/, 400);
    await rejectsAsync(intakeOrder({ order: body.order, signature: 'nope' }, deps()), /signature/, 400);
    await rejectsAsync(intakeOrder(null, deps()), /JSON/, 400);
  });

  it('rejects a bad signature with the reason', async () => {
    await rejectsAsync(intakeOrder(body, deps({ checkSignature: async () => ({ ok: false, reason: 'Signature does not match the maker address.' }) })), /does not match/, 401);
  });

  it('rejects a used nonce, missing allowance, missing balance, too many open orders', async () => {
    await rejectsAsync(intakeOrder(body, deps({ isNonceUsed: async () => true })), /nonce/, 409);
    await rejectsAsync(intakeOrder(body, deps({ allowance: async () => 999_999_999n })), /Approve/, 402);
    await rejectsAsync(intakeOrder(body, deps({ balanceOf: async () => 0n })), /Insufficient balance/, 402);
    await rejectsAsync(intakeOrder(body, deps({ open: 25 })), /open orders/, 429);
    await rejectsAsync(intakeOrder(body, deps({ known: true })), /nonce already exists/, 409);
  });
});
