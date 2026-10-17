// Pre-flight risk brief. CODE computes every fact; the LLM may only rephrase them in 4 lines.
import type { Address } from "viem";
import { assertTestnet, isMain, publicClient, run } from "../scripts/lib/env.ts";
import { erc20Abi, pairAbi, reserves } from "../scripts/lib/contracts.ts";
import { loadConfig } from "./config.ts";
import { llm, onlyKnownNumbers } from "./llm.ts";

const MINT_SELECTOR = "40c10f19"; // mint(address,uint256)
const E18 = 1e18;
const p2 = (x: number) => x.toFixed(1);

export async function preflight() {
  await assertTestnet();
  const cfg = loadConfig();
  const token = cfg.token, pair = cfg.pair;
  const read = (address: Address, abi: any, functionName: string, args: any[] = []) =>
    publicClient.readContract({ address, abi, functionName, args }) as Promise<any>;

  const [supply, lpSupply, code, r] = await Promise.all([
    read(token, erc20Abi, "totalSupply"),
    read(pair, pairAbi, "totalSupply"),
    publicClient.getBytecode({ address: token }),
    reserves(pair, token),
  ]);
  const owner: string | null = await read(token, erc20Abi, "owner").catch(() => null);
  const team = await Promise.all(cfg.team.map(async (a) => ({
    address: a,
    tokenPct: (Number(await read(token, erc20Abi, "balanceOf", [a])) / Number(supply)) * 100,
    lpPct: (Number(await read(pair, pairAbi, "balanceOf", [a])) / Number(lpSupply)) * 100,
  })));
  const teamTokenPct = team.reduce((s, t) => s + t.tokenPct, 0);
  const teamLpPct = team.reduce((s, t) => s + t.lpPct, 0);
  const hasMint = !!code?.toLowerCase().includes(MINT_SELECTOR);
  const ownerRenounced = !owner || /^0x0{40}$/i.test(owner);
  const ownerIsTeam = !!owner && cfg.team.includes(owner.toLowerCase());
  const poolBnb = Number(r.bnb) / E18;

  const facts = {
    totalSupply: Number(supply) / E18,
    teamTokenPct: +p2(teamTokenPct),
    teamLpPct: +p2(teamLpPct),
    liquidityUnlocked: teamLpPct > 50,
    ownerCanMint: hasMint && !ownerRenounced,
    ownerIsTeam,
    poolBnb: +poolBnb.toFixed(4),
  };
  let score = 0;
  if (facts.teamTokenPct > 20) score += 2;
  if (facts.liquidityUnlocked) score += 3;
  if (facts.ownerCanMint) score += 2;
  if (facts.poolBnb < 1) score += 1;
  const risk = score >= 5 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
  const recommendedMode = risk === "HIGH" ? "hair-trigger: eject on the first team sale ≥1% of its bag" : "standard";

  const flags = [
    `Team holds ${p2(teamTokenPct)}% of supply`,
    `Team holds ${p2(teamLpPct)}% of LP${facts.liquidityUnlocked ? " — liquidity unlocked" : ""}`,
    facts.ownerCanMint ? "Owner can mint new supply" : "No owner mint",
    `Pool depth ${facts.poolBnb} tBNB`,
  ];
  const template = [
    `${risk} risk: one team wallet holds ${p2(teamTokenPct)}% of all RUGME and ${p2(teamLpPct)}% of the pool's LP tokens.`,
    facts.liquidityUnlocked ? "The liquidity is not locked, so the team can pull it at any moment." : "Most liquidity is not held by the team.",
    facts.ownerCanMint ? "The token owner can mint unlimited new supply." : "There is no owner mint function.",
    `Ejector Seat is armed in ${recommendedMode.split(":")[0]} mode and will sell for BNB on the first sign of a dump.`,
  ].join("\n");

  const factsJson = JSON.stringify({ risk, ...facts, recommendedMode });
  let summary = template;
  const out = await llm(
    `You write a 4-line plain-English risk brief for a crypto user. Use ONLY these facts; do not add any number not present here. ` +
    `No markdown, exactly 4 short lines.\nFACTS: ${factsJson}`,
  );
  if (out && onlyKnownNumbers(out, factsJson + template)) summary = out;

  return { risk, facts, watched: { team: cfg.team, pool: pair, token }, recommendedMode, flags, summary, source: summary === template ? "template" : "llm" };
}

if (isMain(import.meta.url)) run(async () => console.log(JSON.stringify(await preflight(), null, 2)));
