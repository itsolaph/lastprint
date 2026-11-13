// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ILastprintOrders} from "../../src/interfaces/ILastprintOrders.sol";

/// @notice ERC-1271 smart wallet controlled by one EOA owner.
contract MockSmartWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        if (err == ECDSA.RecoverError.NoError && rec == owner) return 0x1626ba7e;
        return 0xffffffff;
    }

    function approve(IERC20 token, address spender, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        token.approve(spender, amount);
    }
}

/// @notice ERC-1271 wallet that accepts everything but returns a wrong magic value.
contract BadMagicWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x12345678;
    }
}

/// @notice ERC-20 whose transferFrom re-enters `fill` (simulates a hook token).
contract ReentrantToken is ERC20 {
    ILastprintOrders public target;
    ILastprintOrders.Order internal _order;
    bytes internal _sig;
    address internal _router;
    bool internal _armed;
    bool public reentryFailed;

    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(ILastprintOrders t, ILastprintOrders.Order calldata o, bytes calldata s, address r) external {
        target = t;
        _order = o;
        _sig = s;
        _router = r;
        _armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (_armed) {
            _armed = false;
            try target.fill(_order, _sig, _router, "") {
            // should never succeed
            }
            catch {
                reentryFailed = true;
            }
        }
        return super.transferFrom(from, to, value);
    }
}
