/**
 * Finds each company's job board and fills in `ats` / `slug` / `url` in companies.yaml.
 *
 *   npm run discover                 companies with ats: unknown
 *   npm run discover -- --only mill  just matching companies (any ats)
 *   npm run discover -- --dry-run    print findings, don't edit companies.yaml
 *
 * Step 1 reads the company's own website and careers pages, looking for links or embeds from known
 * hiring platforms (reliable). Step 2, only if that fails, guesses slugs from the company name and asks
 * each platform whether that board exists (can hit a different company with the same name, so those
 * results are marked `verify: true`).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { boardUrl, fetchJobs } from "./adapters.ts";
import { loadCompanies, loadEnv, paths, saveCompanies } from "./config.ts";
import { detectAts, type Found } from "./detect.ts";
import type { Company } from "./types.ts";
import { http, pMap, slugify, today } from "./util.ts";

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await http(url, { headers: { accept: "text/html" } }, 0);
    if (!res.ok) return null;
    return { html: await res.text(), finalUrl: res.url };
  } catch {
    return null;
  }
}

const CAREER_LINK = /career|jobs?\b|join|hiring|vacanc|work-with-us|empleo|trabaja|karriere|stellen|ura|carreira/i;

async function scanWebsite(c: Company): Promise<{ found: Found; via: string } | null> {
  const starts = [c.careersUrl, c.url, c.website].filter(Boolean) as string[];
  if (!starts.length) return null;
  const origin = new URL(c.website ?? starts[0] as string).origin;
  const queue = [
    ...starts,
    ...["/careers", "/jobs", "/careers/", "/about/careers", "/company/careers", "/join-us", "/en/careers", "/work-with-us"].map(
      (p) => origin + p,
    ),
  ];
  const visited = new Set<string>();
  let followed = 0;
  while (queue.length && visited.size < 14) {
    const url = queue.shift() as string;
    if (visited.has(url)) continue;
    visited.add(url);
    const page = await fetchPage(url);
    if (!page) continue;
    const found = detectAts(page.html, page.finalUrl);
    if (found) return { found, via: url };
    // Follow up to 4 career-looking links found on the pages we read.
    for (const m of page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      if (followed >= 4) break;
      const href = m[1] as string;
      if (!CAREER_LINK.test(href) && !CAREER_LINK.test(m[2] as string)) continue;
      try {
        const abs = new URL(href, page.finalUrl).href;
        if (!visited.has(abs) && !queue.includes(abs)) {
          queue.unshift(abs);
          followed++;
        }
      } catch {}
    }
  }
  return null;
}

function slugCandidates(c: Company): string[] {
  const base = slugify(c.name);
  const out = [base.replace(/-/g, ""), base];
  const trimmed = base.replace(/-(energy|solar|solutions|systems|technologies|technology|inc|ltd|gmbh|sl|sa|wind|ai|co)$/g, "");
  out.push(trimmed.replace(/-/g, ""), trimmed);
  if (c.website) {
    const host = new URL(c.website).hostname.replace(/^www\./, "");
    out.push(host.split(".")[0] as string);
  }
  return [...new Set(out)].filter((s) => s.length >= 3);
}

type Probe = (slug: string) => Promise<boolean>;
const json = async (url: string) => {
  const res = await http(url, { headers: { accept: "application/json" } }, 0);
  return res.ok ? ((await res.json()) as Record<string, any>) : null;
};
const text = async (url: string) => {
  const res = await http(url, {}, 0);
  return res.ok ? await res.text() : null;
};
const PROBES: [Company["ats"], Probe][] = [
  ["greenhouse", async (s) => Array.isArray((await json(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`))?.jobs)],
  ["ashby", async (s) => Array.isArray((await json(`https://api.ashbyhq.com/posting-api/job-board/${s}`))?.jobs)],
  ["lever", async (s) => Array.isArray(await json(`https://api.lever.co/v0/postings/${s}?mode=json`))],
  ["lever-eu", async (s) => Array.isArray(await json(`https://api.eu.lever.co/v0/postings/${s}?mode=json`))],
  ["workable", async (s) => Array.isArray((await json(`https://apply.workable.com/api/v1/widget/accounts/${s}`))?.jobs)],
  ["personio", async (s) => (await text(`https://${s}.jobs.personio.de/xml`))?.includes("<workzag-jobs") ?? false],
  ["recruitee", async (s) => Array.isArray((await json(`https://${s}.recruitee.com/api/offers/`))?.offers)],
  ["teamtailor", async (s) => (await text(`https://${s}.teamtailor.com/jobs.rss`))?.includes("<rss") ?? false],
  ["bamboohr", async (s) => Array.isArray((await json(`https://${s}.bamboohr.com/careers/list`))?.result)],
  // SmartRecruiters answers for any id, so only count it when there are postings.
  ["smartrecruiters", async (s) => ((await json(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`))?.totalFound ?? 0) > 0],
];

async function probeSlugs(c: Company): Promise<Found | null> {
  for (const slug of slugCandidates(c)) {
    for (const [ats, probe] of PROBES) {
      try {
        if (await probe(slug)) return { ats, slug };
      } catch {}
    }
  }
  return null;
}

interface Row {
  name: string;
  result: string;
  board?: string;
  jobs?: number;
  how?: string;
}

async function main() {
  loadEnv();
  const { values: args } = parseArgs({
    options: { only: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  const only = args.only?.toLowerCase();
  const companies = loadCompanies();
  const targets = companies.filter((c) => (only ? c.name.toLowerCase().includes(only) : c.ats === "unknown"));
  console.error(`Looking for job boards for ${targets.length} companies (this can take a few minutes)…`);

  const rows = await pMap(targets, 4, async (c): Promise<Row> => {
    const scanned = await scanWebsite(c);
    let found = scanned?.found ?? null;
    let how = scanned ? `linked from ${scanned.via}` : "";
    if (!found) {
      found = await probeSlugs(c);
      how = found ? "guessed from name — please verify" : "";
    }
    if (!found) {
      console.error(`  ? ${c.name}: not found`);
      return { name: c.name, result: "not found" };
    }
    delete c.slug;
    delete c.url;
    delete c.linkPattern;
    delete c.verify;
    Object.assign(c, found);
    if (!scanned) c.verify = true;
    let jobs: number | undefined;
    try {
      jobs = (await fetchJobs(c)).length;
    } catch {}
    console.error(`  ✓ ${c.name}: ${c.ats} ${c.slug ?? c.url}${c.verify ? " (verify)" : ""}`);
    return { name: c.name, result: c.ats, board: boardUrl(c), jobs, how };
  });

  if (!args["dry-run"]) saveCompanies(companies);

  const lines = [
    `# Job board discovery — ${today()}`,
    "",
    "| Company | Platform | Board | Open jobs | How found |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.result} | ${r.board ? `[link](${r.board})` : ""} | ${r.jobs ?? ""} | ${r.how ?? ""} |`),
    "",
    "Not found? Open the company's careers page, click a job, and look at the address bar: the platform is usually",
    "obvious (greenhouse.io, lever.co, ashbyhq.com, workable.com, personio, teamtailor, myworkdayjobs.com...).",
    "Set `ats` and `slug`/`url` by hand, or use `ats: html` with the careers page `url`, or `ats: manual`.",
  ];
  mkdirSync(paths.reports, { recursive: true });
  const out = join(paths.reports, `discover-${today()}.md`);
  writeFileSync(out, lines.join("\n"));
  console.log(lines.join("\n"));
  console.error(`\n${args["dry-run"] ? "Dry run: companies.yaml not changed." : "Updated companies.yaml."} Summary: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
