// Show tBNB balances vs targets. With --distribute, DEPLOYER tops up every other wallet to its target.
import { parseEther } from "viem";
import { ROLES, address, assertTestnet, bnb, confirm, publicClient, wallet, type Role } from "./lib/env.ts";

// DEPLOYER funds pool liquidity on every reset; the others only pay gas.
export const TARGETS: Record<Role, bigint> = {
// Gas is ~0.1 gwei on testnet, so a tx costs ~0.00001–0.0003 tBNB.
  DEPLOYER: parseEther("0.08"),
  DEV: parseEther("0.005"),
  GUARDED_USER: parseEther("0.004"), // Altana relay fees are paid from the user's wallet
  UNGUARDED_USER: parseEther("0.001"),
  AGENT: parseEther("0.005"),
};

async function main() {
  await assertTestnet();
  const distribute = process.argv.includes("--distribute");
  const gasPrice = await publicClient.getGasPrice();
  console.log(`BSC testnet (chain 97) · gas price ${Number(gasPrice) / 1e9} gwei\n`);
  console.log(`${"ROLE".padEnd(15)} ${"ADDRESS".padEnd(42)} ${"BALANCE".padStart(10)} ${"TARGET".padStart(8)}  NEEDS`);

  const balances = {} as Record<Role, bigint>;
  for (const role of ROLES) {
    const bal = await publicClient.getBalance({ address: address(role) });
    balances[role] = bal;
    const need = TARGETS[role] > bal ? TARGETS[role] - bal : 0n;
    console.log(
      `${role.padEnd(15)} ${address(role)} ${bnb(bal).padStart(10)} ${bnb(TARGETS[role], 3).padStart(8)}  ${need ? bnb(need) + " tBNB" : "ok"}`,
    );
  }

  const others = ROLES.filter((r) => r !== "DEPLOYER");
  const shortfall = others.reduce((s, r) => s + (TARGETS[r] > balances[r] ? TARGETS[r] - balances[r] : 0n), 0n);
  console.log(`\nOthers need ${bnb(shortfall)} tBNB total from DEPLOYER.`);
  if (!distribute) {
    console.log(`Send faucet tBNB to DEPLOYER ${address("DEPLOYER")}, then run: npm run fund -- --distribute`);
    return;
  }

  const w = wallet("DEPLOYER");
  if (balances.DEPLOYER < shortfall + parseEther("0.002")) {
    console.error(`DEPLOYER has ${bnb(balances.DEPLOYER)} tBNB, not enough to cover ${bnb(shortfall)}. Use the faucet first.`);
    process.exit(1);
  }
  for (const role of others) {
    const need = TARGETS[role] - balances[role];
    if (need <= 0n) continue;
    const hash = await w.sendTransaction({ to: address(role), value: need });
    await confirm(`DEPLOYER → ${role} ${bnb(need)} tBNB`, hash);
  }
  console.log("Distribution done.");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message);
  process.exit(1);
});
