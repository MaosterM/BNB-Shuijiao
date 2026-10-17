// Prove the Altana session's scope: AGENT's session key must be refused for anything except SafeExit.exit.
import { createClient, BNB_TESTNET, signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import { encodeFunctionData, parseEther, type Address } from "viem";
import { address, assertTestnet, pk, readDeployments, run } from "./lib/env.ts";
import { erc20Abi } from "./lib/contracts.ts";

run(async () => {
  await assertTestnet();
  const d = readDeployments();
  if (d.guardMode !== "altana") throw new Error("deployments.json is not in Altana mode (GUARD_MODE=altana npm run reset)");
  const m = d.altana;
  const session: Session = {
    walletAddress: m.wallet, signer: signerFromPrivateKey(pk("AGENT")), publicKey: m.publicKey, expiry: m.expiry,
    permissions: { calls: m.permissions.calls, spend: m.permissions.spend.map((s: any) => ({ ...s, limit: BigInt(s.limit) })) },
  };
  const client = createClient({ chains: [BNB_TESTNET] });
  const agent = address("AGENT");
  const attempts: [string, { to: Address; data?: `0x${string}`; value?: bigint }][] = [
    ["transfer RUGME to AGENT", { to: d.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [agent, 1n] }) }],
    ["approve AGENT for RUGME", { to: d.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agent, 1n] }) }],
    ["send 0.0001 BNB to AGENT", { to: agent, value: parseEther("0.0001") }],
  ];
  let allRefused = true;
  for (const [label, call] of attempts) {
    const r = await client.execute({ session, calls: call }).catch((e: any) => ({ status: "FAILED", error: e.shortMessage ?? e.message }));
    const refused = (r as any).status !== "CONFIRMED";
    allRefused &&= refused;
    console.log(`${refused ? "PASS" : "FAIL"}  session cannot ${label}: ${refused ? `refused (${(r as any).statusCode ?? (r as any).error ?? "FAILED"})`.slice(0, 120) : "it WENT THROUGH"}`);
  }
  console.log(`\nVerify on-chain: grant tx https://testnet.bscscan.com/tx/${m.grantTx} — session key ${m.publicKey.slice(0, 18)}… scoped to ${m.permissions.calls[0].to}.${m.permissions.calls[0].signature}`);
  if (!allRefused) process.exitCode = 1;
});
