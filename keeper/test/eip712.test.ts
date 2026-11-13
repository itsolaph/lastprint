import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { orderHash } from '../src/orders.ts';
import { makeNonce, orderFromJson, orderToJson } from '../src/shared/eip712.ts';
import { CONTRACT, baseOrder } from './helpers.ts';

/**
 * Shared vector with contracts/test/EIP712Vector.t.sol: the contract deployed at CONTRACT on chain 8453
 * must produce the same digest for this order. If either side changes, both tests fail.
 */
export const VECTOR_MAKER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
export const VECTOR_DIGEST = '0xdaa521a11b46354a8c15225d0b71553e96327cc295bce11c3f67ff1d29be53bf';

describe('EIP-712', () => {
  it('cross-language vector digest (also asserted by contracts/test/EIP712Vector.t.sol)', () => {
    assert.equal(orderHash(baseOrder(VECTOR_MAKER), 8453, CONTRACT), VECTOR_DIGEST);
  });

  it('JSON round trip is lossless and strict', () => {
    const o = baseOrder(VECTOR_MAKER);
    assert.deepEqual(orderFromJson(orderToJson(o)), o);
    assert.throws(() => orderFromJson({ ...orderToJson(o), nonce: '-1' }));
    assert.throws(() => orderFromJson({ ...orderToJson(o), amountIn: '01' }));
    assert.throws(() => orderFromJson({ ...orderToJson(o), maker: '0x123' }));
    assert.throws(() => orderFromJson({ ...orderToJson(o), amountIn: (1n << 256n).toString() }));
  });

  it('nonces are time ordered', () => {
    const a = makeNonce(1_000, 0.999999);
    const b = makeNonce(1_001, 0);
    assert.ok(b > a);
  });
});
