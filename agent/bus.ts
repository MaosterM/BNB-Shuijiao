// In-process state + event stream shared by the agent and the dashboard server.
import { EventEmitter } from "node:events";

export type AgentEvent = { t: number; type: string; msg: string; tx?: string; data?: unknown };

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const state = {
  status: "starting" as "starting" | "armed" | "ejected" | "eject_failed",
  token: "", pair: "", vault: "",
  brief: null as unknown,
  priceHistory: [] as { t: number; block: number; price: number }[],
  guarded: { startBnb: 0, nowBnb: 0, ejected: false, tx: "" },
  unguarded: { startBnb: 0, nowBnb: 0 },
  ejection: null as null | Record<string, unknown>,
  explanation: null as string | null,
  events: [] as AgentEvent[],
};

export function emit(type: string, msg: string, extra: Partial<AgentEvent> = {}) {
  const ev: AgentEvent = { t: Date.now(), type, msg, ...extra };
  state.events.push(ev);
  if (state.events.length > 200) state.events.shift();
  const time = new Date(ev.t).toLocaleTimeString("en-GB", { hour12: false });
  console.log(`[${time}] ${type.padEnd(8)} ${msg}${ev.tx ? `  https://testnet.bscscan.com/tx/${ev.tx}` : ""}`);
  bus.emit("event", ev);
}

export function changed() {
  bus.emit("state");
}
