// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISafeExit {
    function exit(address token, uint256 amountIn, uint256 minOutBNB) external returns (uint256);
}

/// @notice Holds the user's token. The guardian (agent) can ONLY sell it via SafeExit; proceeds stay here.
/// Only the owner can withdraw or change the guardian. There is no other way to move funds.
contract GuardedVault {
    address public immutable owner;
    address public guardian;
    IERC20 public immutable token;
    ISafeExit public immutable safeExit;

    event GuardianSet(address guardian);
    event VaultEjected(uint256 amountIn, uint256 bnbOut);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _owner, address _guardian, address _token, address _safeExit) {
        (owner, guardian, token, safeExit) = (_owner, _guardian, IERC20(_token), ISafeExit(_safeExit));
        emit GuardianSet(_guardian);
    }

    /// @dev The guardian's only power. Sells the full token balance; BNB comes back to this vault.
    function eject(uint256 minOutBNB) external returns (uint256 bnbOut) {
        require(msg.sender == guardian, "not guardian");
        uint256 bal = token.balanceOf(address(this));
        token.approve(address(safeExit), bal);
        bnbOut = safeExit.exit(address(token), bal, minOutBNB);
        emit VaultEjected(bal, bnbOut);
    }

    function withdraw() external onlyOwner {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) require(token.transfer(owner, bal), "token transfer");
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "BNB send");
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    receive() external payable {}
}
