// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Deliberately risky demo token. The owner-only mint is a rug signal Ejector Seat detects.
contract RugMe is ERC20, Ownable {
    constructor() ERC20("Rug Me", "RUGME") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
