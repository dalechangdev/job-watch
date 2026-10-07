# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal daily script that checks company job boards for postings not seen before, drops irrelevant titles, has a local LLM score the rest against `profile.md`, and writes a markdown report. No browser, database or server. See `README.md` for user-facing setup and behaviour.

## Commands

```sh
npm run check                         # full run (hits real job boards and the local model)
npm run check -- --dry-run            # don't write data/seen.json; also suppresses notifications
npm run check -- --only enode         # only companies whose name contains "enode"
npm run check -- --include-existing   # also score jobs at companies being baselined
npm run discover                      # find boards for `ats: unknown` companies; rewrites companies.yaml
npm run discover -- --dry-run         # print findings without editing companies.yaml
npm test                              # unit + e2e, no network needed
npm run typecheck                     # tsc, noEmit
```

Single test file or test: `npx tsx --test test/units.test.ts`, or add `--test-name-pattern "workday"`.

There is no build step and no linter. TypeScript runs directly through `tsx`; imports use explicit `.ts` extensions (`allowImportingTsExtensions`), ESM only, Node >= 20.12.

When experimenting with `check`, use `--dry-run`. A normal run records every fetched job in `data/seen.json`, so those jobs will never be reported as new again.

## Architecture

`src/check.ts` is the pipeline, and each stage is one module:

1. **Fetch** — `adapters.ts`. One `Fetcher` per hiring platform, each normalising to the `Job` shape in `types.ts`. `fetchJobs()` dispatches through the `ADAPTERS` registry keyed by `Company.ats`. A failing company is caught per-company and lands in the report's errors section; it never aborts the run.
2. **Diff** — `state.ts`. `diffAndRecord()` mutates the in-memory `SeenState` (company name → job id → first/last seen) and returns unseen jobs. A company with no prior entry is a **baseline**: everything is recorded and nothing reported. Vanished jobs are kept for 45 days so a flaky board doesn't resurface old postings as new.
3. **Filter** — `filter.ts`. Case-insensitive regexes from `config.yaml`; a title must match one `titleInclude` and no `titleExclude`.
4. **Score** — `llm.ts`. OpenAI-compatible `/chat/completions`, with `profile.md` as the system-prompt brief. `parseScore()` is deliberately lenient about chatty replies. If the model is unreachable (`llmReachable`, checked once), jobs are reported unscored rather than dropped.
5. **Report / notify** — `report.ts` renders `reports/<date>.md` and `reports/latest.md`; `notify.ts` sends macOS/ntfy/Slack notifications.

`src/discover.ts` is a separate entry point that fills in `ats`/`slug`/`url` in `companies.yaml`. It first scans the company's own site for known platform links or embeds (`detect.ts`), then falls back to probing guessed slugs against each platform, marking those results `verify: true` because a guessed slug can belong to a different company with the same name.

### Things that span files

- **Adding a hiring platform** touches four places: `ATS_TYPES` in `types.ts`, a `Fetcher` plus `ADAPTERS` entry and `boardUrl()` case in `adapters.ts`, a detection pattern in `detectAts()` in `detect.ts`, and a `PROBES` entry in `discover.ts`. Document it in the header comment of `companies.yaml` too.
- **Job identity is `(company name, job.id)`.** Renaming a company in `companies.yaml`, or changing how an adapter derives `id`, makes every job at that company look new (or re-baselines it).
- **`JOB_WATCH_HOME`** overrides the root for all user files (`config.ts` `paths`). The e2e tests rely on this to run the real CLIs against a temp directory.
- **`saveCompanies()`** edits the YAML document in place to preserve the file's comments and ordering, and only writes the board fields (`ats`, `slug`, `url`, `linkPattern`, `verify`). Keep it that way; the comments are section headers the user maintains by hand.
- All outbound HTTP to job boards goes through `http()` in `util.ts` (timeout, identifying user agent, one retry on 429/5xx). Keep request volume at roughly one request per company per run.
- Progress logging goes to stderr; stdout carries only the report.

## Tests

- `test/units.test.ts` swaps `globalThis.fetch` with `mockFetch(routes)`, which matches canned bodies by URL substring. New adapters should be tested this way with a fixture shaped like the platform's real response.
- `test/e2e.test.ts` starts a local HTTP server acting as both a careers site and a fake OpenAI-compatible model, then spawns `check` and `discover` via `tsx` in a temp workspace.

## User data files

`companies.yaml`, `profile.md` and `config.yaml` are the user's own hand-edited content rather than fixtures, so don't reformat or reorder them. `.env`, `data/` and `reports/` are gitignored. `profile.md` is sent verbatim to the model, so edits to it change scoring.
