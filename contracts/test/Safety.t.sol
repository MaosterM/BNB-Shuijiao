// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RugMe} from "../RugMe.sol";
import {SafeExit} from "../SafeExit.sol";
import {GuardedVault} from "../GuardedVault.sol";

interface IRouter {
    function addLiquidityETH(address, uint256, uint256, uint256, address, uint256)
        external payable returns (uint256, uint256, uint256);
}

/// Fork tests against the real PancakeSwap V2 router on BSC testnet (FORK_URL, default public RPC).
contract SafetyTest is Test {
    address constant ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address user = makeAddr("user");
    address agent = makeAddr("agent");
    address attacker = makeAddr("attacker");
    RugMe token;
    SafeExit safeExit;
    GuardedVault vault;

    function setUp() public {
        vm.createSelectFork(vm.envOr("FORK_URL", string("https://bsc-testnet-rpc.publicnode.com")));
        token = new RugMe();
        token.approve(ROUTER, 150_000 ether);
        IRouter(ROUTER).addLiquidityETH{value: 1 ether}(address(token), 150_000 ether, 0, 0, address(this), block.timestamp);
        safeExit = new SafeExit(ROUTER);
        vault = new GuardedVault(user, agent, address(token), address(safeExit));
        token.transfer(user, 20_000 ether);
        token.transfer(address(vault), 20_000 ether);
    }

    function test_exitProceedsReturnToCaller_fullBalanceWhenZero() public {
        uint256 before = user.balance;
        vm.startPrank(user);
        token.approve(address(safeExit), type(uint256).max);
        uint256 out = safeExit.exit(address(token), 0, 0);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(user.balance - before, out, "BNB went to caller");
        assertEq(token.balanceOf(user), 0, "amountIn=0 sold full balance");
        assertEq(address(safeExit).balance, 0, "SafeExit keeps nothing");
    }

    function test_guardianEject_bnbStaysInVault() public {
        uint256 agentBefore = agent.balance;
        vm.prank(agent);
        uint256 out = vault.eject(0);
        assertGt(out, 0);
        assertEq(address(vault).balance, out, "BNB in vault");
        assertEq(agent.balance, agentBefore, "agent got nothing");
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.allowance(address(vault), address(safeExit)), 0, "no leftover allowance");
    }

    function test_nonGuardianCannotEject() public {
        vm.prank(attacker);
        vm.expectRevert("not guardian");
        vault.eject(0);
        vm.prank(user);
        vm.expectRevert("not guardian");
        vault.eject(0);
    }

    function test_guardianCannotWithdrawOrReassign() public {
        vm.startPrank(agent);
        vm.expectRevert("not owner");
        vault.withdraw();
        vm.expectRevert("not owner");
        vault.setGuardian(agent);
        vm.expectRevert(); // vault never grants the agent an allowance
        token.transferFrom(address(vault), agent, 1);
        vm.stopPrank();
    }

    function test_ownerWithdrawsAfterEject() public {
        vm.prank(agent);
        uint256 out = vault.eject(0);
        uint256 before = user.balance;
        vm.prank(user);
        vault.withdraw();
        assertEq(user.balance - before, out);
    }

    function test_minOutProtects() public {
        vm.prank(agent);
        vm.expectRevert();
        vault.eject(100 ether); // impossible minimum -> revert, tokens stay
        assertEq(token.balanceOf(address(vault)), 20_000 ether);
    }
}
