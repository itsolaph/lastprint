import { getAddress, isAddress, type Address, type Hex } from 'viem';

/** Base mainnet constants (verified onchain, see README "Addresses"). */
export const BASE = {
  chainId: 8453,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  weth: '0x4200000000000000000000000000000000000006' as Address,
  actionFeed: '0xC455472cd39029F8309F0D762Ee587D65A596Fe2' as Address,
  /** Aerodrome Slipstream V3 (Metadex CL) deployment used by the NVDAc/USDC pool. */
  slipstreamFactory: '0x9CB220581b91b0C83223012FE69688b92aD07a76' as Address,
  slipstreamRouter: '0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418' as Address,
  slipstreamMetaQuoter: '0x1dDfeC5058180C207F55BB77D95AcDd0d8227868' as Address,
} as const;

export interface Config {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: number;
  lastprintAddress: Address | null;
  deployBlock: bigint;
  actionFeed: Address;
  router: Address;
  metaQuoter: Address;
  keeperPrivateKey: Hex | null;
  dbPath: string;
  marketsPath: string;
  loopIntervalMs: number;
  safetyBps: bigint;
  maxFeeGwei: number;
  maxPriorityFeeGwei: number;
  gasLimitCap: bigint;
  referenceUsd: bigint;
  telegramBotToken: string | null;
  telegramBotUsername: string | null;
  publicUrl: string;
  repoUrl: string;
  logRangeBlocks: bigint;
}

function str(env: NodeJS.ProcessEnv, k: string, d: string): string {
  const v = env[k];
  return v === undefined || v.trim() === '' ? d : v.trim();
}

function num(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const v = env[k];
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
  return n;
}

function optAddress(env: NodeJS.ProcessEnv, k: string): Address | null {
  const v = env[k]?.trim();
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${k} is not a valid address`);
  return getAddress(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pk = env.KEEPER_PRIVATE_KEY?.trim();
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    // Never echo the value.
    throw new Error('KEEPER_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex string');
  }
  return {
    host: str(env, 'HOST', '127.0.0.1'),
    port: num(env, 'PORT', 18797),
    rpcUrl: str(env, 'RPC_URL', 'https://base.drpc.org'),
    chainId: num(env, 'CHAIN_ID', BASE.chainId),
    lastprintAddress: optAddress(env, 'LASTPRINT_ADDRESS'),
    deployBlock: BigInt(str(env, 'LASTPRINT_DEPLOY_BLOCK', '0')),
    actionFeed: optAddress(env, 'ACTION_FEED') ?? BASE.actionFeed,
    router: optAddress(env, 'ROUTER') ?? BASE.slipstreamRouter,
    metaQuoter: optAddress(env, 'META_QUOTER') ?? BASE.slipstreamMetaQuoter,
    keeperPrivateKey: pk ? (pk as Hex) : null,
    dbPath: str(env, 'DB_PATH', 'data/lastprint.sqlite'),
    marketsPath: str(env, 'MARKETS_PATH', 'markets.json'),
    loopIntervalMs: num(env, 'LOOP_INTERVAL_MS', 5000),
    safetyBps: BigInt(num(env, 'SAFETY_BPS', 15)),
    maxFeeGwei: num(env, 'MAX_FEE_GWEI', 0.5),
    maxPriorityFeeGwei: num(env, 'MAX_PRIORITY_FEE_GWEI', 0.01),
    gasLimitCap: BigInt(num(env, 'GAS_LIMIT_CAP', 900_000)),
    referenceUsd: BigInt(num(env, 'REFERENCE_USD', 1000)),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || null,
    publicUrl: str(env, 'PUBLIC_URL', 'http://127.0.0.1:18797'),
    repoUrl: str(env, 'REPO_URL', 'https://github.com/itsolaph/lastprint'),
    logRangeBlocks: BigInt(num(env, 'LOG_RANGE_BLOCKS', 2000)),
  };
}
