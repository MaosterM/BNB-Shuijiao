// Post-ejection explanation. Numbers are computed here; the LLM may only rephrase.
import { llm, onlyKnownNumbers } from "./llm.ts";

export type ExplainInput = {
  ejectedAt: number;          // ms
  reason: string;             // trigger detail
  bnbOut: number;             // what the vault received
  priceAtArm: number;         // BNB per RUGME when the guard armed
  priceNow: number;           // BNB per RUGME ~60s later
  holdValueNow: number;       // what the same tokens would fetch now
};

export async function explain(x: ExplainInput) {
  const time = new Date(x.ejectedAt).toLocaleTimeString("en-GB", { hour12: false });
  const down = x.priceAtArm ? (1 - x.priceNow / x.priceAtArm) * 100 : 0;
  const saved = Math.max(0, x.bnbOut - x.holdValueNow);
  const template =
    `Ejected at ${time} because ${x.reason}. You received ${x.bnbOut.toFixed(6)} BNB. ` +
    `RUGME is now down ${down.toFixed(1)}%; had you held, your tokens would fetch ${x.holdValueNow.toFixed(6)} BNB — ` +
    `Ejector Seat saved you ~${saved.toFixed(6)} BNB.`;
  const out = await llm(
    `Rewrite this message for a non-technical crypto user in at most 3 short sentences. Keep every number exactly as written, ` +
    `add no new numbers, no markdown:\n${template}`,
  );
  return out && onlyKnownNumbers(out, template) ? out : template;
}
