// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IActionFeed} from "./interfaces/IActionFeed.sol";
import {ILastprintOrders} from "./interfaces/ILastprintOrders.sol";

/// @title LastprintOrders
/// @notice Non-custodial limit orders for B20 tokenized stocks. Makers sign an order offchain; anyone may fill
///         it in full through an allowlisted DEX router while it is inside its signed time window. The maker
///         always receives at least `minAmountOut`, measured by balance delta.
/// @dev No owner, no admin, no fees, no upgradeability, no stored funds. Configuration is immutable.
///
///      Corporate-action guard: every fill calls `ActionFeed.assertStable(stockToken, guardWindow)` (reverts when a
///      multiplier change goes live within `guardWindow` seconds or transfers are paused) and requires the live
///      multiplier to equal `order.stockMultiplier`.
///
///      Multiplier source: the live multiplier is read from `ActionFeed.status(stockToken).uiMultiplier` rather
///      than from the token. Reasons: (1) the guard and the multiplier then come from one view of state, so they
///      cannot disagree about whether a scheduled change has already gone live; (2) ActionFeed already resolves the
///      `newUIMultiplier` / `effectiveAt` transition, so this contract does not re-implement B20 multiplier
///      semantics; (3) ActionFeed is ownerless and immutable, so it adds no trusted party. Trade-off: if ActionFeed
///      misreports, fills could be wrongly blocked or allowed; the maker's absolute `minAmountOut` still holds.
contract LastprintOrders is ILastprintOrders, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,"
        "address stockToken,uint256 stockMultiplier,uint256 validAfter,uint256 validUntil,uint256 nonce)"
    );

    /// @dev ERC-6492 wrapped-signature suffix.
    bytes32 private constant ERC6492_SUFFIX = 0x6492649264926492649264926492649264926492649264926492649264926492;

    uint256 public constant MAX_GUARD_WINDOW = 30 days;

    IActionFeed public immutable actionFeed;
    uint256 public immutable guardWindow;

    /// @dev Set once in the constructor; there is no function that writes to these afterwards.
    mapping(address => bool) private _isRouter;
    address[] private _routers;

    mapping(address => mapping(uint256 => bool)) private _nonceUsed;
    mapping(address => uint256) public minNonce;

    constructor(IActionFeed actionFeed_, uint256 guardWindow_, address[] memory routers_) EIP712("Lastprint", "1") {
        if (address(actionFeed_).code.length == 0) revert InvalidConfig();
        if (guardWindow_ == 0 || guardWindow_ > MAX_GUARD_WINDOW) revert InvalidConfig();
        if (routers_.length == 0) revert InvalidConfig();

        actionFeed = actionFeed_;
        guardWindow = guardWindow_;

        for (uint256 i = 0; i < routers_.length; ++i) {
            address r = routers_[i];
            if (r.code.length == 0 || _isRouter[r] || r == address(actionFeed_)) revert InvalidConfig();
            // Defense in depth against the one catastrophic misconfiguration: allowlisting a token as a "router"
            // would let calldata such as `transferFrom(victim, attacker, x)` spend every maker's allowance.
            // Swap routers do not implement `totalSupply()`; ERC-20 tokens do.
            (bool ok, bytes memory ret) = r.staticcall(abi.encodeWithSelector(IERC20.totalSupply.selector));
            if (ok && ret.length >= 32) revert RouterLooksLikeToken(r);
            _isRouter[r] = true;
            _routers.push(r);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fill
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc ILastprintOrders
    function fill(Order calldata order, bytes calldata signature, address router, bytes calldata routerCalldata)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        // ---- Checks that need no external call -----------------------------------------------------------------
        if (!_isRouter[router]) revert RouterNotAllowed(router);
        if (
            order.maker == address(0) || order.tokenIn == order.tokenOut || order.amountIn == 0
                || order.minAmountOut == 0 || (order.stockToken != order.tokenIn && order.stockToken != order.tokenOut)
        ) revert InvalidOrder();
        if (block.timestamp < order.validAfter) revert NotYetValid(order.validAfter);
        if (block.timestamp >= order.validUntil) revert OrderExpired(order.validUntil);

        // ---- Nonce: check and consume before any external call -------------------------------------------------
        if (isNonceUsed(order.maker, order.nonce)) revert NonceAlreadyUsed(order.maker, order.nonce);
        _nonceUsed[order.maker][order.nonce] = true;

        // ---- Signature (EOA / ERC-1271 / ERC-6492-wrapped for deployed wallets) --------------------------------
        bytes32 orderHash = _hashTypedDataV4(_structHash(order));
        _requireValidSignature(order.maker, orderHash, signature);

        // ---- Corporate-action guard (view calls) ---------------------------------------------------------------
        actionFeed.assertStable(order.stockToken, guardWindow);
        uint256 liveMultiplier = actionFeed.status(order.stockToken).uiMultiplier;
        if (liveMultiplier != order.stockMultiplier) revert MultiplierMismatch(order.stockMultiplier, liveMultiplier);

        // ---- Execution ------------------------------------------------------------------------------------------
        uint256 leftoverIn;
        (amountOut, leftoverIn) = _swap(order, router, routerCalldata);
        _payMaker(order, amountOut, leftoverIn);

        // Leftover cannot exceed what was pulled unless someone donated during the call; cap so the event is sane.
        uint256 spentIn = leftoverIn >= order.amountIn ? 0 : order.amountIn - leftoverIn;
        emit Filled(orderHash, order.maker, order.tokenIn, order.tokenOut, spentIn, amountOut, msg.sender);
    }

    /// @dev Pulls exactly `amountIn`, lets the router spend at most that, and measures the result by balance delta.
    function _swap(Order calldata order, address router, bytes calldata routerCalldata)
        private
        returns (uint256 amountOut, uint256 leftoverIn)
    {
        IERC20 tokenIn = IERC20(order.tokenIn);

        // Snapshots so that stray balances held by this contract are never counted for or paid to anyone.
        uint256 inBefore = tokenIn.balanceOf(address(this));
        uint256 outBefore = IERC20(order.tokenOut).balanceOf(address(this));

        // Pull exactly amountIn. Fee-on-transfer / deflationary tokenIn is rejected.
        tokenIn.safeTransferFrom(order.maker, address(this), order.amountIn);
        if (tokenIn.balanceOf(address(this)) - inBefore != order.amountIn) revert UnsupportedToken(order.tokenIn);

        // The router can only ever spend what this fill holds.
        tokenIn.forceApprove(router, order.amountIn);
        (bool ok, bytes memory ret) = router.call(routerCalldata);
        if (!ok) revert RouterCallFailed(ret);
        tokenIn.forceApprove(router, 0);

        // Underflow (router somehow reduced our balances below the snapshots) reverts.
        amountOut = IERC20(order.tokenOut).balanceOf(address(this)) - outBefore;
        leftoverIn = tokenIn.balanceOf(address(this)) - inBefore;
        if (amountOut < order.minAmountOut) revert InsufficientOutput(amountOut, order.minAmountOut);
    }

    /// @dev Sends all output (and any unspent input) to the maker, and verifies the maker actually received at
    ///      least `minAmountOut` (rejects fee-on-transfer tokenOut).
    function _payMaker(Order calldata order, uint256 amountOut, uint256 leftoverIn) private {
        IERC20 tokenOut = IERC20(order.tokenOut);
        uint256 makerOutBefore = tokenOut.balanceOf(order.maker);
        tokenOut.safeTransfer(order.maker, amountOut);
        if (tokenOut.balanceOf(order.maker) - makerOutBefore < order.minAmountOut) {
            revert UnsupportedToken(order.tokenOut);
        }
        if (leftoverIn > 0) IERC20(order.tokenIn).safeTransfer(order.maker, leftoverIn);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Cancellation
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc ILastprintOrders
    function cancel(uint256 nonce) external {
        _nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @inheritdoc ILastprintOrders
    function cancelUpTo(uint256 newMinNonce) external {
        uint256 current = minNonce[msg.sender];
        if (newMinNonce <= current) revert MinNonceNotIncreasing(current, newMinNonce);
        minNonce[msg.sender] = newMinNonce;
        emit NoncesCancelledUpTo(msg.sender, newMinNonce);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc ILastprintOrders
    function hashOrder(Order calldata order) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(order));
    }

    /// @inheritdoc ILastprintOrders
    function isNonceUsed(address maker, uint256 nonce) public view returns (bool) {
        return nonce < minNonce[maker] || _nonceUsed[maker][nonce];
    }

    /// @inheritdoc ILastprintOrders
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc ILastprintOrders
    function isRouter(address router) external view returns (bool) {
        return _isRouter[router];
    }

    /// @inheritdoc ILastprintOrders
    function routers() external view returns (address[] memory) {
        return _routers;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    /// @dev All Order fields are 32-byte static ABI words, so `abi.encode(typehash, order)` equals the EIP-712
    ///      `encodeData` concatenation. Verified field by field in the tests.
    function _structHash(Order calldata order) private pure returns (bytes32) {
        return keccak256(abi.encode(ORDER_TYPEHASH, order));
    }

    /// @dev ERC-6492: a wrapped signature is accepted only when the maker wallet is already deployed; the inner
    ///      signature is then checked like any other. This contract never executes the wrapper's factory call:
    ///      it holds token allowances from every maker, so an arbitrary call made from this address could spend
    ///      them. In practice a wallet must be deployed before it can approve this contract, so a fill-able
    ///      order always has a deployed maker.
    function _requireValidSignature(address maker, bytes32 digest, bytes calldata signature) private view {
        bytes memory sig = signature;
        uint256 len = signature.length;
        if (len >= 32 && bytes32(signature[len - 32:]) == ERC6492_SUFFIX) {
            if (maker.code.length == 0) revert SignerNotDeployed(maker);
            (,, sig) = abi.decode(signature[:len - 32], (address, bytes, bytes));
        }
        if (!_isValidSignatureNow(maker, digest, sig)) revert InvalidSignature();
    }

    /// @dev Contract makers are checked with ERC-1271 first. ECDSA is then tried for every maker so that EIP-7702
    ///      delegated EOAs (which have code) can still sign with their key. `tryRecover` rejects high-s and
    ///      malformed signatures; a recovered address equal to a non-7702 contract address is infeasible.
    function _isValidSignatureNow(address maker, bytes32 digest, bytes memory sig) private view returns (bool) {
        if (maker.code.length > 0 && SignatureChecker.isValidERC1271SignatureNow(maker, digest, sig)) return true;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && recovered == maker;
    }
}
