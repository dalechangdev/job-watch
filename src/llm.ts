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

async function chat(opts: LlmOptions, messages: { role: string; content: string }[]): Promise<string> {
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
      messages,
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function scoreJob(
  opts: LlmOptions,
  profile: string,
  company: string,
  job: Job,
  maxDescriptionChars: number,
): Promise<Score> {
  return parseScore(await chat(opts, buildMessages(profile, company, job, maxDescriptionChars)));
}

const EXTRACT_INSTRUCTIONS = `You read the text of a company's careers page and list the jobs that are open right now.
Reply with ONLY a JSON object, no prose, in exactly this shape:
{"jobs": ["<job title copied exactly as written on the page>", ...]}
Only include specific roles someone can apply for today. Leave out closed or past vacancies, open/speculative
applications, team or department names, benefits, and menu items. If there are none, reply {"jobs": []}.`;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Reads the model's list of job titles, keeping only the ones that really appear in the page text,
 * so a model that invents a title can't create a job.
 */
export function parseTitles(reply: string, pageText: string): string[] {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model reply had no JSON: ${reply.slice(0, 200)}`);
  const obj = JSON.parse(match[0]) as { jobs?: unknown };
  if (!Array.isArray(obj.jobs)) throw new Error(`model reply had no "jobs" list: ${match[0].slice(0, 200)}`);
  const hay = squash(pageText);
  const out = new Map<string, string>();
  for (const j of obj.jobs) {
    const title = String((j as { title?: unknown })?.title ?? j).replace(/\s+/g, " ").trim();
    if (title.length < 3 || title.length > 150 || !hay.includes(squash(title))) continue;
    if (!out.has(squash(title))) out.set(squash(title), title);
  }
  return [...out.values()];
}

// Careers pages are fetched several at a time, but a local model is happiest with one request at a time.
let extractQueue: Promise<unknown> = Promise.resolve();

/** Asks the local model which jobs a careers page lists. For pages with no feed and no usable links. */
export function extractJobTitles(opts: LlmOptions, company: string, pageText: string): Promise<string[]> {
  const run = async () =>
    parseTitles(
      await chat(opts, [
        { role: "system", content: EXTRACT_INSTRUCTIONS },
        { role: "user", content: `Company: ${company}\n\n--- PAGE TEXT ---\n${pageText}` },
      ]),
      pageText,
    );
  const next = extractQueue.then(run, run);
  extractQueue = next.catch(() => {});
  return next;
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
