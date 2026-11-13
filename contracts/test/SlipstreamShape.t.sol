// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LastprintOrders} from "../src/LastprintOrders.sol";
import {ILastprintOrders} from "../src/interfaces/ILastprintOrders.sol";
import {IActionFeed} from "../src/interfaces/IActionFeed.sol";
import {MockERC20, MockB20} from "./mocks/MockTokens.sol";
import {MockActionFeed} from "./mocks/MockActionFeed.sol";
import {MockSlipstreamRouter} from "./mocks/MockRouters.sol";

/// @notice Fill through a router with the real Slipstream `exactInputSingle` shape, as the keeper encodes it.
contract SlipstreamShapeTest is Test {
    LastprintOrders orders;
    MockSlipstreamRouter router;
    MockERC20 usdc;
    MockB20 stock;
    address maker;
    uint256 makerPk;

    function setUp() public {
        vm.warp(1_794_539_183);
        (maker, makerPk) = makeAddrAndKey("maker");
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock = new MockB20("NVIDIA", "NVDAc", 8);
        stock.setMultiplierNow(1_000_537_939_576_369_481);
        router = new MockSlipstreamRouter();
        router.setRate(uint256(1e18) * 1e8 / (166 * 1e6));
        stock.mint(address(router), 1e15);
        address[] memory rs = new address[](1);
        rs[0] = address(router);
        orders = new LastprintOrders(IActionFeed(address(new MockActionFeed())), 1 days, rs);
        usdc.mint(maker, 1000e6);
        vm.prank(maker);
        usdc.approve(address(orders), 1000e6); // exact approval, as the web app does
    }

    function test_selectorMatchesSlipstream() public pure {
        // cast sig "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"
        assertEq(MockSlipstreamRouter.exactInputSingle.selector, bytes4(0xa026383e));
    }

    function test_fillWithKeeperCalldata() public {
        ILastprintOrders.Order memory o = ILastprintOrders.Order({
            maker: maker,
            tokenIn: address(usdc),
            tokenOut: address(stock),
            amountIn: 1000e6,
            minAmountOut: 600_000_000,
            stockToken: address(stock),
            stockMultiplier: 1_000_537_939_576_369_481,
            validAfter: 1_794_517_200,
            validUntil: 1_794_580_200,
            nonce: 42
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, orders.hashOrder(o));
        bytes memory data = abi.encodeCall(
            MockSlipstreamRouter.exactInputSingle,
            (MockSlipstreamRouter.ExactInputSingleParams({
                    tokenIn: o.tokenIn,
                    tokenOut: o.tokenOut,
                    tickSpacing: 10,
                    recipient: address(orders),
                    deadline: block.timestamp + 120,
                    amountIn: o.amountIn,
                    amountOutMinimum: o.minAmountOut,
                    sqrtPriceLimitX96: 0
                }))
        );
        uint256 out = orders.fill(o, abi.encodePacked(r, s, v), address(router), data);
        assertEq(stock.balanceOf(maker), out);
        assertGe(out, o.minAmountOut);
        assertEq(usdc.allowance(maker, address(orders)), 0);
        assertEq(usdc.allowance(address(orders), address(router)), 0);
    }
}
