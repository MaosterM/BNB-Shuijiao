// Send tBNB from DEPLOYER to any address: npx tsx scripts/send.ts <to> <amountBnb>
import { isAddress, parseEther } from "viem";
import { assertTestnet, confirm, run, wallet } from "./lib/env.ts";

run(async () => {
  const [to, amt] = process.argv.slice(2);
  if (!to || !isAddress(to) || !amt) throw new Error("usage: npx tsx scripts/send.ts <to> <amountBnb>");
  await assertTestnet();
  await confirm(`DEPLOYER → ${to} ${amt} tBNB`, await wallet("DEPLOYER").sendTransaction({ to, value: parseEther(amt) }));
});
