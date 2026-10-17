// Two small HTTP servers, no framework:
//  - startApi(): runs inside the agent (port 8788): GET /state, GET /events (SSE).
//  - main (`npm run dashboard`): long-lived dashboard server (port 8787). Serves /dashboard and relays
//    the agent's /state + /events, so the projected page survives agent restarts between demo runs.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, isMain } from "../scripts/lib/env.ts";
import { bus, state } from "./bus.ts";

const API_PORT = Number(process.env.API_PORT || 8788);
const DASH_PORT = Number(process.env.DASH_PORT || 8787);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function startApi(port = API_PORT) {
  const clients = new Set<ServerResponse>();
  let pending: NodeJS.Timeout | null = null;
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${json(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  bus.on("event", (ev) => send("log", ev));
  bus.on("state", () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; send("state", state); }, 150);
  });
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); return res.end(json(state)); }
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: state\ndata: ${json(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.statusCode = 404; res.end();
  });
  server.on("error", (e: any) => console.log(`[api] not started (${e.code}); dashboard won't see this agent`));
  server.listen(port);
  setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15_000).unref();
  return server;
}

function startDashboard() {
  const clients = new Set<ServerResponse>();
  let online = false;
  let last: string | null = null;
  const broadcast = (chunk: string) => { for (const c of clients) c.write(chunk); };

  // One upstream SSE connection to the agent; reconnects forever.
  async function upstream() {
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${API_PORT}/events`);
        if (!r.ok || !r.body) throw new Error("bad upstream");
        online = true; broadcast("event: online\ndata: {}\n\n");
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop()!;
          for (const p of parts) {
            if (p.startsWith("event: state")) last = p.slice(p.indexOf("data: ") + 6);
            broadcast(p + "\n\n");
          }
        }
      } catch {}
      if (online) { online = false; broadcast("event: offline\ndata: {}\n\n"); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  upstream();

  // --- Demo controls: the dashboard runs our existing scripts, one action at a time. ---
  let job: string | null = null;
  let agent: ChildProcess | null = null;
  let mode = (process.env.GUARD_MODE || "vault").toLowerCase();
  const status = () => ({ job, agentRunning: !!agent, mode });
  const sendStatus = () => broadcast(`event: control\ndata: ${json(status())}\n\n`);
  const sendLine = (label: string, line: string) => broadcast(`event: job\ndata: ${json({ t: Date.now(), label, line })}\n\n`);

  const spawnTs = (rel: string) => spawn(process.execPath, ["--import", "tsx", resolve(ROOT, rel)], {
    cwd: ROOT, env: { ...process.env, GUARD_MODE: mode, EXPLAIN_DELAY_MS: process.env.EXPLAIN_DELAY_MS || "15000" },
  });
  const onLines = (p: ChildProcess, fn: (line: string) => void) => {
    for (const s of [p.stdout, p.stderr]) {
      let partial = "";
      s?.on("data", (c) => {
        const lines = (partial + c.toString()).split(/\r?\n/);
        partial = lines.pop()!;
        for (const l of lines) if (l.trim()) fn(l.trimEnd());
      });
    }
  };
  const runScript = (rel: string, label: string) => new Promise<number>((res) => {
    const p = spawnTs(rel);
    onLines(p, (l) => sendLine(label, l));
    p.on("exit", (code) => res(code ?? 1));
  });
  const stopAgent = () => new Promise<void>((res) => {
    if (!agent) return res();
    agent.once("exit", () => res());
    agent.kill();
  });
  const startAgent = () => new Promise<boolean>((res) => {
    if (agent) return res(true);
    const p = spawnTs("agent/index.ts");
    agent = p;
    sendStatus();
    const timer = setTimeout(() => res(false), 60_000);
    // Agent events already reach the page via its own API; only surface arming and errors here.
    onLines(p, (l) => {
      if (/GUARD ARMED/.test(l)) { clearTimeout(timer); sendLine("agent", l); res(true); }
      else if (/ERROR|error|\[api\]/.test(l)) sendLine("agent", l);
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (agent === p) agent = null;
      sendLine("agent", `agent stopped (exit ${code ?? "killed"})`);
      sendStatus();
      res(false);
    });
  });

  const ACTIONS: Record<string, () => Promise<void>> = {
    reset: async () => { await stopAgent(); await runScript("scripts/reset.ts", "reset"); },
    arm: async () => { if (!(await startAgent())) sendLine("arm", "agent did not arm — see output above"); },
    rug: async () => {
      if (!agent) sendLine("rug", "warning: guard is not armed — GUARDED will NOT be protected");
      await runScript("scripts/rug.ts", "rug");
    },
    demo: async () => {
      await stopAgent();
      if ((await runScript("scripts/reset.ts", "reset")) !== 0) return sendLine("demo", "reset failed — stopping");
      if (!(await startAgent())) return sendLine("demo", "agent did not arm — stopping");
      await runScript("scripts/rug.ts", "rug");
      sendLine("demo", "demo finished — agent keeps running so the explanation can arrive");
    },
    stop: stopAgent,
  };

  async function control(req: IncomingMessage, res: ServerResponse, url: URL) {
    res.setHeader("Content-Type", "application/json");
    // Custom header ⇒ cross-origin pages can't trigger runs without a CORS preflight we never answer.
    if (req.method !== "POST" || req.headers["x-ejector"] !== "1") { res.statusCode = 403; return res.end(json({ error: "forbidden" })); }
    const name = url.pathname.split("/").pop()!;
    const fn = ACTIONS[name];
    if (!fn) { res.statusCode = 404; return res.end(json({ error: "unknown action" })); }
    if (job) { res.statusCode = 409; return res.end(json({ error: `busy: ${job}`, ...status() })); }
    const m = url.searchParams.get("mode");
    if (m === "vault" || m === "altana") mode = m;
    job = name;
    sendStatus();
    sendLine(name, `▶ ${name} started (mode: ${mode})`);
    res.statusCode = 202;
    res.end(json(status()));
    try { await fn(); } catch (e: any) { sendLine(name, `error: ${e.message}`); }
    finally { job = null; sendLine(name, `■ ${name} done`); sendStatus(); }
  }

  const files: Record<string, [string, string]> = {
    "/": ["dashboard/index.html", "text/html; charset=utf-8"],
    "/index.html": ["dashboard/index.html", "text/html; charset=utf-8"],
    "/app.js": ["dashboard/app.js", "text/javascript; charset=utf-8"],
  };
  createServer((req, res) => {
    const full = new URL(req.url || "/", "http://localhost");
    const url = full.pathname;
    if (url.startsWith("/api/run/")) { control(req, res, full); return; }
    if (url === "/api/status") { res.setHeader("Content-Type", "application/json"); return res.end(json(status())); }
    if (files[url]) {
      const [f, type] = files[url];
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      return res.end(readFileSync(resolve(ROOT, f)));
    }
    if (url === "/state") { res.setHeader("Content-Type", "application/json"); return res.end(last ?? json({ ...state, status: "offline" })); }
    if (url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: ${online ? "online" : "offline"}\ndata: {}\n\n`);
      res.write(`event: control\ndata: ${json(status())}\n\n`);
      if (last) res.write(`event: state\ndata: ${last}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.statusCode = 404; res.end();
  }).listen(DASH_PORT, "127.0.0.1", () => console.log(`Dashboard: http://localhost:${DASH_PORT}  (relaying agent API on :${API_PORT}; controls enabled, localhost only)`));
  setInterval(() => broadcast(": ping\n\n"), 15_000);
}

if (isMain(import.meta.url)) startDashboard();
