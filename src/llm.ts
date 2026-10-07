import type { Job, Score } from "./types.ts";

/**
 * Scores a job against profile.md using your local model.
 *
 * Talks to any OpenAI-compatible chat-completions endpoint (Ollama, LM Studio, llama.cpp, vLLM...).
 * If your API has a different shape, this is the only function to change.
 */
export interface LlmOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function llmOptionsFromEnv(): LlmOptions | null {
  if ((process.env.LLM_SCORING ?? "on").toLowerCase() === "off") return null;
  return {
    baseUrl: (process.env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    model: process.env.LLM_MODEL ?? "llama3.1:8b",
    apiKey: process.env.LLM_API_KEY || undefined,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000),
  };
}

const INSTRUCTIONS = `You screen job postings for one candidate. The candidate's brief is below.
Reply with ONLY a JSON object, no prose, in exactly this shape:
{"score": <integer 0-10, how well the role fits the brief>, "locationOk": "yes" | "no" | "unknown", "reason": "<one short sentence>"}
Scoring guide: 9-10 near-perfect fit; 7-8 strong; 4-6 plausible with gaps; 0-3 wrong role, wrong stack or impossible location.
If locationOk is "no", the score must be 3 or lower.`;

export function buildMessages(profile: string, company: string, job: Job, maxDescriptionChars: number) {
  const posting = [
    `Company: ${company}`,
    `Title: ${job.title}`,
    job.location ? `Location: ${job.location}` : "Location: not stated",
    job.remote != null ? `Remote: ${job.remote ? "yes" : "no"}` : "",
    job.department ? `Department: ${job.department}` : "",
    job.description ? `Description:\n${job.description.slice(0, maxDescriptionChars)}` : "Description: (not available; judge from the title and location)",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: `${INSTRUCTIONS}\n\n--- CANDIDATE BRIEF ---\n${profile}` },
    { role: "user", content: posting },
  ];
}

export function parseScore(text: string): Score {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model reply had no JSON: ${text.slice(0, 200)}`);
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const score = Math.max(0, Math.min(10, Math.round(Number(obj.score))));
  if (!Number.isFinite(score)) throw new Error(`model reply had no numeric score: ${match[0]}`);
  const loc = String(obj.locationOk ?? obj.location_ok ?? "unknown").toLowerCase();
  return {
    score,
    locationOk: loc === "yes" || loc === "true" ? "yes" : loc === "no" || loc === "false" ? "no" : "unknown",
    reason: String(obj.reason ?? "").slice(0, 300),
  };
}

export async function scoreJob(
  opts: LlmOptions,
  profile: string,
  company: string,
  job: Job,
  maxDescriptionChars: number,
): Promise<Score> {
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: buildMessages(profile, company, job, maxDescriptionChars),
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseScore(data.choices?.[0]?.message?.content ?? "");
}

/** Quick reachability check so a down server is reported once, not once per job. */
export async function llmReachable(opts: LlmOptions): Promise<string | null> {
  try {
    const res = await fetch(`${opts.baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    });
    return res.ok || res.status === 404 ? null : `HTTP ${res.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}
