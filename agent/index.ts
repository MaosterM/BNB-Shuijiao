// Ejector Seat agent: arm the guard, watch the chain, eject on the first trigger.
// The trigger → sell path is plain code: evaluateBatch() → executor.eject() → one sendRawTransaction.
import { assertTestnet, address, bnb, isMain, publicClient } from "../scripts/lib/env.ts";
import { erc20Abi, quoteSell, reserves as readReserves } from "../scripts/lib/contracts.ts";
import { loadConfig } from "./config.ts";
import { evaluateBatch, type GuardState } from "./triggers.ts";
import { startWatcher, type Batch } from "./watcher.ts";
import { AltanaAdapter, GuardedVaultAdapter, createExecutor } from "./executor.ts";
import { changed, emit, state } from "./bus.ts";
import { startApi } from "./server.ts";
import { preflight } from "./preflight.ts";
import { explain } from "./explainer.ts";

const toNum = (wei: bigint) => Number(wei) / 1e18;

export async function startAgent() {
  await assertTestnet();
  const cfg = loadConfig();
  Object.assign(state, { token: cfg.token, pair: cfg.pair, vault: cfg.vault });
  startApi();

  // --- Arm: read everything the hot path needs, once. ---
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const [r, teamBals] = await Promise.all([
    readReserves(cfg.pair, cfg.token),
    Promise.all(cfg.team.map((a) => publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [a as `0x${string}`] }))),
  ]);
  const guard: GuardState = {
    pool: cfg.pair.toLowerCase(),
    team: new Set(cfg.team),
    safe: new Set(cfg.safeList),
    balances: new Map(cfg.team.map((a, i) => [a, teamBals[i]])),
    reserves: { token: r.token, bnb: r.bnb },
    swapTxs: new Set(),
  };
  const adapter = cfg.guardMode === "altana"
    ? new AltanaAdapter(cfg.altana.wallet, cfg.token, cfg.safeExit, cfg.altana)
    : new GuardedVaultAdapter(cfg.vault, cfg.token);
  state.vault = adapter.holder;
  await adapter.prepare();
  const executor = createExecutor(adapter, (m) => emit("warn", m));

  const unguardedBal = await publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [address("UNGUARDED_USER")] });
  state.guarded.startBnb = state.guarded.nowBnb = toNum(quoteSell(adapter.amount(), guard.reserves));
  state.unguarded.startBnb = state.unguarded.nowBnb = toNum(quoteSell(unguardedBal, guard.reserves));
  const pushPrice = (block: bigint) => {
    const p = guard.reserves.token ? Number(guard.reserves.bnb) / Number(guard.reserves.token) : 0;
    state.priceHistory.push({ t: Date.now(), block: Number(block), price: p });
    if (!state.guarded.ejected) state.guarded.nowBnb = toNum(quoteSell(adapter.amount(), guard.reserves));
    state.unguarded.nowBnb = toNum(quoteSell(unguardedBal, guard.reserves));
  };
  pushPrice(head);
  let lastBlock = head;
  // Chart heartbeat from already-known reserves (no RPC), so the line moves with time.
  setInterval(() => { pushPrice(lastBlock); if (state.priceHistory.length > 600) state.priceHistory.shift(); changed(); }, 1000).unref();

  const teamDesc = cfg.team.map((a) => `${a.slice(0, 6)}…${a.slice(-4)} (${(toNum(guard.balances.get(a)!)).toLocaleString()} RUGME)`).join(", ");
  emit("info", `watching team ${teamDesc}, pool ${cfg.pair}`);
  emit("info", `protecting ${toNum(adapter.amount()).toLocaleString()} RUGME in ${adapter.name} ${adapter.holder} ≈ ${state.guarded.startBnb.toFixed(6)} tBNB`);

  // --- Hot path ---
  const onBatch = async (b: Batch) => {
    const trig = evaluateBatch(b.logs, guard, cfg.thresholds);
    if (trig && !executor.fired) {
      const res = await executor.eject(`${trig.code}: ${trig.detail}`, guard.reserves); // ← the only action
      if (!res) return;
      const latency = res.broadcastAt - b.seenAt;
      state.status = "ejected";
      emit("trigger", `${trig.code} in block ${trig.block}: ${trig.detail}`, { tx: trig.txHash });
      emit("eject", `sell ${res.id.startsWith("0x") ? "broadcast" : `submitted to ${adapter.name}`} ${latency}ms after seeing block ${trig.block} (minOut ${bnb(res.minOut, 6)} tBNB)`, res.id.startsWith("0x") ? { tx: res.id } : {});
      changed();
      // Off the hot path: chain timestamps + receipt.
      publicClient.getBlock({ blockNumber: trig.block }).then((blk) => {
        emit("timing", `trigger block time ${new Date(Number(blk.timestamp) * 1000).toLocaleTimeString("en-GB")} · seen ${new Date(b.seenAt).toLocaleTimeString("en-GB")} · broadcast ${new Date(res.broadcastAt).toLocaleTimeString("en-GB")} · latency ${latency}ms`);
      }).catch(() => {});
      res.settled.then(async (out) => {
        const vaultBnb = out.bnbOut;
        state.guarded = { ...state.guarded, ejected: out.ok, nowBnb: toNum(vaultBnb), tx: out.hash ?? "" };
        state.status = out.ok ? "ejected" : "eject_failed";
        state.ejection = { trigger: trig.code, detail: trig.detail, block: Number(trig.block), triggerTx: trig.txHash, tx: out.hash, latencyMs: latency, bnbOut: toNum(vaultBnb), at: res.broadcastAt, adapter: adapter.name };
        emit(out.ok ? "ejected" : "error", out.ok ? `EJECTED ✓ ${adapter.name === "GuardedVault" ? "vault" : "user wallet"} received ${bnb(vaultBnb, 6)} tBNB` : "EJECT FAILED", out.hash ? { tx: out.hash } : {});
        changed();
        if (!out.ok) return;
        // Non-urgent: explain once the dust settles.
        const delay = Number(process.env.EXPLAIN_DELAY_MS || 60_000);
        setTimeout(async () => {
          const rNow = await readReserves(cfg.pair, cfg.token);
          state.explanation = await explain({
            ejectedAt: res.broadcastAt, reason: trig.detail, bnbOut: toNum(vaultBnb),
            priceAtArm: state.priceHistory[0]?.price ?? 0,
            priceNow: rNow.token ? Number(rNow.bnb) / Number(rNow.token) : 0,
            holdValueNow: toNum(quoteSell(adapter.amount(), rNow)),
          });
          emit("explain", state.explanation);
          changed();
        }, delay);
      }).catch((e) => emit("error", `eject receipt error: ${e.shortMessage ?? e.message}`));
    }
    // Non-urgent bookkeeping after the decision.
    lastBlock = b.head;
    pushPrice(b.head);
    if (trig && executor.fired && state.ejection && trig.txHash !== state.ejection.triggerTx) emit("signal", `${trig.code}: ${trig.detail}`, { tx: trig.txHash });
    changed();
  };

  const watcher = startWatcher({
    token: cfg.token, pair: cfg.pair, tokenIs0: r.tokenIs0, fromBlock: head + 1n, pollMs: cfg.pollMs,
    onBatch: (b) => { onBatch(b).catch((e) => emit("error", `hot path error: ${e.shortMessage ?? e.message}`)); },
    onInfo: (m) => emit("info", m),
  });
  state.status = "armed";
  emit("armed", `GUARD ARMED at block ${head} — eject on first trigger, slippage ${Number(process.env.SLIPPAGE_BPS || 1500) / 100}%`);
  changed();
  // Non-urgent: risk brief (code facts + optional LLM wording). Never blocks the guard.
  preflight().then((b) => {
    state.brief = b;
    emit("brief", `${b.risk} risk · ${b.flags.join(" · ")} (${b.source})`);
    changed();
  }).catch((e) => emit("warn", `preflight failed: ${e.shortMessage ?? e.message}`));
  return { watcher, executor, state };
}

if (isMain(import.meta.url)) {
  startAgent().catch((e) => { console.error("ERROR:", e.shortMessage ?? e.message); process.exit(1); });
}
