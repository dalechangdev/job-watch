import type { Company, Config, ScoredJob } from "./types.ts";

export interface RunSummary {
  date: string;
  checked: number;
  baselined: string[];
  newTotal: number;
  titleFiltered: number;
  scored: ScoredJob[];
  unscored: ScoredJob[];
  scoringError?: string;
  errors: { company: string; message: string }[];
  manual: Company[];
  unknown: Company[];
}

const esc = (s: string) => s.replace(/([[\]|])/g, "\\$1");

function posted(j: ScoredJob): string {
  if (!j.postedAt) return "";
  const d = Date.parse(j.postedAt);
  return Number.isNaN(d) ? ` · ${j.postedAt}` : ` · posted ${new Date(d).toISOString().slice(0, 10)}`;
}

function line(j: ScoredJob): string {
  const head = `- **[${esc(j.title)}](${j.url})** — ${esc(j.company)}${j.location ? ` · ${esc(j.location)}` : ""}${posted(j)}`;
  if (!j.score) return head;
  const loc = j.score.locationOk === "no" ? " ⚠ location" : j.score.locationOk === "unknown" ? " · location unclear" : "";
  return `${head}\n  - **${j.score.score}/10**${loc} — ${j.score.reason}`;
}

export function splitByScore(s: RunSummary, cfg: Pick<Config, "strongScore" | "maybeScore">) {
  const byScore = [...s.scored].sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0));
  return {
    strong: byScore.filter((j) => (j.score?.score ?? 0) >= cfg.strongScore),
    maybe: byScore.filter((j) => {
      const v = j.score?.score ?? 0;
      return v >= cfg.maybeScore && v < cfg.strongScore;
    }),
    low: byScore.filter((j) => (j.score?.score ?? 0) < cfg.maybeScore),
  };
}

export function renderReport(s: RunSummary, cfg: Pick<Config, "strongScore" | "maybeScore">): string {
  const { strong, maybe, low } = splitByScore(s, cfg);
  const out: string[] = [`# New jobs — ${s.date}`, ""];
  out.push(
    `Checked ${s.checked} companies · ${s.newTotal} new postings · ${s.titleFiltered} passed the title filter` +
      (s.scored.length ? ` · ${strong.length} strong, ${maybe.length} maybe` : ""),
    "",
  );

  if (strong.length) out.push("## Strong matches", "", ...strong.map(line), "");
  if (maybe.length) out.push("## Maybe", "", ...maybe.map(line), "");
  if (s.unscored.length) {
    out.push("## New (not scored)", "");
    if (s.scoringError) out.push(`> Local model unavailable: ${s.scoringError}`, "");
    out.push(...s.unscored.map(line), "");
  }
  if (!strong.length && !maybe.length && !s.unscored.length) out.push("_Nothing new worth a look._", "");
  if (low.length) {
    out.push(`<details><summary>${low.length} low-scoring new postings</summary>`, "", ...low.map(line), "", "</details>", "");
  }

  if (s.baselined.length) {
    out.push(
      "## First check",
      "",
      `These were checked for the first time. Their current jobs were recorded but not reported; ` +
        `only jobs posted from now on will show up: ${s.baselined.join(", ")}.`,
      "",
    );
  }
  if (s.errors.length) {
    out.push("## Couldn't check", "", ...s.errors.map((e) => `- **${e.company}** — ${e.message}`), "");
  }
  if (s.manual.length) {
    out.push("## Check by hand", "", ...s.manual.map((c) => `- [${c.name}](${c.url ?? c.careersUrl ?? c.website})`), "");
  }
  if (s.unknown.length) {
    out.push(
      "## Job board not found yet",
      "",
      `Run \`npm run discover\`, or set \`ats\` by hand in companies.yaml: ${s.unknown.map((c) => c.name).join(", ")}.`,
      "",
    );
  }
  return out.join("\n");
}

/** One-line summary for notifications. */
export function headline(s: RunSummary, cfg: Pick<Config, "strongScore" | "maybeScore">): string | null {
  const { strong, maybe } = splitByScore(s, cfg);
  const parts: string[] = [];
  if (strong.length) parts.push(`${strong.length} strong`);
  if (maybe.length) parts.push(`${maybe.length} maybe`);
  if (s.unscored.length) parts.push(`${s.unscored.length} unscored`);
  if (!parts.length) return null;
  const top = strong[0] ?? maybe[0] ?? s.unscored[0];
  return `New jobs: ${parts.join(", ")}${top ? ` — top: ${top.title} @ ${top.company}` : ""}`;
}
