// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 with configurable decimals and open minting (tests only).
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice B20-like token: ERC-20 raw balances plus an ERC-8056 style UI multiplier with a scheduled change and a
///         transfer pause switch. `uiMultiplier()` returns the multiplier in force right now.
contract MockB20 is MockERC20 {
    uint256 private _currentMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;
    bool public transfersPaused;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockERC20(name_, symbol_, decimals_) {}

    function uiMultiplier() public view returns (uint256) {
        if (effectiveAt != 0 && block.timestamp >= effectiveAt) return newUIMultiplier;
        return _currentMultiplier;
    }

    function scheduleMultiplier(uint256 newMultiplier, uint256 at) external {
        _currentMultiplier = uiMultiplier();
        newUIMultiplier = newMultiplier;
        effectiveAt = at;
    }

    function setMultiplierNow(uint256 m) external {
        _currentMultiplier = m;
        newUIMultiplier = m;
        effectiveAt = 0;
    }

    function setPaused(bool p) external {
        transfersPaused = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!transfersPaused, "B20: paused");
        super._update(from, to, value);
    }
}

/// @notice USDT-style token: no bool return values and approve requires zero-first.
contract MockNoReturnToken {
    string public name = "NoReturn";
    string public symbol = "NRT";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "approve: non-zero to non-zero");
        allowance[msg.sender][spender] = amount;
    }
}

/// @notice Takes a 1% fee on every transfer (burned).
contract MockFeeToken is MockERC20 {
    constructor() MockERC20("Fee", "FEE", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
