// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {LastprintOrders} from "../src/LastprintOrders.sol";
import {IActionFeed} from "../src/interfaces/IActionFeed.sol";

interface IRouterLike {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

/// @notice Deploys LastprintOrders.
///   ACTION_FEED   ActionFeed address (Base mainnet: 0xC455472cd39029F8309F0D762Ee587D65A596Fe2)
///   ROUTERS       comma-separated router allowlist (immutable!). Only real swap routers.
///   GUARD_WINDOW  seconds, e.g. 86400
///
/// Dry run (no broadcast):
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL
/// The router allowlist can never change after deployment. Every entry must be a swap router that only spends
/// tokens from msg.sender; allowlisting a token or any contract with an arbitrary-call / transferFrom-on-behalf
/// function would expose every maker's allowance. This script refuses entries that do not expose `factory()` and
/// `WETH9()` (Uniswap-v3-style periphery routers, which includes Aerodrome Slipstream).
contract Deploy is Script {
    function run() external returns (LastprintOrders orders) {
        address feed = vm.envAddress("ACTION_FEED");
        address[] memory routers = vm.envAddress("ROUTERS", ",");
        uint256 guardWindow = vm.envUint("GUARD_WINDOW");

        for (uint256 i = 0; i < routers.length; ++i) {
            IRouterLike r = IRouterLike(routers[i]);
            address factory = r.factory();
            address weth = r.WETH9();
            require(factory != address(0) && weth != address(0), "Deploy: not a v3-style router");
            console2.log("router", routers[i], "factory", factory);
        }

        vm.startBroadcast();
        orders = new LastprintOrders(IActionFeed(feed), guardWindow, routers);
        vm.stopBroadcast();

        console2.log("LastprintOrders", address(orders));
        console2.log("deploy block", block.number);
        console2.logBytes32(orders.domainSeparator());
    }
}
