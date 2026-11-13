/**
 * EIP-712 definitions shared by the keeper and the web app. Must match LastprintOrders.sol exactly:
 * Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,
 *       address stockToken,uint256 stockMultiplier,uint256 validAfter,uint256 validUntil,uint256 nonce)
 */
import type { Address, Hex, TypedDataDomain } from 'viem';

export const DOMAIN_NAME = 'Lastprint';
export const DOMAIN_VERSION = '1';

export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'stockToken', type: 'address' },
    { name: 'stockMultiplier', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Offchain cancel message. Signed by the maker; only stops this keeper (see README for onchain cancel). */
export const CANCEL_TYPES = {
  CancelOrder: [{ name: 'orderHash', type: 'bytes32' }],
} as const;

export interface Order {
  maker: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  stockToken: Address;
  stockMultiplier: bigint;
  validAfter: bigint;
  validUntil: bigint;
  nonce: bigint;
}

/** JSON wire format: all integers as decimal strings. */
export interface OrderJson {
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  stockToken: string;
  stockMultiplier: string;
  validAfter: string;
  validUntil: string;
  nonce: string;
}

export function orderDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

export function orderToJson(o: Order): OrderJson {
  return {
    maker: o.maker,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amountIn.toString(),
    minAmountOut: o.minAmountOut.toString(),
    stockToken: o.stockToken,
    stockMultiplier: o.stockMultiplier.toString(),
    validAfter: o.validAfter.toString(),
    validUntil: o.validUntil.toString(),
    nonce: o.nonce.toString(),
  };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !ADDR.test(v)) throw new Error(`${field}: expected a 0x address`);
  return v as Address;
}

function uint(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !UINT.test(v)) throw new Error(`${field}: expected a decimal integer string`);
  const b = BigInt(v);
  if (b > UINT256_MAX) throw new Error(`${field}: exceeds uint256`);
  return b;
}

/** Strict parser for untrusted JSON. Throws with a field-specific message. */
export function orderFromJson(j: unknown): Order {
  if (typeof j !== 'object' || j === null) throw new Error('order: expected an object');
  const o = j as Record<string, unknown>;
  return {
    maker: addr(o.maker, 'maker'),
    tokenIn: addr(o.tokenIn, 'tokenIn'),
    tokenOut: addr(o.tokenOut, 'tokenOut'),
    amountIn: uint(o.amountIn, 'amountIn'),
    minAmountOut: uint(o.minAmountOut, 'minAmountOut'),
    stockToken: addr(o.stockToken, 'stockToken'),
    stockMultiplier: uint(o.stockMultiplier, 'stockMultiplier'),
    validAfter: uint(o.validAfter, 'validAfter'),
    validUntil: uint(o.validUntil, 'validUntil'),
    nonce: uint(o.nonce, 'nonce'),
  };
}

export function isHex(v: unknown, maxBytes = 8192): v is Hex {
  return typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v) && v.length <= 2 + maxBytes * 2;
}

/**
 * Nonces are time-ordered (ms * 1e6 + 6 random digits) so `cancelUpTo(nonceNow)` cancels every
 * earlier order of the maker in one transaction.
 */
export function makeNonce(nowMs: number, rand: number): bigint {
  const r = BigInt(Math.floor(rand * 1_000_000) % 1_000_000);
  return BigInt(Math.floor(nowMs)) * 1_000_000n + r;
}
