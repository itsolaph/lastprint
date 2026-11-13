// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IActionFeed} from "../../src/interfaces/IActionFeed.sol";
import {MockB20} from "./MockTokens.sol";

/// @notice Minimal ActionFeed stand-in that derives status from a MockB20, with the same guard semantics:
///         `assertStable` reverts if a multiplier change goes live within `window` seconds, or transfers are paused.
contract MockActionFeed {
    function status(address token) public view returns (IActionFeed.Status memory s) {
        MockB20 t = MockB20(token);
        uint256 live = t.uiMultiplier();
        uint256 at = t.effectiveAt();
        bool pending = at != 0 && at > block.timestamp;
        s.decimals = t.decimals();
        s.rawSupply = t.totalSupply();
        s.uiMultiplier = live;
        s.newUIMultiplier = pending ? t.newUIMultiplier() : live;
        s.effectiveAt = pending ? at : 0;
        s.pendingLive = pending;
        s.transferPaused = t.transfersPaused();
    }

    function assertStable(address token, uint256 window) external view {
        IActionFeed.Status memory s = status(token);
        if (s.uiMultiplier == 0) revert IActionFeed.ZeroMultiplier(token);
        if (s.transferPaused) revert IActionFeed.TransfersPaused(token);
        if (s.pendingLive && s.effectiveAt <= block.timestamp + window) {
            revert IActionFeed.PendingActionWithin(token, s.effectiveAt, window);
        }
    }
}
