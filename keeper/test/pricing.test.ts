import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BPS,
  E8,
  WAD,
  clearsWithMargin,
  deviationBps,
  formatFixed,
  impliedPerShareE8,
  limitPerShareE8,
  minAmountOutFor,
  parseDecimal,
  stockMidFromSqrtX96,
} from '../src/shared/pricing.ts';

const NVDA = { closeE8: 16_619_000_000n, multiplier: 1_000_537_939_576_369_481n, stockDecimals: 8, quoteDecimals: 6 };

describe('pricing', () => {
  it('parses and formats decimals exactly', () => {
    assert.equal(parseDecimal('166.19', 8), 16_619_000_000n);
    assert.equal(parseDecimal('0.000000019', 8), 1n); // truncates beyond 8 dp
    assert.equal(parseDecimal('12', 6), 12_000_000n);
    assert.throws(() => parseDecimal('-1', 6));
    assert.throws(() => parseDecimal('1e5', 6));
    assert.equal(formatFixed(16_619_000_000n, 8, 2), '166.19');
    assert.equal(formatFixed(123_456_789_000_000n, 6, 2), '123,456,789.00');
    assert.equal(formatFixed(-150n, 2, 2), '-1.50');
  });

  it('limit per share applies bps to the close', () => {
    assert.equal(limitPerShareE8(16_619_000_000n, -200n), 16_286_620_000n);
    assert.equal(limitPerShareE8(16_619_000_000n, 0n), 16_619_000_000n);
  });

  it('sell at 0 bps with multiplier 1 returns exactly close * tokens', () => {
    const ctx = { ...NVDA, multiplier: WAD };
    assert.equal(minAmountOutFor('sell', 100_000_000n, 0n, ctx), 166_190_000n);
  });

  for (const bps of [-2999n, -200n, -1n, 0n, 37n, 2999n]) {
    it(`buy minOut is the smallest output that honours the limit (bps ${bps})`, () => {
      const amountIn = 1_000_000_000n; // 1000 USDC
      const minOut = minAmountOutFor('buy', amountIn, bps, NVDA);
      // tokens * price >= usd  <=>  minOut * closeE8*(BPS+bps)*mult * 10^qd >= amountIn * 10^sd * E8*BPS*WAD
      const lhs = (x: bigint) => x * NVDA.closeE8 * (BPS + bps) * NVDA.multiplier * 10n ** 6n;
      const rhs = amountIn * 10n ** 8n * E8 * BPS * WAD;
      assert.ok(lhs(minOut) >= rhs, 'minOut honours limit');
      assert.ok(lhs(minOut - 1n) < rhs, 'minOut is minimal');
    });

    it(`sell minOut is the smallest output that honours the limit (bps ${bps})`, () => {
      const amountIn = 602_000_000n; // 6.02 tokens
      const minOut = minAmountOutFor('sell', amountIn, bps, NVDA);
      const lhs = (x: bigint) => x * 10n ** 8n * E8 * BPS * WAD;
      const rhs = amountIn * NVDA.closeE8 * (BPS + bps) * NVDA.multiplier * 10n ** 6n;
      assert.ok(lhs(minOut) >= rhs);
      assert.ok(lhs(minOut - 1n) < rhs);
    });
  }

  it('implied price round-trips to the limit within rounding', () => {
    const amountIn = 1_000_000_000n;
    const minOut = minAmountOutFor('buy', amountIn, -200n, NVDA);
    const implied = impliedPerShareE8('buy', amountIn, minOut, NVDA);
    const limit = limitPerShareE8(NVDA.closeE8, -200n);
    assert.ok(implied <= limit, 'buyer never pays above the limit');
    assert.ok(limit - implied < 100_000n, 'within 0.001 USD');
    assert.equal(deviationBps(implied, NVDA.closeE8), -200n);
  });

  it('multiplier scales the per-token price', () => {
    // With multiplier 2 (2 shares per token) the same USD buys half the tokens.
    const one = minAmountOutFor('buy', 1_000_000_000n, 0n, { ...NVDA, multiplier: WAD });
    const two = minAmountOutFor('buy', 1_000_000_000n, 0n, { ...NVDA, multiplier: 2n * WAD });
    assert.ok(two * 2n - one <= 1n);
  });

  it('rejects nonsense inputs', () => {
    assert.throws(() => minAmountOutFor('buy', 0n, 0n, NVDA));
    assert.throws(() => minAmountOutFor('buy', 1n, -10_000n, NVDA));
    assert.throws(() => minAmountOutFor('buy', 1n, 0n, { ...NVDA, closeE8: 0n }));
  });

  it('safety margin check is integer and rounds up', () => {
    assert.equal(clearsWithMargin(10_015n, 10_000n, 15n), true);
    assert.equal(clearsWithMargin(10_014n, 10_000n, 15n), false);
    // 100 * 1.0015 = 100.15 -> rounds up to 101
    assert.equal(clearsWithMargin(100n, 100n, 15n), false);
    assert.equal(clearsWithMargin(101n, 100n, 15n), true);
    assert.equal(clearsWithMargin(100n, 100n, 0n), true);
  });

  it('mid price from a real NVDAc/USDC slot0 (token0 USDC, token1 NVDAc, 8 dp)', () => {
    const sqrt = 0xc684d67318aeee8d98d7faden;
    const mid = stockMidFromSqrtX96(sqrt, false, 8, 6);
    assert.ok(mid > 160 && mid < 172, `mid ${mid}`);
    // Symmetric case: if the stock were token0 the same sqrt maps to the inverse orientation.
    const inv = stockMidFromSqrtX96(sqrt, true, 6, 8);
    assert.ok(Math.abs(inv * mid - 1) < 1e-9);
  });
});
