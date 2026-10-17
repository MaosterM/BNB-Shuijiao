// The only thing the agent can do with user funds: sell the token, proceeds back to the owner.
// Deterministic: everything is prepared at arm time; eject() signs locally and makes one submission
// (sendRawTransaction, or one Altana relay call). No LLM, no other network calls.
import { encodeFunctionData, parseEventLogs, type Address, type Hash } from "viem";
import { createClient, BNB_TESTNET, signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import { CHAIN_ID, SLIPPAGE_BPS, account, pk, publicClient } from "../scripts/lib/env.ts";
import { artifact, erc20Abi, quoteSell } from "../scripts/lib/contracts.ts";

export type Reserves = { token: bigint; bnb: bigint };
export type Submission = { id: string; wait: () => Promise<{ ok: boolean; hash?: Hash }> };

/** Executor adapters: GuardedVault or an Altana session key, behind one interface. */
export interface EjectAdapter {
  name: string;
  holder: Address; // where the protected tokens (and the proceeds) live
  prepare(): Promise<void>;
  /** Sign + submit the sale with this minimum. Resolves as soon as it is submitted. */
  submit(minOutBNB: bigint): Promise<Submission>;
  /** Tokens currently protected (read at prepare time). */
  amount(): bigint;
}

const safeExitAbi = () => artifact("SafeExit").abi;

export class GuardedVaultAdapter implements EjectAdapter {
  name = "GuardedVault";
  private bal = 0n;
  private nonce = 0;
  private gasPrice = 0n;
  private abi = artifact("GuardedVault").abi;
  private agent = account("AGENT");
  constructor(public holder: Address, private token: Address) {}

  async prepare() {
    const [bal, nonce, gp] = await Promise.all([
      publicClient.readContract({ address: this.token, abi: erc20Abi, functionName: "balanceOf", args: [this.holder] }),
      publicClient.getTransactionCount({ address: this.agent.address, blockTag: "pending" }),
      publicClient.getGasPrice(),
    ]);
    this.bal = bal;
    this.nonce = nonce;
    this.gasPrice = gp * 3n; // pay up to be first in line; still a fraction of a cent on testnet
  }
  amount() { return this.bal; }

  async submit(minOutBNB: bigint): Promise<Submission> {
    const data = encodeFunctionData({ abi: this.abi, functionName: "eject", args: [minOutBNB] });
    const serializedTransaction = await this.agent.signTransaction({
      chainId: CHAIN_ID, type: "legacy", to: this.holder, data, gas: 400_000n, gasPrice: this.gasPrice, nonce: this.nonce,
    });
    this.nonce++;
    const hash = await publicClient.sendRawTransaction({ serializedTransaction });
    return {
      id: hash,
      wait: async () => ({ ok: (await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300 })).status === "success", hash }),
    };
  }
}

/** Altana: the user's own EIP-7702 wallet; AGENT's session may only call SafeExit.exit (on-chain policy). */
export class AltanaAdapter implements EjectAdapter {
  name = "Altana session";
  private bal = 0n;
  private client = createClient({ chains: [BNB_TESTNET] });
  private session: Session;
  constructor(public holder: Address, private token: Address, private safeExit: Address, meta: any) {
    this.session = {
      walletAddress: holder,
      signer: signerFromPrivateKey(pk("AGENT")),
      publicKey: meta.publicKey,
      expiry: meta.expiry,
      permissions: {
        calls: meta.permissions.calls,
        spend: meta.permissions.spend.map((s: any) => ({ ...s, limit: BigInt(s.limit) })),
      },
    };
  }
  async prepare() {
    if (this.session.expiry * 1000 < Date.now()) throw new Error("Altana session expired — rerun scripts/altana-setup.ts");
    this.bal = await publicClient.readContract({ address: this.token, abi: erc20Abi, functionName: "balanceOf", args: [this.holder] });
  }
  amount() { return this.bal; }

  async submit(minOutBNB: bigint): Promise<Submission> {
    // amountIn = 0 → SafeExit sells the full balance; proceeds go to msg.sender = the user's wallet.
    const data = encodeFunctionData({ abi: safeExitAbi(), functionName: "exit", args: [this.token, 0n, minOutBNB] });
    const pending = this.client.execute({ session: this.session, calls: { to: this.safeExit, data } });
    return {
      id: "altana-relay",
      wait: async () => {
        const r = await pending;
        return { ok: r.status === "CONFIRMED", hash: r.transactionHash };
      },
    };
  }
}

export type EjectResult = { ok: boolean; hash?: Hash; bnbOut: bigint; retried: boolean };

/** BNB the user received, read from SafeExit's Ejected event (works for both adapters). */
async function proceeds(hash: Hash): Promise<bigint> {
  const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300 });
  const ev = parseEventLogs({ abi: safeExitAbi(), logs: r.logs, eventName: "Ejected" })[0] as any;
  return ev ? (ev.args.bnbOut as bigint) : 0n;
}

export function createExecutor(adapter: EjectAdapter, log: (m: string) => void) {
  let fired = false;
  return {
    get fired() { return fired; },
    /** Eject once. Returns right after submission; `settled` resolves with the on-chain result. */
    async eject(reason: string, reserves: Reserves) {
      if (fired) return null;
      fired = true;
      const quote = quoteSell(adapter.amount(), reserves);
      const minOut = (quote * (10000n - SLIPPAGE_BPS)) / 10000n;
      const sub = await adapter.submit(minOut);
      const broadcastAt = Date.now();
      const settled = (async (): Promise<EjectResult> => {
        let r = await sub.wait().catch((e) => ({ ok: false, hash: undefined, err: e }));
        let retried = false;
        if (!r.ok) {
          // A failed emergency sale is worse than a bad price: retry once with no minimum.
          log(`eject failed (${r.hash ?? sub.id}); retrying with minOut = 0`);
          retried = true;
          r = await (await adapter.submit(0n)).wait().catch((e) => ({ ok: false, hash: undefined, err: e }));
        }
        return { ok: r.ok, hash: r.hash, bnbOut: r.ok && r.hash ? await proceeds(r.hash) : 0n, retried };
      })();
      return { id: sub.id, broadcastAt, minOut, quote, reason, settled };
    },
  };
}
