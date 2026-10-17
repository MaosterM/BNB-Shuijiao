// Ejector Seat dashboard: renders /state and follows /events (SSE) from the dashboard relay.
const $ = (id) => document.getElementById(id);
const TX = (h) => `https://testnet.bscscan.com/tx/${h}`;
const ADDR = (a) => `https://testnet.bscscan.com/address/${a}`;
let S = null, runToken = null, seen = new Set();

const chart = window.Chart ? new Chart($("chart"), {
  type: "line",
  data: { labels: [], datasets: [{ data: [], borderColor: "#f5b301", backgroundColor: "rgba(245,179,1,.12)", fill: true, tension: 0.15, pointRadius: 0, borderWidth: 3 }] },
  options: {
    animation: false, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#8b95a9", maxTicksLimit: 8, font: { size: 14 } }, grid: { color: "#1a2030" } },
      y: { beginAtZero: true, ticks: { color: "#8b95a9", font: { size: 14 } }, grid: { color: "#1a2030" } },
    },
  },
}) : null;

const fmt = (x, dp = 6) => (x ?? 0).toFixed(dp);
const time = (t) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });
const pct = (now, start) => (start ? (now / start - 1) * 100 : 0);
const chg = (el, p) => { el.textContent = `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`; el.className = `chg ${p >= 0 ? "up" : "down"}`; };

function setStatus(st) {
  const el = $("status");
  el.className = `pill ${st}`;
  el.textContent = { armed: "● GUARD ARMED", ejected: "EJECTED ✓", eject_failed: "EJECT FAILED", starting: "STARTING…", offline: "AGENT OFFLINE" }[st] || st;
}

function render(s) {
  // New agent run (new token) → clear the log/chart.
  if (s.token && s.token !== runToken) { runToken = s.token; seen = new Set(); $("log").innerHTML = ""; }
  S = s;
  setStatus(s.status);
  if (s.token) $("tokenlink").href = ADDR(s.token);

  const b = s.brief;
  if (b) {
    $("risk").textContent = `${b.risk} RISK`;
    $("risk").className = `risk ${b.risk}`;
    $("summary").textContent = b.summary;
    $("chips").innerHTML = (b.flags || []).map((f) => `<span class="chip">${f}</span>`).join("");
  }

  if (chart) {
    const h = s.priceHistory || [];
    chart.data.labels = h.map((p) => time(p.t));
    chart.data.datasets[0].data = h.map((p) => p.price * 1000);
    chart.data.datasets[0].borderColor = s.status === "ejected" ? "#ff4d5e" : "#f5b301";
    chart.update();
  }

  const g = s.guarded || {}, u = s.unguarded || {};
  $("gval").textContent = fmt(g.nowBnb); chg($("gchg"), pct(g.nowBnb, g.startBnb));
  $("uval").textContent = fmt(u.nowBnb); chg($("uchg"), pct(u.nowBnb, u.startBnb));
  const ej = g.ejected;
  $("gcard").className = `card ${ej ? "safe" : ""}`;
  $("gstatus").textContent = ej ? "EJECTED ✓ · safe in BNB" : "same 20,000 RUGME · guarded";
  $("ejectlink").innerHTML = ej && g.tx ? `<a href="${TX(g.tx)}" target="_blank" rel="noopener">eject tx ${g.tx.slice(0, 10)}…</a>${s.ejection ? ` · ${s.ejection.latencyMs} ms after trigger block` : ""}` : "";
  $("ucard").className = `card ${pct(u.nowBnb, u.startBnb) < -50 ? "rekt" : ""}`;

  if (s.explanation) { $("explain").style.display = "block"; $("explain").textContent = s.explanation; }
  else $("explain").style.display = "none";

  for (const ev of s.events || []) addLog(ev);
}

function addLog(ev) {
  const key = `${ev.t}|${ev.type}|${ev.msg}`;
  if (seen.has(key)) return;
  seen.add(key);
  const row = document.createElement("div");
  row.innerHTML = `<span class="t">${time(ev.t)}</span><span class="ty-${ev.type}">${ev.type}</span><span></span>`;
  row.lastChild.textContent = ev.msg + " ";
  if (ev.tx) { const a = document.createElement("a"); a.href = TX(ev.tx); a.target = "_blank"; a.rel = "noopener"; a.textContent = "tx↗"; row.lastChild.appendChild(a); }
  const log = $("log");
  log.prepend(row);
}

// --- Demo controls ---
let ctl = { job: null, agentRunning: false, mode: "vault" };
const buttons = [...document.querySelectorAll("[data-action]")];
function renderControls(c) {
  ctl = c;
  const busy = !!c.job;
  for (const b of buttons) {
    const a = b.dataset.action;
    b.disabled = busy || (a === "arm" && c.agentRunning) || (a === "stop" && !c.agentRunning);
  }
  $("mode").value = c.mode;
  $("mode").disabled = busy;
  const js = $("jobstatus");
  js.textContent = busy ? `running: ${c.job}…` : c.agentRunning ? "idle · agent running" : "idle";
  js.className = `jobstatus ${busy ? "busy" : ""}`;
}
for (const b of buttons) b.addEventListener("click", async () => {
  const a = b.dataset.action;
  if (a === "demo" || a === "reset") { $("console").innerHTML = ""; }
  const r = await fetch(`/api/run/${a}?mode=${$("mode").value}`, { method: "POST", headers: { "X-Ejector": "1" } }).catch(() => null);
  if (!r) return consoleLine("ui", "dashboard server unreachable");
  if (r.status === 409) consoleLine("ui", "another action is still running");
});
const linkify = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
  .replace(/https:\/\/testnet\.bscscan\.com\/(tx|address)\/(0x[0-9a-fA-F]+)/g, (u, k, h) => `<a href="${u}" target="_blank" rel="noopener">${k} ${h.slice(0, 10)}…↗</a>`);
function consoleLine(label, line) {
  const box = $("console");
  box.querySelector(".muted")?.remove();
  const row = document.createElement("div");
  row.innerHTML = `<span class="lbl">${label}│</span> ${linkify(line)}`;
  box.appendChild(row);
  while (box.children.length > 300) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

fetch("/api/status").then((r) => r.json()).then(renderControls).catch(() => {});
fetch("/state").then((r) => r.json()).then(render).catch(() => {});
const es = new EventSource("/events");
es.addEventListener("state", (e) => render(JSON.parse(e.data)));
es.addEventListener("log", (e) => addLog(JSON.parse(e.data)));
es.addEventListener("offline", () => setStatus("offline"));
es.addEventListener("control", (e) => renderControls(JSON.parse(e.data)));
es.addEventListener("job", (e) => { const j = JSON.parse(e.data); consoleLine(j.label, j.line); });
es.addEventListener("online", () => fetch("/state").then((r) => r.json()).then(render).catch(() => {}));
