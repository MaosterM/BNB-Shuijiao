import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBatch, ZERO, type GuardState, type Log } from "./triggers.ts";

const E = 10n ** 18n;
const DEV = "0xdev0000000000000000000000000000000000001";
const POOL = "0xpool000000000000000000000000000000000002";
const USER = "0xuser000000000000000000000000000000000003";
const DEAD = "0x000000000000000000000000000000000000dead";
const LOCKER = "0xlock000000000000000000000000000000000004";

const state = (): GuardState => ({
  pool: POOL,
  team: new Set([DEV]),
  safe: new Set([DEAD, LOCKER]),
  balances: new Map([[DEV, 300_000n * E]]),
  reserves: { token: 150_000n * E, bnb: 50n * E },
  swapTxs: new Set(),
});
const tr = (from: string, to: string, value: bigint, tx = "0xa"): Log => ({ kind: "transfer", from, to, value, block: 1n, txHash: tx });
const sync = (t: bigint, b: bigint, tx = "0xa"): Log => ({ kind: "sync", reserveToken: t, reserveBnb: b, block: 1n, txHash: tx });

test("T1: team sells 5% into pool → TEAM_DEX_SELL", () => {
  const s = state();
  const hit = evaluateBatch([tr(DEV, POOL, 15_000n * E), sync(165_000n * E, 45n * E), { kind: "swap", block: 1n, txHash: "0xa" }], s);
  assert.equal(hit?.code, "TEAM_DEX_SELL");
  assert.equal(s.balances.get(DEV), 285_000n * E, "team balance tracked");
});

test("T1: team sell below 1% is ignored", () => {
  assert.equal(evaluateBatch([tr(DEV, POOL, 2_000n * E)], state()), null);
});

test("T2: team moves >20% to a fresh wallet → TEAM_BIG_MOVE", () => {
  assert.equal(evaluateBatch([tr(DEV, USER, 70_000n * E)], state())?.code, "TEAM_BIG_MOVE");
});

test("T2: moves to safe list (dEaD, locker) or ≤20% are ignored", () => {
  assert.equal(evaluateBatch([tr(DEV, DEAD, 200_000n * E)], state()), null);
  assert.equal(evaluateBatch([tr(DEV, LOCKER, 200_000n * E)], state()), null);
  assert.equal(evaluateBatch([tr(DEV, USER, 60_000n * E)], state()), null);
});

test("T3: Burn removing >10% of liquidity → LIQUIDITY_PULL", () => {
  // Pair emits Sync (post-burn reserves) then Burn in the same tx; the Sync alone already trips it.
  const s = state();
  const hit = evaluateBatch([sync(75_000n * E, 25n * E, "0xb"), { kind: "burn", amountToken: 75_000n * E, amountBnb: 25n * E, block: 1n, txHash: "0xb" }], s);
  assert.equal(hit?.code, "LIQUIDITY_PULL");
});

test("T3: Burn alone (no prior sync drop) is still caught", () => {
  const s = state();
  s.reserves = { token: 132_000n * E, bnb: 44n * E }; // reserves already updated: 6 of 50 BNB removed = 12%
  assert.equal(evaluateBatch([{ kind: "burn", amountToken: 18_000n * E, amountBnb: 6n * E, block: 1n, txHash: "0xc" }], s)?.code, "LIQUIDITY_PULL");
});

test("T3: big BNB reserve drop explained by a Swap is NOT a liquidity pull", () => {
  const s = state();
  const userSell = [tr(USER, POOL, 50_000n * E, "0xd"), sync(200_000n * E, 37n * E, "0xd"), { kind: "swap", block: 1n, txHash: "0xd" } as Log];
  assert.equal(evaluateBatch(userSell, s), null);
});

test("T3: small burn (≤10%) is ignored", () => {
  const s = state();
  assert.equal(evaluateBatch([sync(142_500n * E, 47_500n * E / 1000n, "0xe"), { kind: "burn", amountToken: 7_500n * E, amountBnb: 2_500n * E / 1000n, block: 1n, txHash: "0xe" }], s), null);
});

test("T4: transfer from zero address → MINT", () => {
  assert.equal(evaluateBatch([tr(ZERO, DEV, 1_000_000n * E)], state())?.code, "MINT");
});

test("ordinary user trade triggers nothing", () => {
  const s = state();
  assert.equal(evaluateBatch([tr(POOL, USER, 1_000n * E, "0xf"), sync(149_000n * E, 50_400n * E / 1000n, "0xf"), { kind: "swap", block: 1n, txHash: "0xf" }], s), null);
});

test("batch returns the FIRST trigger in chain order", () => {
  const hit = evaluateBatch([tr(DEV, POOL, 15_000n * E, "0x1"), tr(ZERO, DEV, E, "0x2")], state());
  assert.equal(hit?.code, "TEAM_DEX_SELL");
});
