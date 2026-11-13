// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {LastprintOrders} from "../src/LastprintOrders.sol";
import {ILastprintOrders} from "../src/interfaces/ILastprintOrders.sol";
import {IActionFeed} from "../src/interfaces/IActionFeed.sol";

import {MockERC20, MockB20, MockNoReturnToken, MockFeeToken} from "./mocks/MockTokens.sol";
import {MockActionFeed} from "./mocks/MockActionFeed.sol";
import {MockRouter, ReentrantRouter} from "./mocks/MockRouters.sol";
import {MockSmartWallet, BadMagicWallet, ReentrantToken} from "./mocks/MockWallets.sol";

contract LastprintOrdersTest is Test {
    LastprintOrders internal orders;
    MockActionFeed internal feed;
    MockRouter internal router;
    ReentrantRouter internal reentrantRouter;
    MockERC20 internal usdc;
    MockB20 internal stock;

    address internal maker;
    uint256 internal makerPk;
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant MULT = 1.000537939576369481e18;
    uint256 internal constant GUARD = 1 days;
    uint256 internal constant T0 = 1_800_000_000;
    // 166 USDC per whole token (8 decimals): USDC raw -> stock raw, and back.
    uint256 internal constant RATE_BUY = uint256(1e18) * 1e8 / (166 * 1e6);
    uint256 internal constant RATE_SELL = uint256(166e6) * 1e18 / 1e8;

    bytes32 internal constant ERC6492_SUFFIX = 0x6492649264926492649264926492649264926492649264926492649264926492;

    function setUp() public {
        vm.warp(T0);
        (maker, makerPk) = makeAddrAndKey("maker");

        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock = new MockB20("NVIDIA", "NVDAc", 8);
        stock.setMultiplierNow(MULT);
        feed = new MockActionFeed();
        router = new MockRouter();
        reentrantRouter = new ReentrantRouter();

        address[] memory rs = new address[](2);
        rs[0] = address(router);
        rs[1] = address(reentrantRouter);
        orders = new LastprintOrders(IActionFeed(address(feed)), GUARD, rs);

        router.setRate(address(usdc), address(stock), RATE_BUY);
        router.setRate(address(stock), address(usdc), RATE_SELL);
        usdc.mint(address(router), 1e15);
        stock.mint(address(router), 1e15);

        usdc.mint(maker, 1_000_000e6);
        stock.mint(maker, 10_000e8);
        vm.startPrank(maker);
        usdc.approve(address(orders), type(uint256).max);
        stock.approve(address(orders), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------- helpers

    function _buyOrder(uint256 amountIn, uint256 minOut) internal view returns (ILastprintOrders.Order memory o) {
        o = ILastprintOrders.Order({
            maker: maker,
            tokenIn: address(usdc),
            tokenOut: address(stock),
            amountIn: amountIn,
            minAmountOut: minOut,
            stockToken: address(stock),
            stockMultiplier: MULT,
            validAfter: T0 - 1 hours,
            validUntil: T0 + 10 hours,
            nonce: 1
        });
    }

    function _sellOrder(uint256 amountIn, uint256 minOut) internal view returns (ILastprintOrders.Order memory o) {
        o = _buyOrder(amountIn, minOut);
        o.tokenIn = address(stock);
        o.tokenOut = address(usdc);
        o.nonce = 2;
    }

    function _sign(uint256 pk, ILastprintOrders.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, orders.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function _swapData(ILastprintOrders.Order memory o) internal view returns (bytes memory) {
        return abi.encodeCall(MockRouter.swap, (o.tokenIn, o.tokenOut, o.amountIn, address(orders)));
    }

    function _fill(ILastprintOrders.Order memory o, bytes memory sig) internal returns (uint256) {
        vm.prank(keeper);
        return orders.fill(o, sig, address(router), _swapData(o));
    }

    function _assertNoDust() internal view {
        assertEq(usdc.balanceOf(address(orders)), 0, "usdc dust");
        assertEq(stock.balanceOf(address(orders)), 0, "stock dust");
        assertEq(usdc.allowance(address(orders), address(router)), 0, "usdc allowance");
        assertEq(stock.allowance(address(orders), address(router)), 0, "stock allowance");
    }

    // ---------------------------------------------------------------------------------------------- happy paths

    function test_buy_happyPath() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        uint256 expectedOut = 1000e6 * RATE_BUY / 1e18;
        bytes32 h = orders.hashOrder(o);

        vm.expectEmit(address(orders));
        emit ILastprintOrders.Filled(h, maker, address(usdc), address(stock), 1000e6, expectedOut, keeper);
        uint256 out = _fill(o, _sign(makerPk, o));

        assertEq(out, expectedOut);
        assertEq(stock.balanceOf(maker), 10_000e8 + expectedOut);
        assertEq(usdc.balanceOf(maker), 1_000_000e6 - 1000e6);
        assertTrue(orders.isNonceUsed(maker, 1));
        _assertNoDust();
    }

    function test_sell_happyPath() public {
        ILastprintOrders.Order memory o = _sellOrder(10e8, 1650e6);
        uint256 out = _fill(o, _sign(makerPk, o));
        assertEq(out, 1660e6);
        assertEq(usdc.balanceOf(maker), 1_000_000e6 + 1660e6);
        assertEq(stock.balanceOf(maker), 10_000e8 - 10e8);
        _assertNoDust();
    }

    function test_fill_exactlyMinOut() public {
        uint256 expectedOut = 1000e6 * RATE_BUY / 1e18;
        ILastprintOrders.Order memory o = _buyOrder(1000e6, expectedOut);
        assertEq(_fill(o, _sign(makerPk, o)), expectedOut);
    }

    // ---------------------------------------------------------------------------------------------- time window

    function test_revert_beforeValidAfter() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.validAfter = T0 + 1;
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NotYetValid.selector, T0 + 1));
        _fill(o, sig);
        vm.warp(T0 + 1);
        _fill(o, sig); // inclusive lower bound
    }

    function test_revert_atValidUntil() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.warp(o.validUntil);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.OrderExpired.selector, o.validUntil));
        _fill(o, sig);
        vm.warp(o.validUntil - 1);
        _fill(o, sig); // last valid second
    }

    // ---------------------------------------------------------------------------------------------- nonces

    function test_revert_replay() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        _fill(o, sig);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NonceAlreadyUsed.selector, maker, 1));
        _fill(o, sig);
    }

    function test_revert_sameNonceDifferentOrder() public {
        ILastprintOrders.Order memory a = _buyOrder(1000e6, 6e8);
        ILastprintOrders.Order memory b = _buyOrder(500e6, 3e8);
        _fill(a, _sign(makerPk, a));
        bytes memory sigB = _sign(makerPk, b);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NonceAlreadyUsed.selector, maker, 1));
        _fill(b, sigB);
    }

    function test_cancel() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectEmit(address(orders));
        emit ILastprintOrders.NonceCancelled(maker, 1);
        vm.prank(maker);
        orders.cancel(1);
        assertTrue(orders.isNonceUsed(maker, 1));
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NonceAlreadyUsed.selector, maker, 1));
        _fill(o, sig);
    }

    function test_cancel_onlyAffectsCaller() public {
        vm.prank(attacker);
        orders.cancel(1);
        assertFalse(orders.isNonceUsed(maker, 1));
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        _fill(o, _sign(makerPk, o));
    }

    function test_cancelUpTo() public {
        ILastprintOrders.Order memory low = _buyOrder(1000e6, 6e8);
        low.nonce = 99;
        ILastprintOrders.Order memory high = _buyOrder(1000e6, 6e8);
        high.nonce = 100;
        bytes memory sigLow = _sign(makerPk, low);
        bytes memory sigHigh = _sign(makerPk, high);

        vm.expectEmit(address(orders));
        emit ILastprintOrders.NoncesCancelledUpTo(maker, 100);
        vm.prank(maker);
        orders.cancelUpTo(100);
        assertEq(orders.minNonce(maker), 100);

        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NonceAlreadyUsed.selector, maker, 99));
        _fill(low, sigLow);
        _fill(high, sigHigh);

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.MinNonceNotIncreasing.selector, 100, 100));
        orders.cancelUpTo(100);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.MinNonceNotIncreasing.selector, 100, 5));
        orders.cancelUpTo(5);
    }

    // ---------------------------------------------------------------------------------------------- signatures

    function test_revert_wrongSigner() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        (, uint256 otherPk) = makeAddrAndKey("other");
        bytes memory sig = _sign(otherPk, o);
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, sig);
    }

    function test_revert_tamperedOrder() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        o.minAmountOut = 1; // filler lowers the limit
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, sig);
    }

    function test_revert_highSMalleableSignature() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, orders.hashOrder(o));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, abi.encodePacked(r, s2, v2));
    }

    function test_revert_garbageSignature() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, hex"deadbeef");
    }

    function test_erc1271_smartWallet() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("walletOwner");
        MockSmartWallet wallet = new MockSmartWallet(owner);
        usdc.mint(address(wallet), 5000e6);
        vm.prank(owner);
        wallet.approve(IERC20(address(usdc)), address(orders), 1000e6);

        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.maker = address(wallet);
        uint256 out = _fill(o, _sign(ownerPk, o));
        assertEq(stock.balanceOf(address(wallet)), out);
        assertEq(usdc.balanceOf(address(wallet)), 4000e6);
        _assertNoDust();
    }

    function test_revert_erc1271_wrongOwner() public {
        (address owner,) = makeAddrAndKey("walletOwner");
        MockSmartWallet wallet = new MockSmartWallet(owner);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.maker = address(wallet);
        bytes memory sig = _sign(makerPk, o); // signed by someone else
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, sig);
    }

    function test_revert_erc1271_badMagic() public {
        BadMagicWallet wallet = new BadMagicWallet();
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.maker = address(wallet);
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, hex"00");
    }

    function test_erc6492_wrappedSignature_deployedWallet() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("walletOwner");
        MockSmartWallet wallet = new MockSmartWallet(owner);
        usdc.mint(address(wallet), 1000e6);
        vm.prank(owner);
        wallet.approve(IERC20(address(usdc)), address(orders), 1000e6);

        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.maker = address(wallet);
        bytes memory inner = _sign(ownerPk, o);
        // Factory call must NOT be executed: point it at USDC with a transferFrom that would steal funds.
        bytes memory evil = abi.encodeCall(IERC20.transferFrom, (maker, attacker, 1000e6));
        bytes memory wrapped = abi.encodePacked(abi.encode(address(usdc), evil, inner), ERC6492_SUFFIX);
        _fill(o, wrapped);
        assertEq(usdc.balanceOf(attacker), 0);
        assertGt(stock.balanceOf(address(wallet)), 0);
    }

    function test_revert_erc6492_undeployedWallet() public {
        address counterfactual = makeAddr("counterfactual");
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.maker = counterfactual;
        bytes memory wrapped = abi.encodePacked(abi.encode(address(0x1234), hex"", hex"00"), ERC6492_SUFFIX);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.SignerNotDeployed.selector, counterfactual));
        _fill(o, wrapped);
    }

    function test_eip7702_delegatedEoa_canStillSignWithKey() public {
        // An EIP-7702 account has code (0xef0100 || delegate). Its key must still be accepted.
        vm.etch(maker, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        _fill(o, _sign(makerPk, o));
        assertTrue(orders.isNonceUsed(maker, 1));
    }

    function test_revert_crossChainReplay() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.chainId(10);
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        _fill(o, sig);
    }

    function test_revert_crossContractReplay() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        address[] memory rs = new address[](1);
        rs[0] = address(router);
        LastprintOrders other = new LastprintOrders(IActionFeed(address(feed)), GUARD, rs);
        vm.prank(maker);
        usdc.approve(address(other), type(uint256).max);
        vm.prank(keeper);
        vm.expectRevert(ILastprintOrders.InvalidSignature.selector);
        other.fill(
            o,
            sig,
            address(router),
            abi.encodeCall(MockRouter.swap, (o.tokenIn, o.tokenOut, o.amountIn, address(other)))
        );
    }

    // ---------------------------------------------------------------------------------------------- ActionFeed guard

    function test_revert_multiplierMismatch() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.stockMultiplier = 1e18; // stale
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.MultiplierMismatch.selector, 1e18, MULT));
        _fill(o, sig);
    }

    function test_revert_multiplierChangedAfterSigning() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        // A 2:1 split scheduled 2 days out is outside the guard window: order still fills right now ...
        stock.scheduleMultiplier(MULT * 2, T0 + 2 days);
        o.validUntil = T0 + 3 days;
        sig = _sign(makerPk, o);
        // ... but once it is live, the order (bound to MULT) can never fill.
        vm.warp(T0 + 2 days + 1);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.MultiplierMismatch.selector, MULT, MULT * 2));
        _fill(o, sig);
    }

    function test_pendingActionOutsideWindow_fills() public {
        stock.scheduleMultiplier(MULT * 2, T0 + GUARD + 1);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        _fill(o, _sign(makerPk, o));
    }

    function test_revert_pendingActionWithinWindow() public {
        uint256 at = T0 + 12 hours;
        stock.scheduleMultiplier(MULT * 2, at);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(abi.encodeWithSelector(IActionFeed.PendingActionWithin.selector, address(stock), at, GUARD));
        _fill(o, sig);
    }

    function test_revert_pendingActionAtWindowEdge() public {
        uint256 at = T0 + GUARD;
        stock.scheduleMultiplier(MULT * 2, at);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(abi.encodeWithSelector(IActionFeed.PendingActionWithin.selector, address(stock), at, GUARD));
        _fill(o, sig);
    }

    function test_revert_pausedTransfers() public {
        stock.setPaused(true);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(abi.encodeWithSelector(IActionFeed.TransfersPaused.selector, address(stock)));
        _fill(o, sig);
    }

    function test_revert_stockTokenNotInPair() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        MockB20 other = new MockB20("Other", "OTHc", 8);
        o.stockToken = address(other); // would point the guard at an unrelated token
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(ILastprintOrders.InvalidOrder.selector);
        _fill(o, sig);
    }

    // ---------------------------------------------------------------------------------------------- execution

    function test_revert_minOutNotMet() public {
        uint256 expectedOut = 1000e6 * RATE_BUY / 1e18;
        ILastprintOrders.Order memory o = _buyOrder(1000e6, expectedOut + 1);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(
            abi.encodeWithSelector(ILastprintOrders.InsufficientOutput.selector, expectedOut, expectedOut + 1)
        );
        _fill(o, sig);
        assertFalse(orders.isNonceUsed(maker, 1), "nonce rolled back");
    }

    function test_revert_routerNotAllowlisted() public {
        MockRouter rogue = new MockRouter();
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.RouterNotAllowed.selector, address(rogue)));
        orders.fill(o, sig, address(rogue), _swapData(o));
    }

    function test_revert_tokenAsRouterNotAllowlisted() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        bytes memory steal = abi.encodeCall(IERC20.transferFrom, (maker, attacker, 1000e6));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.RouterNotAllowed.selector, address(usdc)));
        orders.fill(o, sig, address(usdc), steal);
    }

    function test_leftoverRefund_andApprovalReset() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 3e8);
        bytes memory sig = _sign(makerPk, o);
        bytes memory data =
            abi.encodeCall(MockRouter.swapPartial, (address(usdc), address(stock), 600e6, address(orders)));
        uint256 expectedOut = 600e6 * RATE_BUY / 1e18;
        bytes32 h = orders.hashOrder(o);
        vm.expectEmit(address(orders));
        emit ILastprintOrders.Filled(h, maker, address(usdc), address(stock), 600e6, expectedOut, keeper);
        vm.prank(keeper);
        orders.fill(o, sig, address(router), data);
        assertEq(usdc.balanceOf(maker), 1_000_000e6 - 600e6, "refund");
        assertEq(stock.balanceOf(maker), 10_000e8 + expectedOut);
        _assertNoDust(); // includes allowance(orders, router) == 0 although 400e6 were left unspent
    }

    function test_revert_maliciousCalldata_outputToAttacker() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        bytes memory data = abi.encodeCall(MockRouter.swap, (address(usdc), address(stock), 1000e6, attacker));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.InsufficientOutput.selector, 0, 6e8));
        orders.fill(o, sig, address(router), data);
        assertEq(usdc.balanceOf(maker), 1_000_000e6);
        assertEq(stock.balanceOf(attacker), 0);
    }

    function test_revert_maliciousCalldata_overpull() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        bytes memory data = abi.encodeCall(MockRouter.overpull, (address(usdc), 1000e6 + 1));
        vm.prank(attacker);
        vm.expectRevert(); // ERC20InsufficientAllowance bubbled inside RouterCallFailed
        orders.fill(o, sig, address(router), data);
    }

    function test_revert_maliciousCalldata_pullFromMaker() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        // The router has no allowance from the maker; only this contract does.
        bytes memory data = abi.encodeCall(MockRouter.pullFrom, (address(usdc), maker, 500_000e6));
        vm.prank(attacker);
        vm.expectRevert();
        orders.fill(o, sig, address(router), data);
        assertEq(usdc.balanceOf(maker), 1_000_000e6);
    }

    function test_revert_routerFailureBubbles() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        bytes memory reason = abi.encodeWithSignature("Error(string)", "router: boom");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.RouterCallFailed.selector, reason));
        orders.fill(o, sig, address(router), abi.encodeCall(MockRouter.fail, ()));
    }

    function test_revert_reentrancyViaRouter() public {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        ILastprintOrders.Order memory o2 = _buyOrder(1000e6, 6e8);
        o2.nonce = 7;
        reentrantRouter.arm(orders, o2, _sign(makerPk, o2));
        bytes memory inner = abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.RouterCallFailed.selector, inner));
        orders.fill(o, sig, address(reentrantRouter), abi.encodeCall(ReentrantRouter.attack, ()));
    }

    function test_reentrancyViaToken_blocked() public {
        ReentrantToken hook = new ReentrantToken();
        hook.mint(maker, 1000e18);
        hook.mint(address(router), 1000e18);
        router.setRate(address(hook), address(stock), 1e8 * 1e18 / 1e18 / 100);
        vm.prank(maker);
        hook.approve(address(orders), type(uint256).max);

        ILastprintOrders.Order memory o = _buyOrder(10e18, 1);
        o.tokenIn = address(hook);
        bytes memory sig = _sign(makerPk, o);
        ILastprintOrders.Order memory o2 = _buyOrder(10e18, 1); // fresh struct (memory structs alias)
        o2.tokenIn = address(hook);
        o2.nonce = 8;
        hook.arm(orders, o2, _sign(makerPk, o2), address(router));
        _fill(o, sig);
        assertTrue(hook.reentryFailed(), "re-entry must fail");
        assertFalse(orders.isNonceUsed(maker, 8));
    }

    function test_revert_feeOnTransferTokenIn() public {
        MockFeeToken fee = new MockFeeToken();
        fee.mint(maker, 1000e18);
        vm.prank(maker);
        fee.approve(address(orders), type(uint256).max);
        ILastprintOrders.Order memory o = _buyOrder(100e18, 1);
        o.tokenIn = address(fee);
        bytes memory sig = _sign(makerPk, o);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.UnsupportedToken.selector, address(fee)));
        orders.fill(o, sig, address(router), _swapData(o));
    }

    function test_revert_feeOnTransferTokenOut() public {
        MockFeeToken fee = new MockFeeToken();
        fee.mint(address(router), 1e30);
        router.setRate(address(stock), address(fee), 1e18);
        ILastprintOrders.Order memory o = _sellOrder(1e8, 1e8); // minOut equals the gross router output
        o.tokenOut = address(fee);
        bytes memory sig = _sign(makerPk, o);
        vm.prank(keeper);
        // Router -> contract transfer already loses 1%, so the contract-side check trips first.
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.InsufficientOutput.selector, 0.99e8, 1e8));
        orders.fill(o, sig, address(router), _swapData(o));
    }

    function test_revert_feeOnTransferTokenOut_payoutLeg() public {
        MockFeeToken fee = new MockFeeToken();
        fee.mint(address(router), 1e30);
        router.setRate(address(stock), address(fee), 1e18);
        // Contract receives 0.99e8 (>= minOut), but maker would only receive 0.9801e8 (< minOut).
        ILastprintOrders.Order memory o = _sellOrder(1e8, 0.985e8);
        o.tokenOut = address(fee);
        bytes memory sig = _sign(makerPk, o);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.UnsupportedToken.selector, address(fee)));
        orders.fill(o, sig, address(router), _swapData(o));
    }

    function test_noReturnToken_works() public {
        MockNoReturnToken nrt = new MockNoReturnToken();
        nrt.mint(maker, 1000e6);
        nrt.mint(address(router), 1e18);
        router.setRate(address(nrt), address(stock), RATE_BUY);
        router.setRate(address(stock), address(nrt), RATE_SELL);
        vm.prank(maker);
        nrt.approve(address(orders), type(uint256).max);

        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.tokenIn = address(nrt);
        _fill(o, _sign(makerPk, o));
        assertEq(nrt.balanceOf(maker), 0);
        assertEq(nrt.allowance(address(orders), address(router)), 0);

        // Second fill exercises forceApprove from zero again (USDT-style approve rule).
        nrt.mint(maker, 500e6);
        ILastprintOrders.Order memory o2 = _buyOrder(500e6, 3e8);
        o2.tokenIn = address(nrt);
        o2.nonce = 9;
        _fill(o2, _sign(makerPk, o2));

        // And as tokenOut.
        ILastprintOrders.Order memory o3 = _sellOrder(1e8, 160e6);
        o3.tokenOut = address(nrt);
        _fill(o3, _sign(makerPk, o3));
        assertEq(nrt.balanceOf(maker), 166e6);
    }

    function test_revert_insufficientAllowance() public {
        vm.prank(maker);
        usdc.approve(address(orders), 999e6);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert();
        _fill(o, sig);
    }

    function test_revert_invalidOrders() public {
        ILastprintOrders.Order memory o = _buyOrder(0, 6e8);
        bytes memory sig = _sign(makerPk, o);
        vm.expectRevert(ILastprintOrders.InvalidOrder.selector);
        _fill(o, sig);

        o = _buyOrder(1000e6, 0);
        sig = _sign(makerPk, o);
        vm.expectRevert(ILastprintOrders.InvalidOrder.selector);
        _fill(o, sig);

        o = _buyOrder(1000e6, 6e8);
        o.tokenOut = o.tokenIn;
        sig = _sign(makerPk, o);
        vm.expectRevert(ILastprintOrders.InvalidOrder.selector);
        _fill(o, sig);

        o = _buyOrder(1000e6, 6e8);
        o.maker = address(0);
        vm.expectRevert(ILastprintOrders.InvalidOrder.selector);
        _fill(o, sig);
    }

    function test_donatedBalancesAreNotPaidOut() public {
        usdc.mint(address(orders), 55e6);
        stock.mint(address(orders), 7e8);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        uint256 out = _fill(o, _sign(makerPk, o));
        assertEq(out, 1000e6 * RATE_BUY / 1e18);
        assertEq(usdc.balanceOf(address(orders)), 55e6);
        assertEq(stock.balanceOf(address(orders)), 7e8);
    }

    // ---------------------------------------------------------------------------------------------- fuzz

    function testFuzz_buy(uint256 amountIn, uint256 rate, uint256 minOut) public {
        amountIn = bound(amountIn, 1, 1_000_000e6);
        rate = bound(rate, 1, 1e22);
        minOut = bound(minOut, 1, 1e15);
        router.setRate(address(usdc), address(stock), rate);
        uint256 out = amountIn * rate / 1e18;
        vm.assume(out <= stock.balanceOf(address(router)));

        ILastprintOrders.Order memory o = _buyOrder(amountIn, minOut);
        bytes memory sig = _sign(makerPk, o);
        uint256 usdcBefore = usdc.balanceOf(maker);
        uint256 stockBefore = stock.balanceOf(maker);

        if (out < minOut) {
            vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.InsufficientOutput.selector, out, minOut));
            _fill(o, sig);
            assertEq(usdc.balanceOf(maker), usdcBefore);
            assertEq(stock.balanceOf(maker), stockBefore);
        } else {
            assertEq(_fill(o, sig), out);
            assertEq(usdc.balanceOf(maker), usdcBefore - amountIn);
            assertEq(stock.balanceOf(maker), stockBefore + out);
            assertGe(stock.balanceOf(maker) - stockBefore, minOut);
        }
        _assertNoDust();
    }

    function testFuzz_sellWithPartialSpend(uint256 amountIn, uint256 spend, uint256 minOut) public {
        amountIn = bound(amountIn, 1, 10_000e8);
        spend = bound(spend, 0, amountIn);
        minOut = bound(minOut, 1, 1e13);
        uint256 out = spend * RATE_SELL / 1e18;

        ILastprintOrders.Order memory o = _sellOrder(amountIn, minOut);
        bytes memory sig = _sign(makerPk, o);
        bytes memory data =
            abi.encodeCall(MockRouter.swapPartial, (address(stock), address(usdc), spend, address(orders)));
        uint256 stockBefore = stock.balanceOf(maker);
        uint256 usdcBefore = usdc.balanceOf(maker);

        vm.prank(keeper);
        if (out < minOut) {
            vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.InsufficientOutput.selector, out, minOut));
            orders.fill(o, sig, address(router), data);
        } else {
            orders.fill(o, sig, address(router), data);
            assertEq(stock.balanceOf(maker), stockBefore - spend);
            assertEq(usdc.balanceOf(maker), usdcBefore + out);
        }
        _assertNoDust();
    }

    function testFuzz_nonceAndWindow(uint256 nonce, uint256 warpTo) public {
        warpTo = bound(warpTo, T0 - 2 hours, T0 + 11 hours);
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        o.nonce = nonce;
        bytes memory sig = _sign(makerPk, o);
        vm.warp(warpTo);
        if (warpTo < o.validAfter) {
            vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.NotYetValid.selector, o.validAfter));
        } else if (warpTo >= o.validUntil) {
            vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.OrderExpired.selector, o.validUntil));
        }
        _fill(o, sig);
    }

    // ---------------------------------------------------------------------------------------------- EIP-712

    function test_hashOrder_matchesSpec() public view {
        ILastprintOrders.Order memory o = _buyOrder(1000e6, 6e8);
        bytes32 typeHash = keccak256(
            "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address stockToken,uint256 stockMultiplier,uint256 validAfter,uint256 validUntil,uint256 nonce)"
        );
        assertEq(orders.ORDER_TYPEHASH(), typeHash);
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(typeHash, o.maker, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut),
                abi.encode(o.stockToken, o.stockMultiplier, o.validAfter, o.validUntil, o.nonce)
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Lastprint"),
                keccak256("1"),
                block.chainid,
                address(orders)
            )
        );
        assertEq(orders.domainSeparator(), domain);
        assertEq(orders.hashOrder(o), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ---------------------------------------------------------------------------------------------- constructor

    function test_constructor_config() public view {
        assertEq(address(orders.actionFeed()), address(feed));
        assertEq(orders.guardWindow(), GUARD);
        address[] memory rs = orders.routers();
        assertEq(rs.length, 2);
        assertEq(rs[0], address(router));
        assertTrue(orders.isRouter(address(router)));
        assertFalse(orders.isRouter(address(usdc)));
    }

    function test_revert_constructor_badConfig() public {
        address[] memory rs = new address[](1);
        rs[0] = address(router);
        address[] memory none = new address[](0);

        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(0xdead)), GUARD, rs);
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), 0, rs);
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), 31 days, rs);
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), GUARD, none);

        address[] memory dup = new address[](2);
        dup[0] = address(router);
        dup[1] = address(router);
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), GUARD, dup);

        address[] memory eoa = new address[](1);
        eoa[0] = makeAddr("eoaRouter");
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), GUARD, eoa);

        address[] memory feedAsRouter = new address[](1);
        feedAsRouter[0] = address(feed);
        vm.expectRevert(ILastprintOrders.InvalidConfig.selector);
        new LastprintOrders(IActionFeed(address(feed)), GUARD, feedAsRouter);

        address[] memory tokenAsRouter = new address[](1);
        tokenAsRouter[0] = address(usdc);
        vm.expectRevert(abi.encodeWithSelector(ILastprintOrders.RouterLooksLikeToken.selector, address(usdc)));
        new LastprintOrders(IActionFeed(address(feed)), GUARD, tokenAsRouter);
    }
}
