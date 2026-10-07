/**
 * Daily check: fetch every company's job board, find postings not seen before,
 * score the relevant ones with the local model, write a report and notify.
 *
 *   npm run check                      normal run
 *   npm run check -- --dry-run         don't update data/seen.json (safe for experimenting)
 *   npm run check -- --only enode      just companies whose name contains "enode"
 *   npm run check -- --include-existing  also score jobs at companies checked for the first time
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchJobs } from "./adapters.ts";
import { loadCompanies, loadConfig, loadEnv, loadProfile, paths } from "./config.ts";
import { makeTitleFilter } from "./filter.ts";
import { llmOptionsFromEnv, llmReachable, scoreJob } from "./llm.ts";
import { notify } from "./notify.ts";
import { headline, renderReport, type RunSummary } from "./report.ts";
import { diffAndRecord, loadSeen, saveSeen } from "./state.ts";
import type { Job, ScoredJob } from "./types.ts";
import { pMap, today } from "./util.ts";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
    "include-existing": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

const log = (...m: unknown[]) => console.error(...m);

async function main() {
  loadEnv();
  const cfg = loadConfig();
  const profile = loadProfile();
  const seen = loadSeen(paths.seen);
  const only = args.only?.toLowerCase();
  const companies = loadCompanies().filter(
    (c) => c.enabled !== false && (!only || c.name.toLowerCase().includes(only)),
  );

  const manual = companies.filter((c) => c.ats === "manual");
  const unknown = companies.filter((c) => c.ats === "unknown");
  const fetchable = companies.filter((c) => c.ats !== "manual" && c.ats !== "unknown");
  log(`Checking ${fetchable.length} companies (${unknown.length} without a known job board, ${manual.length} manual)…`);

  const results = await pMap(fetchable, cfg.concurrency, async (c) => {
    try {
      const jobs = await fetchJobs(c);
      log(`  ✓ ${c.name}: ${jobs.length} jobs`);
      return { company: c, jobs };
    } catch (e) {
      const message = (e as Error).message;
      log(`  ✗ ${c.name}: ${message}`);
      return { company: c, error: message };
    }
  });

  const summary: RunSummary = {
    date: today(),
    checked: fetchable.length,
    baselined: [],
    newTotal: 0,
    titleFiltered: 0,
    scored: [],
    unscored: [],
    errors: [],
    manual,
    unknown,
  };

  const keep = makeTitleFilter(cfg);
  const candidates: ScoredJob[] = [];
  for (const r of results) {
    if ("error" in r) {
      summary.errors.push({ company: r.company.name, message: r.error ?? "unknown error" });
      continue;
    }
    const { baseline, fresh } = diffAndRecord(seen, r.company.name, r.jobs);
    let newJobs: Job[] = fresh;
    if (baseline) {
      summary.baselined.push(r.company.name);
      if (args["include-existing"]) newJobs = r.jobs;
    }
    summary.newTotal += newJobs.length;
    for (const j of newJobs) if (keep(j)) candidates.push({ ...j, company: r.company.name });
  }
  summary.titleFiltered = candidates.length;

  const llm = llmOptionsFromEnv();
  if (candidates.length && llm) {
    const down = await llmReachable(llm);
    if (down) {
      summary.scoringError = `${llm.baseUrl} (${down})`;
      summary.unscored = candidates;
      log(`Local model not reachable at ${llm.baseUrl}: ${down}. Reporting jobs unscored.`);
    } else {
      log(`Scoring ${candidates.length} jobs with ${llm.model}…`);
      const llmConcurrency = Number(process.env.LLM_CONCURRENCY ?? 1);
      await pMap(candidates, llmConcurrency, async (j) => {
        try {
          j.score = await scoreJob(llm, profile, j.company, j, cfg.maxDescriptionChars);
          summary.scored.push(j);
        } catch (e) {
          log(`  scoring failed for ${j.title} @ ${j.company}: ${(e as Error).message}`);
          summary.unscored.push(j);
        }
      });
    }
  } else {
    summary.unscored = candidates;
  }

  const report = renderReport(summary, cfg);
  mkdirSync(paths.reports, { recursive: true });
  let reportPath = join(paths.reports, `${summary.date}.md`);
  if (existsSync(reportPath)) {
    reportPath = join(paths.reports, `${summary.date}-${new Date().toTimeString().slice(0, 5).replace(":", "")}.md`);
  }
  writeFileSync(reportPath, report);
  writeFileSync(join(paths.reports, "latest.md"), report);

  if (args["dry-run"]) log("Dry run: data/seen.json not updated.");
  else saveSeen(paths.seen, seen);

  const head = headline(summary, cfg);
  if (head && !args.quiet && !args["dry-run"]) await notify("job-watch", head, reportPath);

  console.log(report);
  log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
