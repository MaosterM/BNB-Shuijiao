// Watches RUGME Transfer + pool Swap/Sync/Burn. New heads arrive over WebSocket when it works; an HTTP
// poll runs regardless as a safety net. Each fetch re-scans a few blocks (public RPCs can lag behind
// each other) and de-duplicates by txHash:logIndex, so no log is processed twice or skipped.
import { createPublicClient, parseAbiItem, webSocket, type Address } from "viem";
import { RPC_WS, chain, publicClient } from "../scripts/lib/env.ts";
import type { Log } from "./triggers.ts";

const EVENTS = [
  parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  parseAbiItem("event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"),
  parseAbiItem("event Sync(uint112 reserve0,uint112 reserve1)"),
  parseAbiItem("event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)"),
];
const OVERLAP = 3n;

export type Batch = { logs: Log[]; head: bigint; seenAt: number };

export function startWatcher(opts: {
  token: Address; pair: Address; tokenIs0: boolean; fromBlock: bigint; pollMs: number;
  onBatch: (b: Batch) => void; onInfo?: (msg: string) => void;
}) {
  const { token, pair, tokenIs0 } = opts;
  const tokenL = token.toLowerCase(), pairL = pair.toLowerCase();
  let last = opts.fromBlock - 1n; // last block fully processed
  const seen = new Map<string, bigint>(); // log key → block (pruned)
  let running = false, again = false, stopped = false;

  const normalize = (l: any): Log | null => {
    const base = { block: l.blockNumber as bigint, txHash: l.transactionHash as string };
    const addr = (l.address as string).toLowerCase();
    if (l.eventName === "Transfer") {
      if (addr !== tokenL) return null; // ignore LP-token transfers
      return { kind: "transfer", from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase(), value: l.args.value, ...base };
    }
    if (addr !== pairL) return null;
    if (l.eventName === "Swap") return { kind: "swap", ...base };
    if (l.eventName === "Sync") {
      const [t, b] = tokenIs0 ? [l.args.reserve0, l.args.reserve1] : [l.args.reserve1, l.args.reserve0];
      return { kind: "sync", reserveToken: t, reserveBnb: b, ...base };
    }
    if (l.eventName === "Burn") {
      const [t, b] = tokenIs0 ? [l.args.amount0, l.args.amount1] : [l.args.amount1, l.args.amount0];
      return { kind: "burn", amountToken: t, amountBnb: b, ...base };
    }
    return null;
  };

  async function tick() {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (head > last) {
        const fromBlock = last - OVERLAP + 1n > opts.fromBlock ? last - OVERLAP + 1n : opts.fromBlock;
        const raw = await publicClient.getLogs({ address: [token, pair], events: EVENTS, fromBlock, toBlock: head });
        const seenAt = Date.now();
        raw.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
        const fresh: Log[] = [];
        for (const l of raw) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(key)) continue;
          seen.set(key, l.blockNumber!);
          const n = normalize(l);
          if (n) fresh.push(n);
        }
        if (head > last) last = head;
        for (const [k, b] of seen) if (b < last - 20n) seen.delete(k);
        if (fresh.length) opts.onBatch({ logs: fresh, head, seenAt });
      }
    } catch (e: any) {
      opts.onInfo?.(`watcher fetch error (will retry): ${e.shortMessage ?? e.message}`);
    } finally {
      running = false;
      if (again) { again = false; setImmediate(tick); }
    }
  }

  const timer = setInterval(tick, opts.pollMs);
  let unwatchWs: (() => void) | undefined;
  try {
    const ws = createPublicClient({ chain, transport: webSocket(RPC_WS, { reconnect: true }) });
    unwatchWs = ws.watchBlockNumber({
      emitOnBegin: false,
      onBlockNumber: () => tick(),
      onError: (e) => opts.onInfo?.(`ws error, HTTP poll continues: ${e.message.split("\n")[0]}`),
    });
    opts.onInfo?.(`watching via WebSocket new heads + ${opts.pollMs}ms HTTP poll`);
  } catch {
    opts.onInfo?.(`WebSocket unavailable; HTTP poll every ${opts.pollMs}ms`);
  }
  tick();
  return { stop() { stopped = true; clearInterval(timer); unwatchWs?.(); } };
}
