// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IActionFeed} from "./IActionFeed.sol";

/// @title ILastprintOrders
/// @notice Non-custodial, full-fill-only limit orders for B20 stock tokens, guarded by ActionFeed.
interface ILastprintOrders {
    /// @notice A signed limit order (EIP-712, domain name "Lastprint", version "1").
    /// @param maker Owner of `tokenIn`; receives `tokenOut`. EOA, ERC-1271 wallet, or EIP-7702 account.
    /// @param tokenIn Token the maker sells. Pulled with `transferFrom`, exactly `amountIn`.
    /// @param tokenOut Token the maker buys.
    /// @param amountIn Exact amount of `tokenIn` committed to the fill (full fills only).
    /// @param minAmountOut Absolute minimum `tokenOut` the maker must receive. This is the limit price.
    /// @param stockToken The B20 side of the pair. Must equal `tokenIn` or `tokenOut`.
    /// @param stockMultiplier The B20 UI multiplier (WAD) the maker saw when signing. Fill reverts if it changed.
    /// @param validAfter First timestamp (inclusive) at which the order can fill.
    /// @param validUntil Timestamp (exclusive) at which the order stops being fillable.
    /// @param nonce Per-maker replay protection. Single use; also invalidated by `cancel` / `cancelUpTo`.
    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address stockToken;
        uint256 stockMultiplier;
        uint256 validAfter;
        uint256 validUntil;
        uint256 nonce;
    }

    /// @param amountIn Amount of `tokenIn` actually spent (committed amount minus any refund).
    event Filled(
        bytes32 indexed orderHash,
        address indexed maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address indexed filler
    );
    event NonceCancelled(address indexed maker, uint256 nonce);
    event NoncesCancelledUpTo(address indexed maker, uint256 minNonce);

    error InvalidConfig();
    error RouterLooksLikeToken(address router);
    error RouterNotAllowed(address router);
    error InvalidOrder();
    error NotYetValid(uint256 validAfter);
    error OrderExpired(uint256 validUntil);
    error NonceAlreadyUsed(address maker, uint256 nonce);
    error InvalidSignature();
    error SignerNotDeployed(address maker);
    error MultiplierMismatch(uint256 expected, uint256 actual);
    error RouterCallFailed(bytes reason);
    error UnsupportedToken(address token);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error MinNonceNotIncreasing(uint256 current, uint256 requested);

    /// @notice Fill `order` in full by swapping through an allowlisted `router`. Permissionless.
    /// @return amountOut Amount of `tokenOut` delivered to the maker.
    function fill(Order calldata order, bytes calldata signature, address router, bytes calldata routerCalldata)
        external
        returns (uint256 amountOut);

    /// @notice Invalidate one of the caller's nonces.
    function cancel(uint256 nonce) external;

    /// @notice Invalidate every caller nonce strictly below `minNonce`. Must increase.
    function cancelUpTo(uint256 minNonce) external;

    /// @notice EIP-712 digest that the maker signs.
    function hashOrder(Order calldata order) external view returns (bytes32);

    function isNonceUsed(address maker, uint256 nonce) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
    function minNonce(address maker) external view returns (uint256);

    function actionFeed() external view returns (IActionFeed);
    function guardWindow() external view returns (uint256);
    function isRouter(address router) external view returns (bool);
    function routers() external view returns (address[] memory);
}
