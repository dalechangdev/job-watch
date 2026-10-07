# job-watch

A daily check of a list of company job boards. It finds postings that weren't there last time, drops obviously
irrelevant titles, has **your local model** score the rest against `profile.md`, and writes a short report.

There's no browser, database or server. It's a TypeScript script plus four files you edit:

| File | What it is |
|---|---|
| `companies.yaml` | The companies, and which job platform each uses |
| `profile.md` | What you're looking for, in plain English, which is the model's scoring brief |
| `config.yaml` | Title include/exclude filters and score thresholds |
| `.env` | Local model URL and name, and optional phone/Slack notifications |

## How it works

1. **Fetch.** Most company careers pages are hosted by a hiring platform with a public JSON feed: Greenhouse,
   Lever, Ashby, Workable, Recruitee, Personio, Teamtailor, SmartRecruiters, BambooHR or Workday. One request
   per company returns every open job. Sites on other platforms can use `ats: html`, which reads job links
   from a plain careers page.
2. **Diff.** `data/seen.json` remembers every job ID. Anything not in it is new. This is more reliable than
   posting dates, which are often missing or reset, and a missed day is caught up on the next run. **The
   first time a company is checked, its current jobs are recorded but not reported.**
3. **Filter.** New jobs whose titles don't match `config.yaml` (e.g. "Sales", "Electrical Engineer") are
   dropped before the model sees them.
4. **Score.** Each remaining job goes to your local model with `profile.md`. The model returns a 0–10 score,
   whether the location works for you, and a one-line reason.
5. **Report.** `reports/YYYY-MM-DD.md` (also `reports/latest.md`) lists strong matches, then maybes, then
   companies that couldn't be checked. If anything scored well you also get a macOS notification, plus
   ntfy/Slack if configured.

## Setup

```sh
cd ~/projects/job-watch
npm install
cp .env.example .env        # set LLM_BASE_URL and LLM_MODEL for your local API
npm run discover            # finds each company's job board, fills in companies.yaml (a few minutes)
npm run check               # first run: records current jobs, reports nothing new
```

Then look at `reports/discover-<date>.md`:

- **"guessed from name — please verify"** (`verify: true` in companies.yaml): the board was found by guessing a
  slug, so it may belong to a different company with the same name (likely for short names like Mill, Arch,
  AMP or Paces). Open the board link, and if it's right, delete the `verify` line. If it's wrong, set `ats: unknown`.
- **not found**: open the company's careers page and click a job. The address usually shows the platform.
  Fill in `ats` and `slug` by hand, use `ats: html` with `url:` pointing at the careers page, or use
  `ats: manual` to just list the company in each report as "check by hand".

## Local model

Any server with an OpenAI-compatible `POST /v1/chat/completions` works, such as Ollama, LM Studio, llama.cpp's
`llama-server`, vLLM or LocalAI. Set `LLM_BASE_URL` (including `/v1`) and `LLM_MODEL` in `.env`. If your
API has a different request shape, change only `scoreJob()` in `src/llm.ts`.

- If the model isn't running, the check still works: new title-matched jobs are listed as "not scored".
- `LLM_SCORING=off` skips scoring entirely.
- `LLM_CONCURRENCY` (default 1) lets you score several jobs in parallel if your server handles it.
- A 7–8B instruct model is enough for this. Only new postings are scored, which is usually a handful per day.

## Daily schedule

```sh
./scripts/schedule.sh install 08:30   # launchd job; if the Mac is asleep at 08:30, it runs on wake
./scripts/schedule.sh status
./scripts/schedule.sh uninstall
```

This runs on your Mac rather than in the cloud because it needs to reach your local model. Make sure the
model server is running at that time. Ollama's menu-bar app starts at login, for example.

## Commands

| | |
|---|---|
| `npm run check` | Normal run |
| `npm run check -- --only enode` | Only companies whose name contains "enode" |
| `npm run check -- --dry-run` | Don't update `data/seen.json` (safe for trying things) |
| `npm run check -- --include-existing` | Also score current jobs at companies being checked for the first time |
| `npm run discover` | Find boards for every `ats: unknown` company |
| `npm run discover -- --only mill` | Re-run discovery for matching companies, whatever their current `ats` |
| `npm test` | Unit and end-to-end tests (no network needed) |

To pause a company, add `enabled: false`. To add one, append `- name: … / website: …` and run `npm run discover`.

## Limits

- Pages built entirely in the browser (Notion, some custom React sites) can't be read with `ats: html`. Use
  `ats: manual`.
- Workday only gives text dates ("Posted Today") and no description, so those jobs are scored on title and
  location.
- It sends one request per company per day, with a clear user agent. Keep it that way.
