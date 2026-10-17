// The rug: DEV sells 5% of its bag, waits, dumps the rest, then pulls all liquidity.
import type { Address } from "viem";
import { address, assertTestnet, confirm, isMain, publicClient, readDeployments, run, wallet } from "./lib/env.ts";
import { deadline, erc20Abi, pairAbi, price, routerAbi } from "./lib/contracts.ts";

const DELAY_MS = Number(process.env.RUG_DELAY_MS || 8000);

export async function rug() {
  await assertTestnet();
  const d = readDeployments();
  const token = d.token as Address, pair = d.pair as Address, router = d.router as Address, wbnb = d.wbnb as Address;
  const dev = wallet("DEV"), devAddr = address("DEV");
  const p0 = await price(pair, token);
  const show = async (step: string) => {
    const p = await price(pair, token);
    console.log(`  price after ${step}: ${(p * 1000).toFixed(8)} tBNB/1k RUGME  (${((p / p0 - 1) * 100).toFixed(1)}%)`);
    return p;
  };
  const sell = async (label: string, amount: bigint) =>
    confirm(label, await dev.writeContract({
      address: router, abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [amount, 0n, [token, wbnb], devAddr, deadline()],
    }));

  console.log(`RUG START  price ${(p0 * 1000).toFixed(8)} tBNB/1k RUGME`);
  const bag = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [devAddr] });

  await sell("DEV sells 5% of holdings", bag / 20n);
  await show("first chunk");

  console.log(`  ...waiting ${DELAY_MS / 1000}s`);
  await new Promise((r) => setTimeout(r, DELAY_MS));

  const rest = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [devAddr] });
  await sell("DEV dumps the rest", rest);
  await show("dump");

  const lp = await publicClient.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [devAddr] });
  await confirm("DEV removes all liquidity", await dev.writeContract({
    address: router, abi: routerAbi, functionName: "removeLiquidityETH",
    args: [token, lp, 0n, 0n, devAddr, deadline()],
    gas: 500_000n, // estimate leaves too little for the WBNB unwrap
  }));
  const pEnd = await show("liquidity pull");
  console.log(`RUG DONE  price crash: ${((1 - pEnd / p0) * 100).toFixed(1)}%`);
  return { p0, pEnd };
}

if (isMain(import.meta.url)) run(rug);
