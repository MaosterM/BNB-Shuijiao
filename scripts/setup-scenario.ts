// Deploy RUGME, create the RUGME/WBNB PancakeSwap pool, distribute supply. Writes deployments.json.
import { maxUint256, parseEther, type Address } from "viem";
import {
  address, addrUrl, assertTestnet, bnb, confirm, isMain, publicClient, readDeployments, run, wallet, writeDeployments,
} from "./lib/env.ts";
import { DEAD, deadline, deploy, erc20Abi, factoryAbi, forgeBuild, pairAbi, price, routerAbi } from "./lib/contracts.ts";
import { deploySafety } from "./deploy.ts";

const SUPPLY = 1_000_000n * 10n ** 18n;
const pct = (p: bigint) => (SUPPLY * p) / 100n;
// DEV 30%, GUARDED 2%, UNGUARDED 2%, pool 15%, rest (51%) burned to dEaD.
// A small pool relative to DEV's bag is what makes the dump crash the price >80%.
export const SPLIT = { dev: pct(30n), guarded: pct(2n), unguarded: pct(2n), pool: pct(15n) };
const LIQ_BNB = parseEther(process.env.LIQ_BNB || "0.05");

export async function setupScenario() {
  await assertTestnet();
  forgeBuild();
  const d = readDeployments();
  const router = d.router as Address, factory = d.factory as Address, wbnb = d.wbnb as Address;
  const deployer = wallet("DEPLOYER"), dev = wallet("DEV");

  console.log("Deploying RUGME...");
  const token = await deploy("DEPLOYER", "RugMe");

  console.log(`Adding liquidity: ${Number(SPLIT.pool / 10n ** 18n).toLocaleString()} RUGME + ${bnb(LIQ_BNB)} tBNB (LP → DEV)`);
  await confirm("approve router", await deployer.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [router, SPLIT.pool] }));
  await confirm(
    "addLiquidityETH",
    await deployer.writeContract({
      address: router, abi: routerAbi, functionName: "addLiquidityETH",
      args: [token, SPLIT.pool, 0n, 0n, address("DEV"), deadline()], value: LIQ_BNB,
    }),
  );
  const pair = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [token, wbnb] });

  console.log("Distributing supply...");
  const send = async (label: string, to: Address, amt: bigint) =>
    confirm(label, await deployer.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amt] }));
  await send("→ DEV 30%", address("DEV"), SPLIT.dev);
  await send("→ GUARDED 2%", address("GUARDED_USER"), SPLIT.guarded);
  await send("→ UNGUARDED 2%", address("UNGUARDED_USER"), SPLIT.unguarded);
  const rest = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address("DEPLOYER")] });
  await send("→ dEaD (burn rest)", DEAD, rest);
  await confirm("transferOwnership → DEV", await deployer.writeContract({ address: token, abi: erc20Abi, functionName: "transferOwnership", args: [address("DEV")] }));

  // DEV pre-approves so the rug itself is only sells + removeLiquidity.
  await confirm("DEV approve RUGME → router", await dev.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] }));
  await confirm("DEV approve LP → router", await dev.writeContract({ address: pair, abi: pairAbi, functionName: "approve", args: [router, maxUint256] }));

  const block = await publicClient.getBlockNumber();
  const out = {
    ...d,
    token, pair,
    deployBlock: Number(block),
    team: [address("DEV")],
    safeList: [DEAD],
    wallets: {
      deployer: address("DEPLOYER"), dev: address("DEV"),
      guarded: address("GUARDED_USER"), unguarded: address("UNGUARDED_USER"), agent: address("AGENT"),
    },
  };
  writeDeployments(out);
  console.log("Deploying safety contracts...");
  Object.assign(out, await deploySafety());

  const p = await price(pair, token);
  console.log(`\nRUGME  ${addrUrl(token)}`);
  console.log(`Pool   ${addrUrl(pair)}`);
  console.log(`Price  ${(p * 1000).toFixed(8)} tBNB per 1,000 RUGME`);
  return out;
}

if (isMain(import.meta.url)) run(setupScenario);
