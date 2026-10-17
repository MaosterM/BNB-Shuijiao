// Pure trigger logic. No I/O: the watcher feeds normalized logs, these functions decide.
export type Addr = string; // lowercase hex

export type Thresholds = {
  teamDexSellBps: bigint;  // T1: team → pool transfer ≥ this share of the wallet's holdings (100 = 1%)
  teamBigMoveBps: bigint;  // T2: team → non-safe transfer > this share (2000 = 20%)
  liquidityPullBps: bigint; // T3: burn / unexplained reserve drop > this share of the BNB reserve (1000 = 10%)
};
export const DEFAULT_THRESHOLDS: Thresholds = { teamDexSellBps: 100n, teamBigMoveBps: 2000n, liquidityPullBps: 1000n };

export type TriggerCode = "TEAM_DEX_SELL" | "TEAM_BIG_MOVE" | "LIQUIDITY_PULL" | "MINT";
export type Trigger = { code: TriggerCode; detail: string; block: bigint; txHash: string };

export type Log =
  | { kind: "transfer"; from: Addr; to: Addr; value: bigint; block: bigint; txHash: string }
  | { kind: "swap"; block: bigint; txHash: string }
  | { kind: "sync"; reserveToken: bigint; reserveBnb: bigint; block: bigint; txHash: string }
  | { kind: "burn"; amountToken: bigint; amountBnb: bigint; block: bigint; txHash: string };

export type GuardState = {
  pool: Addr;
  team: Set<Addr>;
  safe: Set<Addr>;
  balances: Map<Addr, bigint>; // team wallet token balances, kept current from Transfer logs
  reserves: { token: bigint; bnb: bigint }; // last known pool reserves
  swapTxs: Set<string>; // txs in the current batch containing a Swap
};

export const ZERO: Addr = "0x0000000000000000000000000000000000000000";
const pct = (n: bigint, d: bigint) => (d === 0n ? "∞" : `${(Number((n * 10000n) / d) / 100).toFixed(2)}%`);
const short = (a: Addr) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Evaluate one log against current state, then update state. Returns a trigger or null. */
export function evaluate(log: Log, s: GuardState, t: Thresholds = DEFAULT_THRESHOLDS): Trigger | null {
  const at = { block: log.block, txHash: log.txHash };
  let hit: Trigger | null = null;

  if (log.kind === "transfer") {
    const { from, to, value } = log;
    if (from === ZERO) {
      hit = { code: "MINT", detail: `${fmt(value)} new RUGME minted to ${short(to)}`, ...at };
    } else if (s.team.has(from)) {
      const held = s.balances.get(from) ?? 0n;
      if (to === s.pool && value * 10000n >= held * t.teamDexSellBps && value > 0n) {
        hit = { code: "TEAM_DEX_SELL", detail: `team wallet ${short(from)} sold ${fmt(value)} RUGME into the pool (${pct(value, held)} of its holdings)`, ...at };
      } else if (to !== s.pool && !s.safe.has(to) && value * 10000n > held * t.teamBigMoveBps) {
        hit = { code: "TEAM_BIG_MOVE", detail: `team wallet ${short(from)} moved ${pct(value, held)} of its holdings to ${short(to)}`, ...at };
      }
    }
    if (s.team.has(from)) s.balances.set(from, (s.balances.get(from) ?? 0n) - value);
    if (s.team.has(to)) s.balances.set(to, (s.balances.get(to) ?? 0n) + value);
  } else if (log.kind === "swap") {
    s.swapTxs.add(log.txHash);
  } else if (log.kind === "burn") {
    // The pair emits Sync before Burn, so reserves already reflect the burn: pre-burn = now + removed.
    const before = s.reserves.bnb + log.amountBnb;
    if (log.amountBnb * 10000n > before * t.liquidityPullBps) {
      hit = { code: "LIQUIDITY_PULL", detail: `liquidity removed: ${pct(log.amountBnb, before)} of the pool's BNB`, ...at };
    }
  } else if (log.kind === "sync") {
    const prev = s.reserves.bnb;
    const drop = prev > log.reserveBnb ? prev - log.reserveBnb : 0n;
    // A Swap selling RUGME also lowers the BNB reserve; only unexplained drops count here.
    if (!s.swapTxs.has(log.txHash) && drop * 10000n > prev * t.liquidityPullBps) {
      hit = { code: "LIQUIDITY_PULL", detail: `pool BNB reserve fell ${pct(drop, prev)} with no swap`, ...at };
    }
    s.reserves = { token: log.reserveToken, bnb: log.reserveBnb };
  }
  return hit;
}

/**
 * Evaluate a batch of logs in chain order. Swap txs are collected first because the pair emits
 * Sync before Swap within a tx. Returns the first trigger (if any); state is updated for all logs.
 */
export function evaluateBatch(logs: Log[], s: GuardState, t: Thresholds = DEFAULT_THRESHOLDS): Trigger | null {
  s.swapTxs = new Set(logs.filter((l) => l.kind === "swap").map((l) => l.txHash));
  let first: Trigger | null = null;
  for (const log of logs) {
    const hit = evaluate(log, s, t);
    if (hit && !first) first = hit;
  }
  return first;
}

const fmt = (wei: bigint) => Number(wei / 10n ** 18n).toLocaleString("en-US");
