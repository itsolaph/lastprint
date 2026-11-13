import { parseAbi } from 'viem';

export const ORDER_TUPLE =
  '(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address stockToken,uint256 stockMultiplier,uint256 validAfter,uint256 validUntil,uint256 nonce)';

export const lastprintAbi = parseAbi([
  `function fill(${ORDER_TUPLE} order, bytes signature, address router, bytes routerCalldata) returns (uint256 amountOut)`,
  'function cancel(uint256 nonce)',
  'function cancelUpTo(uint256 minNonce)',
  `function hashOrder(${ORDER_TUPLE} order) view returns (bytes32)`,
  'function isNonceUsed(address maker, uint256 nonce) view returns (bool)',
  'function minNonce(address maker) view returns (uint256)',
  'function domainSeparator() view returns (bytes32)',
  'function guardWindow() view returns (uint256)',
  'function isRouter(address router) view returns (bool)',
  'event Filled(bytes32 indexed orderHash, address indexed maker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address indexed filler)',
  'event NonceCancelled(address indexed maker, uint256 nonce)',
  'event NoncesCancelledUpTo(address indexed maker, uint256 minNonce)',
  'error InvalidConfig()',
  'error RouterLooksLikeToken(address router)',
  'error RouterNotAllowed(address router)',
  'error InvalidOrder()',
  'error NotYetValid(uint256 validAfter)',
  'error OrderExpired(uint256 validUntil)',
  'error NonceAlreadyUsed(address maker, uint256 nonce)',
  'error InvalidSignature()',
  'error SignerNotDeployed(address maker)',
  'error MultiplierMismatch(uint256 expected, uint256 actual)',
  'error RouterCallFailed(bytes reason)',
  'error UnsupportedToken(address token)',
  'error InsufficientOutput(uint256 amountOut, uint256 minAmountOut)',
  'error MinNonceNotIncreasing(uint256 current, uint256 requested)',
  'error PendingActionWithin(address token, uint256 effectiveAt, uint256 window)',
  'error TransfersPaused(address token)',
]);

export const actionFeedAbi = parseAbi([
  'struct Status { uint8 decimals; uint256 rawSupply; uint256 uiMultiplier; uint256 newUIMultiplier; uint256 effectiveAt; bool pendingLive; bool transferPaused; uint256 lastRecordedMultiplier; uint256 historyLength; bool checkpointNeeded; }',
  'function status(address token) view returns (Status)',
  'function assertStable(address token, uint256 window) view',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Aerodrome Slipstream (V3 / Metadex CL) pool. slot0 has 6 fields (no feeProtocol). */
export const clPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function factory() view returns (address)',
]);

/** Slipstream SwapRouter (ABI verified on Sourcify for 0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418). */
export const slipstreamRouterAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
]);

/**
 * Slipstream MetaQuoter (ABI verified on Sourcify for 0x1dDfeC5058180C207F55BB77D95AcDd0d8227868).
 * The function is declared nonpayable onchain (it simulates a swap); it is only ever used via eth_call,
 * so it is typed `view` here to allow multicall batching.
 */
export const metaQuoterAbi = parseAbi([
  'function quoteExactInputSingleV3(address pool, address tokenIn, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)',
]);
