// Deploy SafeExit + GUARDED's GuardedVault for the current token, and move GUARDED's RUGME into the vault.
import type { Address } from "viem";
import {
  address, addrUrl, assertTestnet, confirm, isMain, publicClient, readDeployments, run, wallet, writeDeployments,
} from "./lib/env.ts";
import { deploy, erc20Abi, forgeBuild } from "./lib/contracts.ts";

export async function deploySafety() {
  await assertTestnet();
  const d = readDeployments();
  if (!d.token) throw new Error("no token in deployments.json — run `npm run setup` first");
  const token = d.token as Address;

  const safeExit = await deploy("DEPLOYER", "SafeExit", [d.router]);
  const vault = await deploy("DEPLOYER", "GuardedVault", [address("GUARDED_USER"), address("AGENT"), token, safeExit]);

  const mode = (process.env.GUARD_MODE || "vault").toLowerCase();
  writeDeployments({ ...d, safeExit, vault, guardMode: mode, altana: undefined });
  console.log(`SafeExit ${addrUrl(safeExit)}`);
  if (mode === "altana") {
    const { altanaSetup } = await import("./altana-setup.ts");
    const altana = await altanaSetup();
    return { safeExit, vault, guardMode: mode, altana };
  }
  const bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address("GUARDED_USER")] });
  if (bal > 0n) {
    await confirm("GUARDED moves RUGME → vault", await wallet("GUARDED_USER").writeContract({
      address: token, abi: erc20Abi, functionName: "transfer", args: [vault, bal],
    }));
  }
  console.log(`Vault    ${addrUrl(vault)}  (owner GUARDED, guardian AGENT)`);
  return { safeExit, vault, guardMode: mode };
}

if (isMain(import.meta.url)) run(async () => { forgeBuild(); await deploySafety(); });
