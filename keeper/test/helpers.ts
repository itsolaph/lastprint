import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  isAddressEqual,
  parseAbi,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import type { Order } from '../src/shared/eip712.ts';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
export const NVDAC = '0xb20000000000000000000078ee7ce2fE4908108C' as Address;
export const CONTRACT = '0x1a57000000000000000000000000000000000001' as Address;
export const MULT = 1_000_537_939_576_369_481n;

// Well-known test keys (anvil defaults). Never use with real funds.
export const PK1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
export const PK2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8416f8e3e2d8f7b6c1' as Hex;

const walletAbi = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

export interface FakeChain {
  /** Addresses that have code. */
  code: Map<string, Hex>;
  /** ERC-1271 wallets: address -> owner EOA. */
  wallets: Map<string, Address>;
}

/** PublicClient backed by an in-memory fake: eth_getCode and ERC-1271 eth_call only. */
export function fakeClient(chain: FakeChain): PublicClient {
  return createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_getCode') {
          const [addr] = params as [string];
          return chain.code.get(addr.toLowerCase()) ?? '0x';
        }
        if (method === 'eth_call') {
          const [{ to, data }] = params as [{ to: string; data: Hex }];
          const owner = chain.wallets.get(to.toLowerCase());
          if (!owner) throw new Error('execution reverted');
          const { args } = decodeFunctionData({ abi: walletAbi, data });
          const [hash, sig] = args as [Hex, Hex];
          let ok = false;
          try {
            ok = isAddressEqual(await recoverAddress({ hash, signature: sig }), owner);
          } catch {
            ok = false;
          }
          return encodeAbiParameters([{ type: 'bytes4' }], [ok ? '0x1626ba7e' : '0xffffffff']);
        }
        throw new Error(`unsupported ${method}`);
      },
    }),
  }) as PublicClient;
}

export function baseOrder(maker: Address, overrides: Partial<Order> = {}): Order {
  return {
    maker,
    tokenIn: USDC,
    tokenOut: NVDAC,
    amountIn: 1_000_000_000n,
    minAmountOut: 600_760_335n,
    stockToken: NVDAC,
    stockMultiplier: MULT,
    validAfter: 1_794_517_200n, // Thu 2026-11-12 16:00 ET
    validUntil: 1_794_580_200n, // Fri 2026-11-13 09:30 ET
    nonce: 1_794_539_183_761_000_042n,
    ...overrides,
  };
}
