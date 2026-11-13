// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LastprintOrders} from "../src/LastprintOrders.sol";
import {ILastprintOrders} from "../src/interfaces/ILastprintOrders.sol";
import {IActionFeed} from "../src/interfaces/IActionFeed.sol";
import {MockActionFeed} from "./mocks/MockActionFeed.sol";
import {MockRouter} from "./mocks/MockRouters.sol";

/// @notice Shared vector with keeper/test/eip712.test.ts (viem hashTypedData). Both sides must agree.
contract EIP712VectorTest is Test {
    address constant AT = 0x1a57000000000000000000000000000000000001;
    bytes32 constant EXPECTED = 0xdaa521a11b46354a8c15225d0b71553e96327cc295bce11c3f67ff1d29be53bf;

    function test_digestMatchesViem() public {
        vm.chainId(8453);
        address[] memory rs = new address[](1);
        rs[0] = address(new MockRouter());
        deployCodeTo(
            "LastprintOrders.sol:LastprintOrders",
            abi.encode(IActionFeed(address(new MockActionFeed())), 1 days, rs),
            AT
        );
        ILastprintOrders.Order memory o = ILastprintOrders.Order({
            maker: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            tokenIn: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            tokenOut: 0xb20000000000000000000078ee7ce2fE4908108C,
            amountIn: 1_000_000_000,
            minAmountOut: 600_760_335,
            stockToken: 0xb20000000000000000000078ee7ce2fE4908108C,
            stockMultiplier: 1_000_537_939_576_369_481,
            validAfter: 1_794_517_200,
            validUntil: 1_794_580_200,
            nonce: 1_794_539_183_761_000_042
        });
        assertEq(LastprintOrders(AT).hashOrder(o), EXPECTED);
    }
}
