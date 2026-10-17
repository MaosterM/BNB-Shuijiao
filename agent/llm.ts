// Optional LLM for NON-URGENT text only (pre-flight summary, post-ejection explanation).
// Never on the trigger → sell path, never sees a key. Returns null on any failure; callers use templates.
const TIMEOUT_MS = 10_000;

export async function llm(prompt: string): Promise<string | null> {
  // 1) BNB Agent Studio / Pieverse LLM endpoint, if configured (OpenAI-compatible chat completions).
  if (process.env.STUDIO_LLM_URL && process.env.STUDIO_LLM_KEY) {
    const out = await post(process.env.STUDIO_LLM_URL, { Authorization: `Bearer ${process.env.STUDIO_LLM_KEY}` }, {
      model: process.env.STUDIO_LLM_MODEL || "default", max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }).then((j) => j?.choices?.[0]?.message?.content ?? null);
    if (out) return out.trim();
  }
  // 2) Anthropic API via LLM_API_KEY.
  if (process.env.LLM_API_KEY) {
    const out = await post("https://api.anthropic.com/v1/messages", {
      "x-api-key": process.env.LLM_API_KEY, "anthropic-version": "2023-06-01",
    }, {
      model: process.env.LLM_MODEL || "claude-haiku-5-5", max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }).then((j) => j?.content?.find?.((c: any) => c.type === "text")?.text ?? null);
    if (out) return out.trim();
  }
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Guard against invented numbers: every number in `text` must appear in `allowed`. */
export function onlyKnownNumbers(text: string, allowed: string) {
  const nums = text.match(/\d[\d,]*(\.\d+)?/g) || [];
  const pool = allowed.replace(/,/g, "");
  return nums.every((n) => pool.includes(n.replace(/,/g, "")));
}
