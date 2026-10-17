// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPancakeRouter {
    function WETH() external pure returns (address);
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external;
}

/// @notice Sell a token for BNB. Proceeds ALWAYS go to msg.sender; there is no recipient parameter.
contract SafeExit {
    IPancakeRouter public immutable router;

    event Ejected(address indexed user, address indexed token, uint256 amountIn, uint256 bnbOut);

    constructor(address _router) {
        router = IPancakeRouter(_router);
    }

    function exit(address token, uint256 amountIn, uint256 minOutBNB) external returns (uint256 bnbOut) {
        if (amountIn == 0) amountIn = IERC20(token).balanceOf(msg.sender);
        require(amountIn > 0, "nothing to sell");
        require(IERC20(token).transferFrom(msg.sender, address(this), amountIn), "transferFrom");
        IERC20(token).approve(address(router), amountIn);

        address[] memory path = new address[](2);
        (path[0], path[1]) = (token, router.WETH());
        uint256 before = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, minOutBNB, path, address(this), block.timestamp + 120);
        bnbOut = address(this).balance - before;

        (bool ok,) = msg.sender.call{value: bnbOut}("");
        require(ok, "BNB send");
        emit Ejected(msg.sender, token, amountIn, bnbOut);
    }

    receive() external payable {}
}
