// Shared env loading, chain guard, clients and link helpers. Every script and the agent go through here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

export const ROOT = resolve(import.meta.dirname, "../..");
export const ENV_PATH = resolve(ROOT, ".env");
export const DEPLOYMENTS_PATH = resolve(ROOT, "deployments.json");
export const CHAIN_ID = 97;
export const chain = bscTestnet;

if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

export const ROLES = ["DEPLOYER", "DEV", "GUARDED_USER", "UNGUARDED_USER", "AGENT"] as const;
export type Role = (typeof ROLES)[number];

export const RPC_HTTP = process.env.RPC_HTTP || "https://bsc-testnet-rpc.publicnode.com";
export const RPC_WS = process.env.RPC_WS || "wss://bsc-testnet-rpc.publicnode.com";
export const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "1500");

const MAINNET_HINTS = [/bsc-dataseed/i, /bsc-rpc\.publicnode/i, /bsc-mainnet/i, /binance\.org/i, /^https?:\/\/bsc\./i];
for (const url of [RPC_HTTP, RPC_WS]) {
  if (MAINNET_HINTS.some((r) => r.test(url)) && !/test|prebsc/i.test(url)) {
    console.error(`!! WARNING: RPC ${url} looks like BSC MAINNET. Refusing to run.`);
    process.exit(1);
  }
}

export const publicClient = createPublicClient({ chain, transport: http(RPC_HTTP, { retryCount: 3 }) });

let chainChecked = false;
/** Hard guard: refuse to do anything unless the RPC really is chain 97. */
export async function assertTestnet() {
  if (chainChecked) return;
  const id = await publicClient.getChainId();
  if (id !== CHAIN_ID) {
    console.error(`!! RPC reports chainId ${id}, expected ${CHAIN_ID} (BSC testnet). Refusing to run.`);
    process.exit(1);
  }
  chainChecked = true;
}

export function pk(role: Role): Hex {
  const v = process.env[`${role}_PK`];
  if (!v) throw new Error(`${role}_PK missing in .env (run \`npm run wallets\`)`);
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
}

export const account = (role: Role) => privateKeyToAccount(pk(role));
export const address = (role: Role): Address => account(role).address;

export function wallet(role: Role) {
  return createWalletClient({ account: account(role), chain, transport: http(RPC_HTTP, { retryCount: 3 }) });
}

export const txUrl = (h: Hash) => `https://testnet.bscscan.com/tx/${h}`;
export const addrUrl = (a: Address) => `https://testnet.bscscan.com/address/${a}`;
export const bnb = (wei: bigint, dp = 5) => Number(formatEther(wei)).toFixed(dp);

/** Wait for a tx, log its link, throw if it reverted. */
export async function confirm(label: string, hash: Hash) {
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${label}  ${txUrl(hash)}`);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

/** True when the calling module was run directly (not imported). */
export const isMain = (metaUrl: string) => resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1] ?? "");

/** Standard entry point: run main, print a short error, exit non-zero. */
export function run(main: () => Promise<unknown>) {
  main().then(
    () => process.exit(0),
    (e) => { console.error("ERROR:", e?.shortMessage ?? e?.message ?? e); process.exit(1); },
  );
}

export type Deployments = Record<string, any>;
export function readDeployments(): Deployments {
  return existsSync(DEPLOYMENTS_PATH) ? JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) : {};
}
export function writeDeployments(d: Deployments) {
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(d, null, 2) + "\n");
}
