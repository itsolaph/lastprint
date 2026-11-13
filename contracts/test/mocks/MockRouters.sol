// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILastprintOrders} from "../../src/interfaces/ILastprintOrders.sol";

/// @notice Swaps at a configurable WAD rate: out = in * rate / 1e18. Pre-fund it with output tokens.
contract MockRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 wadRate) external {
        rate[tokenIn][tokenOut] = wadRate;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) public returns (uint256 out) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        out = amountIn * rate[tokenIn][tokenOut] / 1e18;
        IERC20(tokenOut).safeTransfer(recipient, out);
    }

    /// @dev Exact-output style: only spends `spend` of the approved amount.
    function swapPartial(address tokenIn, address tokenOut, uint256 spend, address recipient)
        external
        returns (uint256)
    {
        return swap(tokenIn, tokenOut, spend, recipient);
    }

    /// @dev Tries to take more than it was approved for.
    function overpull(address tokenIn, uint256 amount) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Tries to pull directly from an arbitrary owner (e.g. the maker) using the caller's identity.
    function pullFrom(address token, address owner, uint256 amount) external {
        IERC20(token).safeTransferFrom(owner, address(this), amount);
    }

    function fail() external pure {
        revert("router: boom");
    }
}

/// @notice Same external shape as the Aerodrome Slipstream SwapRouter `exactInputSingle` (verified ABI), swapping at
///         a fixed rate. Lets the tests run the exact calldata format the keeper builds.
contract MockSlipstreamRouter {
    using SafeERC20 for IERC20;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public rateWad;

    function setRate(uint256 r) external {
        rateWad = r;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(block.timestamp <= p.deadline, "Transaction too old");
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * rateWad / 1e18;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }
}

/// @notice Router that tries to re-enter `fill` during the swap.
contract ReentrantRouter {
    ILastprintOrders public target;
    ILastprintOrders.Order internal _order;
    bytes internal _sig;
    bytes internal _calldata;

    function arm(ILastprintOrders target_, ILastprintOrders.Order calldata order, bytes calldata sig) external {
        target = target_;
        _order = order;
        _sig = sig;
    }

    function attack() external {
        target.fill(_order, _sig, address(this), abi.encodeCall(this.noop, ()));
    }

    function noop() external {}
}
