// Altana mode: GUARDED keeps its RUGME in its own Altana wallet (EIP-7702 account). AGENT gets a session
// that may ONLY call SafeExit.exit(...) — enforced on-chain by the Altana account validator — and SafeExit
// always pays msg.sender, i.e. the user's own wallet. Session metadata (no secrets) → deployments.json.
import { createClient, BNB_TESTNET, signerFromPrivateKey } from "@altananetwork/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeErrorResult, maxUint256, parseEther, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ROOT, address, assertTestnet, confirm, isMain, pk, publicClient, readDeployments, run, txUrl, wallet, writeDeployments } from "./lib/env.ts";
import { erc20Abi } from "./lib/contracts.ts";

export const EXIT_SIGNATURE = "exit(address,uint256,uint256)";
export const altanaClient = () => createClient({ chains: [BNB_TESTNET] });

// The session private key is a secret: kept in a gitignored, owner-only file, never in deployments.json.
const SESSION_KEY_PATH = resolve(ROOT, ".altana/session-key.json");
function saveSessionKey(key: Hex) {
  mkdirSync(dirname(SESSION_KEY_PATH), { recursive: true });
  writeFileSync(SESSION_KEY_PATH, JSON.stringify({ privateKey: key }) + "\n", { mode: 0o600 });
}
export function loadSessionKey(): Hex {
  if (!existsSync(SESSION_KEY_PATH)) throw new Error("no Altana session key — run a reset with GUARD_MODE=altana");
  return JSON.parse(readFileSync(SESSION_KEY_PATH, "utf8")).privateKey;
}

/** Flatten an Altana/viem error and decode any Error(string) revert reason inside it. */
export function altanaError(e: any): string {
  const text = [e?.shortMessage, e?.details, e?.cause?.shortMessage, e?.cause?.details, e?.message].filter(Boolean).join(" | ");
  const hex = text.match(/0x08c379a0[0-9a-fA-F]+/)?.[0];
  if (hex) {
    try { return `reverted: ${decodeErrorResult({ abi: [], data: hex as Hex }).args?.[0]}`; } catch {}
  }
  return text.split(" | ")[0] || "unknown error";
}

export async function altanaSetup() {
  await assertTestnet();
  const d = readDeployments();
  const token = d.token as Address, safeExit = d.safeExit as Address;
  const client = altanaClient();
  const admin = signerFromPrivateKey(pk("GUARDED_USER"));

  const { address: walletAddr } = await client.createWallet({ signer: admin });
  console.log(`Altana wallet ${walletAddr} (GUARDED EOA ${address("GUARDED_USER")})`);
  const w = { address: walletAddr as Address };

  // Move GUARDED's RUGME into the Altana wallet if it is a separate address.
  if (walletAddr.toLowerCase() !== address("GUARDED_USER").toLowerCase()) {
    const bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address("GUARDED_USER")] });
    if (bal > 0n) await confirm("GUARDED RUGME → Altana wallet", await wallet("GUARDED_USER").writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [walletAddr, bal] }));
  }

  // Admin (the user) pre-approves SafeExit, so the session itself never needs approve().
  const approve = await client.execute({
    wallet: w, signer: admin,
    calls: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [safeExit, maxUint256] }) },
  });
  console.log(`  ${approve.status === "CONFIRMED" ? "✓" : "✗"} admin approve RUGME → SafeExit  ${approve.transactionHash ? txUrl(approve.transactionHash) : approve.callsId}`);
  if (approve.status !== "CONFIRMED") throw new Error(`approve failed: ${JSON.stringify(approve)}`);

  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const permissions = {
    calls: [{ to: safeExit, signature: EXIT_SIGNATURE }],
    spend: [{ limit: parseEther("0.002"), period: "day" as const }], // native cap = relay fees only
  };
  // A FRESH session key per grant: the KeyStore registry rejects re-registering a key
  // ("KeyStore: key already registered"), so the same key can't be granted twice.
  const sessionPk = generatePrivateKey();
  const grant = () => client.grantSession({ wallet: w, signer: admin, permissions, expiry, sessionSigner: signerFromPrivateKey(sessionPk) });
  const session = await grant()
    .catch(async (e: any) => {
      if (/already registered/i.test(altanaError(e))) throw e;
      console.log(`  … grantSession failed (${altanaError(e)}); retrying once`);
      return grant();
    })
    .catch((e: any) => { throw new Error(`grantSession failed: ${altanaError(e)}`); });
  saveSessionKey(sessionPk);
  console.log(`  ✓ session granted to the agent: only ${safeExit}.${EXIT_SIGNATURE}, expires ${new Date(expiry * 1000).toISOString()}  ${session.transactionHash ? txUrl(session.transactionHash) : ""}`);

  const altana = {
    wallet: walletAddr, publicKey: session.publicKey, expiry,
    permissions: { calls: permissions.calls, spend: permissions.spend.map((s) => ({ ...s, limit: s.limit.toString() })) },
    grantTx: session.transactionHash ?? null,
  };
  writeDeployments({ ...readDeployments(), altana });
  return altana;
}

if (isMain(import.meta.url)) run(altanaSetup);
