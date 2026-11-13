import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, type Address } from 'viem';
import { slipstreamRouterAbi } from '../src/abis.ts';
import type { OrderRow } from '../src/db.ts';
import { backoffMs, buildRouterCalldata, decide, type DecideInput } from '../src/keeper.ts';
import type { MarketDef } from '../src/markets.ts';
import { CONTRACT, MULT, NVDAC, USDC } from './helpers.ts';

const NOW = Date.parse('2026-11-13T03:00:00Z');
const order = {
  status: 'open' as const,
  valid_after: 1_794_517_200,
  valid_until: 1_794_580_200,
  min_amount_out: '600000000',
  stock_multiplier: MULT.toString(),
  next_attempt_at: 0,
};

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    order,
    nowMs: NOW,
    marketOpen: false,
    inFlight: false,
    liveMultiplier: MULT,
    pendingEffectiveAtMs: null,
    transfersPaused: false,
    guardWindowSec: 86_400,
    quoteOut: 601_000_000n,
    safetyBps: 15n,
    ...over,
  };
}

describe('keeper decision logic (mocked quotes)', () => {
  it('fills when the quote clears minOut by the safety margin', () => {
    assert.deepEqual(decide(input()), { action: 'fill', quoteOut: 601_000_000n });
  });

  it('waits when the quote is above minOut but inside the margin', () => {
    // 600_000_000 * 1.0015 = 600_900_000
    assert.equal(decide(input({ quoteOut: 600_899_999n })).action, 'wait');
    assert.equal(decide(input({ quoteOut: 600_900_000n })).action, 'fill');
  });

  it('waits when the limit is not reached or there is no quote', () => {
    assert.equal(decide(input({ quoteOut: 599_000_000n })).action, 'wait');
    assert.equal(decide(input({ quoteOut: null })).action, 'wait');
  });

  it('expires at validUntil (exclusive bound, same as the contract)', () => {
    assert.equal(decide(input({ nowMs: order.valid_until * 1000 })).action, 'expire');
    assert.equal(decide(input({ nowMs: order.valid_until * 1000 - 1 })).action, 'fill');
  });

  it('never fills while the US market is open', () => {
    assert.equal(decide(input({ marketOpen: true })).action, 'wait');
  });

  it('waits before validAfter', () => {
    assert.equal(decide(input({ nowMs: order.valid_after * 1000 - 1000 })).action, 'wait');
  });

  it('one fill in flight per order, and respects backoff', () => {
    assert.equal(decide(input({ inFlight: true })).action, 'skip');
    assert.equal(decide(input({ order: { ...order, next_attempt_at: NOW + 1 } })).action, 'skip');
    assert.equal(decide(input({ order: { ...order, status: 'filling' } })).action, 'skip');
  });

  it('voids an order whose multiplier no longer matches (it can never fill)', () => {
    assert.equal(decide(input({ liveMultiplier: MULT * 2n })).action, 'void');
    assert.equal(decide(input({ liveMultiplier: null })).action, 'wait');
  });

  it('waits on a pending corporate action inside the guard window or paused transfers', () => {
    assert.equal(decide(input({ pendingEffectiveAtMs: NOW + 3_600_000 })).action, 'wait');
    assert.equal(decide(input({ pendingEffectiveAtMs: NOW + 86_400_000 + 1000 })).action, 'fill');
    assert.equal(decide(input({ transfersPaused: true })).action, 'wait');
  });

  it('backs off exponentially with a cap', () => {
    assert.equal(backoffMs(1), 15_000);
    assert.equal(backoffMs(2), 30_000);
    assert.equal(backoffMs(3), 60_000);
    assert.equal(backoffMs(20), 600_000);
  });
});

describe('router calldata', () => {
  it('encodes Slipstream exactInputSingle paying the Lastprint contract', () => {
    const m = { tickSpacing: 10 } as MarketDef;
    const row = { token_in: USDC.toLowerCase(), token_out: NVDAC.toLowerCase(), amount_in: '1000000000', min_amount_out: '600000000' } as OrderRow;
    const data = buildRouterCalldata(row, m, CONTRACT, 1_794_540_000n);
    const { functionName, args } = decodeFunctionData({ abi: slipstreamRouterAbi, data });
    assert.equal(functionName, 'exactInputSingle');
    const p = (args as unknown as [{ tokenIn: Address; tokenOut: Address; tickSpacing: number; recipient: Address; deadline: bigint; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }])[0];
    assert.equal(p.recipient.toLowerCase(), CONTRACT);
    assert.equal(p.tickSpacing, 10);
    assert.equal(p.amountIn, 1_000_000_000n);
    assert.equal(p.amountOutMinimum, 600_000_000n);
    assert.equal(p.sqrtPriceLimitX96, 0n);
    assert.equal(p.deadline, 1_794_540_000n);
  });
});
