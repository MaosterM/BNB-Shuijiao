// Agent configuration: addresses from deployments.json, thresholds from env (with defaults).
import type { Address } from "viem";
import { readDeployments } from "../scripts/lib/env.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./triggers.ts";

export function loadConfig() {
  const d = readDeployments();
  for (const k of ["token", "pair", "vault", "safeExit", "router", "wbnb"]) {
    if (!d[k]) throw new Error(`deployments.json missing "${k}" — run \`npm run reset\``);
  }
  const extraSafe = (process.env.SAFE_LIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  const thresholds: Thresholds = {
    teamDexSellBps: BigInt(process.env.T1_TEAM_DEX_SELL_BPS || DEFAULT_THRESHOLDS.teamDexSellBps),
    teamBigMoveBps: BigInt(process.env.T2_TEAM_BIG_MOVE_BPS || DEFAULT_THRESHOLDS.teamBigMoveBps),
    liquidityPullBps: BigInt(process.env.T3_LIQUIDITY_PULL_BPS || DEFAULT_THRESHOLDS.liquidityPullBps),
  };
  return {
    token: d.token as Address,
    pair: d.pair as Address,
    vault: d.vault as Address,
    safeExit: d.safeExit as Address,
    router: d.router as Address,
    team: (d.team as Address[]).map((a) => a.toLowerCase()),
    safeList: [...(d.safeList as string[]), ...extraSafe].map((a) => a.toLowerCase()),
    wallets: d.wallets as Record<string, Address>,
    thresholds,
    guardMode: (d.guardMode as string) || "vault",
    altana: d.altana as any,
    pollMs: Number(process.env.POLL_MS || 1000),
  };
}
export type Config = ReturnType<typeof loadConfig>;
