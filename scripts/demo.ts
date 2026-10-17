// Acceptance test: reset → start agent → wait for "GUARD ARMED" → rug → final balances.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseEther, type Address } from "viem";
import { ROOT, address, assertTestnet, bnb, publicClient, readDeployments, run } from "./lib/env.ts";
import { erc20Abi, quoteSell, reserves } from "./lib/contracts.ts";
import { reset } from "./reset.ts";
import { rug } from "./rug.ts";

const SKIP_RESET = process.argv.includes("--no-reset");

run(async () => {
  await assertTestnet();
  console.log("━━ 1/4 RESET ━━");
  if (!SKIP_RESET) await reset();
  const d = readDeployments();
  const token = d.token as Address, pair = d.pair as Address;
  const vault = (d.guardMode === "altana" ? d.altana.wallet : d.vault) as Address; // where GUARDED's tokens live
  console.log(`Guard mode: ${d.guardMode === "altana" ? "Altana session key (user's own wallet)" : "GuardedVault"}`);
  const bal = (a: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  const r0 = await reserves(pair, token);
  const gTok = await bal(vault), uTok = await bal(address("UNGUARDED_USER"));
  const gStart = quoteSell(gTok, r0), uStart = quoteSell(uTok, r0);

  console.log("\n━━ 2/4 START AGENT ━━");
  const agent = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "agent/index.ts")], {
    cwd: ROOT, env: { EXPLAIN_DELAY_MS: "15000", ...process.env, DEMO: "1" }, stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "", partial = "";
  agent.stdout.on("data", (c) => {
    const s = c.toString();
    out += s;
    const lines = (partial + s).split("\n");
    partial = lines.pop()!;
    for (const l of lines) console.log(`  agent│ ${l.trimEnd()}`);
  });
  const waitFor = (re: RegExp, ms: number) => new Promise<boolean>((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (re.test(out)) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > ms || agent.exitCode !== null) { clearInterval(iv); res(false); }
    }, 100);
  });
  if (!(await waitFor(/GUARD ARMED/, 60_000))) throw new Error("agent never armed");

  console.log("\n━━ 3/4 RUG ━━");
  await rug();
  await waitFor(/EJECTED ✓|EJECT FAILED/, 30_000);
  await new Promise((r) => setTimeout(r, 1500)); // let the agent print timing lines

  console.log("\n━━ 4/4 RESULT ━━");
  const r1 = await reserves(pair, token);
  // GUARDED = BNB received from the ejection (SafeExit Ejected event) + any tokens still held.
  const recv = out.match(/received ([\d.]+) tBNB/);
  const gNow = (recv ? parseEther(recv[1]) : 0n) + quoteSell(await bal(vault), r1);
  const uNow = quoteSell(await bal(address("UNGUARDED_USER")), r1);
  const pctOf = (a: bigint, b: bigint) => (b === 0n ? 0 : (Number(a) / Number(b)) * 100);
  console.log(`              start value      final value      kept`);
  console.log(`GUARDED     ${bnb(gStart, 6).padStart(10)} tBNB  ${bnb(gNow, 6).padStart(10)} tBNB  ${pctOf(gNow, gStart).toFixed(1).padStart(6)}%`);
  console.log(`UNGUARDED   ${bnb(uStart, 6).padStart(10)} tBNB  ${bnb(uNow, 6).padStart(10)} tBNB  ${pctOf(uNow, uStart).toFixed(1).padStart(6)}%`);
  const m = out.match(/sell broadcast (\d+)ms/);
  if (m) console.log(`Eject latency: ${m[1]}ms from seeing the trigger block to broadcast`);
  const ej = out.match(/EJECTED ✓.*?(https:\S+)/);
  if (ej) console.log(`Eject tx: ${ej[1]}`);
  if (await waitFor(/\] explain /, 45_000)) {
    console.log(`\nWhat happened: ${out.match(/\] explain\s+(.*)/)![1]}`);
  }
  const pass = pctOf(gNow, gStart) > 50 && pctOf(uNow, uStart) < 20;
  console.log(pass ? "\nACCEPTANCE: PASS ✓" : "\nACCEPTANCE: FAIL ✗");
  await new Promise((r) => setTimeout(r, 1500)); // let the dashboard receive the final state
  if (!process.env.KEEP_AGENT) agent.kill();
  if (!pass) process.exitCode = 1;
});
