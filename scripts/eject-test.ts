// AGENT ejects GUARDED's vault; BNB must land in the vault. Negative tests: AGENT cannot withdraw or re-point.
import type { Address } from "viem";
import { SLIPPAGE_BPS, address, assertTestnet, bnb, confirm, publicClient, readDeployments, run, wallet } from "./lib/env.ts";
import { artifact, erc20Abi, quoteSell, reserves } from "./lib/contracts.ts";

run(async () => {
  await assertTestnet();
  const d = readDeployments();
  const vault = d.vault as Address, token = d.token as Address, pair = d.pair as Address;
  const vaultAbi = artifact("GuardedVault").abi;
  const agentAddr = address("AGENT");

  const bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const quote = quoteSell(bal, await reserves(pair, token));
  const minOut = (quote * (10000n - SLIPPAGE_BPS)) / 10000n;
  const agentBefore = await publicClient.getBalance({ address: agentAddr });
  console.log(`Vault holds ${Number(bal / 10n ** 18n).toLocaleString()} RUGME ≈ ${bnb(quote, 6)} tBNB; minOut ${bnb(minOut, 6)}`);

  await confirm("AGENT vault.eject", await wallet("AGENT").writeContract({ address: vault, abi: vaultAbi, functionName: "eject", args: [minOut] }));
  const vaultBnb = await publicClient.getBalance({ address: vault });
  const left = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const agentAfter = await publicClient.getBalance({ address: agentAddr });
  const ok1 = vaultBnb >= minOut && left === 0n;
  console.log(`${ok1 ? "PASS" : "FAIL"}  vault now holds ${bnb(vaultBnb, 6)} tBNB, ${left} RUGME`);
  console.log(`${agentAfter < agentBefore ? "PASS" : "FAIL"}  AGENT balance only went down (gas): ${bnb(agentBefore, 6)} → ${bnb(agentAfter, 6)}`);

  for (const [fn, args] of [["withdraw", []], ["setGuardian", [agentAddr]]] as const) {
    try {
      await publicClient.simulateContract({ account: agentAddr, address: vault, abi: vaultAbi, functionName: fn, args: args as any });
      console.log(`FAIL  AGENT was able to call ${fn}()`);
      process.exitCode = 1;
    } catch (e: any) {
      console.log(`PASS  AGENT ${fn}() reverts${/not owner/.test(e.message) ? ' with "not owner"' : ""}`);
    }
  }
  if (!ok1) process.exitCode = 1;
});
