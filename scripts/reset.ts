// Fresh scenario in one command: recycle DEV's rug proceeds back to DEPLOYER, then redeploy everything.
import { parseEther, type Address } from "viem";
import { address, assertTestnet, bnb, confirm, isMain, publicClient, readDeployments, run, wallet } from "./lib/env.ts";
import { artifact, deadline, pairAbi, routerAbi } from "./lib/contracts.ts";
import { setupScenario } from "./setup-scenario.ts";

const KEEP_FOR_GAS = parseEther("0.005");

export async function reset() {
  await assertTestnet();
  const t0 = Date.now();
  const prev = readDeployments();
  // If the previous pool was never rugged, pull its liquidity so the BNB isn't stranded.
  if (prev.pair && prev.token) {
    const lp = await publicClient.readContract({ address: prev.pair, abi: pairAbi, functionName: "balanceOf", args: [address("DEV")] });
    if (lp > 0n) {
      await confirm("recover old pool liquidity", await wallet("DEV").writeContract({
        address: prev.router, abi: routerAbi, functionName: "removeLiquidityETH",
        args: [prev.token, lp, 0n, 0n, address("DEV"), deadline()], gas: 500_000n,
      }));
    }
  }
  const devBal = await publicClient.getBalance({ address: address("DEV") });
  if (devBal > KEEP_FOR_GAS + parseEther("0.002")) {
    const amt = devBal - KEEP_FOR_GAS;
    await confirm(`recycle DEV → DEPLOYER ${bnb(amt)} tBNB`, await wallet("DEV").sendTransaction({ to: address("DEPLOYER"), value: amt }));
  }
  // Return any BNB/RUGME left in the previous vault to its owner before it is replaced.
  const old = readDeployments().vault as Address | undefined;
  if (old && (await publicClient.getBalance({ address: old })) > 0n) {
    await confirm("GUARDED withdraws old vault", await wallet("GUARDED_USER").writeContract({
      address: old, abi: artifact("GuardedVault").abi, functionName: "withdraw",
    }));
  }
  const gBal = await publicClient.getBalance({ address: address("GUARDED_USER") });
  if (gBal > parseEther("0.007")) {
    const amt = gBal - parseEther("0.004");
    await confirm(`recycle GUARDED → DEPLOYER ${bnb(amt)} tBNB`, await wallet("GUARDED_USER").sendTransaction({ to: address("DEPLOYER"), value: amt }));
  }
  const need = parseEther(process.env.LIQ_BNB || "0.05") + parseEther("0.002");
  const have = await publicClient.getBalance({ address: address("DEPLOYER") });
  if (have < need) throw new Error(`DEPLOYER has ${bnb(have)} tBNB, needs ${bnb(need)} (liquidity + gas). Get more from the faucet or lower LIQ_BNB.`);
  const d = await setupScenario();
  console.log(`\nReset done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return d;
}

if (isMain(import.meta.url)) run(reset);
