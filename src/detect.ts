import { extractJobs, pageText } from "./adapters.ts";
import type { Company } from "./types.ts";

export type Found = Pick<Company, "ats" | "slug" | "url" | "linkPattern">;

const BAD_SLUGS = new Set(["embed", "api", "j", "www", "app", "assets", "careers", "jobs", "static", "cdn", "tt"]);
const ok = (slug: string | undefined) => !!slug && !BAD_SLUGS.has(slug.toLowerCase());

/** Looks for a known hiring platform in a page's HTML (and the URL it ended up at). */
export function detectAts(html: string, finalUrl = ""): Found | null {
  const hay = `${finalUrl}\n${html}`;
  let m: RegExpMatchArray | null;

  if ((m = hay.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([\w-]+)/i)) && ok(m[1]))
    return { ats: "greenhouse", slug: m[1] };
  if ((m = hay.match(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/i)) && ok(m[1]))
    return { ats: "greenhouse", slug: m[1] };
  if ((m = hay.match(/jobs\.eu\.lever\.co\/([\w-]+)/i)) && ok(m[1])) return { ats: "lever-eu", slug: m[1] };
  if ((m = hay.match(/jobs\.lever\.co\/([\w-]+)/i)) && ok(m[1])) return { ats: "lever", slug: m[1] };
  if ((m = hay.match(/jobs\.ashbyhq\.com\/([\w.%-]+)/i)) && ok(m[1]))
    return { ats: "ashby", slug: decodeURIComponent(m[1] as string) };
  if ((m = hay.match(/organizationHostedJobsPageName=([\w.%-]+)/i)) && ok(m[1]))
    return { ats: "ashby", slug: decodeURIComponent(m[1] as string) };
  if ((m = hay.match(/apply\.workable\.com\/([\w-]+)/i)) && ok(m[1])) return { ats: "workable", slug: m[1] };
  if ((m = hay.match(/\/\/([\w-]+)\.workable\.com/i)) && ok(m[1]) && m[1] !== "apply") return { ats: "workable", slug: m[1] };
  if ((m = hay.match(/\/\/([\w-]+)\.recruitee\.com/i)) && ok(m[1])) return { ats: "recruitee", slug: m[1] };
  if ((m = hay.match(/\/\/([\w-]+)\.jobs\.personio\.(?:de|com)/i)) && ok(m[1])) return { ats: "personio", slug: m[1] };
  if ((m = hay.match(/(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i)) && ok(m[1]))
    return { ats: "smartrecruiters", slug: m[1] };
  if ((m = hay.match(/\/\/([\w-]+)\.bamboohr\.com/i)) && ok(m[1])) return { ats: "bamboohr", slug: m[1] };
  if ((m = hay.match(/ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)\/jobs/i)) && ok(m[1])) return { ats: "rippling", slug: m[1] };
  if ((m = hay.match(/jobs\.gem\.com\/([\w-]+)(?![\w.-])/i)) && ok(m[1])) return { ats: "gem", slug: m[1] };
  if ((m = hay.match(/\/\/([\w-]+)\.breezy\.hr/i)) && ok(m[1])) return { ats: "breezy", slug: m[1] };
  if ((m = hay.match(/https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?[\w-]+/)))
    return { ats: "workday", url: m[0] };
  if ((m = hay.match(/\/\/([\w-]+)\.teamtailor\.com/i)) && ok(m[1])) return { ats: "teamtailor", slug: m[1] };
  if (/teamtailor-cdn\.com/i.test(html) && finalUrl) {
    return { ats: "teamtailor", url: `${new URL(finalUrl).origin}/jobs.rss` };
  }
  if ((m = hay.match(/https?:\/\/([\w-]+)\.factorialhr\.com/i)) && ok(m[1]))
    return { ats: "html", url: `https://${m[1]}.factorialhr.com`, linkPattern: "/job_posting/" };
  if ((m = hay.match(/join\.com\/companies\/([\w-]+)/i)) && ok(m[1]))
    return { ats: "html", url: `https://join.com/companies/${m[1]}`, linkPattern: `/companies/${m[1]}/\\d+` };
  return null;
}


/** A page that discovery read: the address it ended up at, and its HTML. */
export interface Page {
  url: string;
  html: string;
}

const CAREER_PATH = /career|\bjobs?\b|join|hiring|vacanc|work-?with-?us|open-?(positions|roles)|empleo|trabaja|karriere|stellen|carreira/i;
const bare = (host: string) => host.replace(/^www\./, "");

/**
 * For a company on no known platform: its own careers page, if the scan read one.
 * Prefers a page `ats: html` can read; otherwise any careers page with real text, for `ats: page`.
 */
export function ownCareersPage(c: Company, pages: Page[]): { found: Found; how: string } | null {
  if (!pages.length) return null;
  const site = bare(new URL(c.website ?? (pages[0] as Page).url).hostname);
  const home = c.website ? pages.find((p) => new URL(p.url).pathname === "/") : undefined;
  const careers = pages.filter((p) => {
    const u = new URL(p.url);
    const host = bare(u.hostname);
    if (host !== site && !host.endsWith(`.${site}`)) return false;
    // A site that answers every address with the same shell has no careers page we can read.
    if (home && p !== home && p.html === home.html) return false;
    return CAREER_PATH.test(u.hostname.replace(site, "") + u.pathname);
  });
  let best: { page: Page; titles: string[] } | undefined;
  for (const page of careers) {
    const titles = extractJobs(page.html, page.url).map((j) => j.title);
    if (titles.length > (best?.titles.length ?? 0)) best = { page, titles };
  }
  if (best) {
    const n = best.titles.length;
    return {
      found: { ats: "html", url: best.page.url },
      how: `own careers page, ${n} job link${n === 1 ? "" : "s"} e.g. "${best.titles[0]}" — please verify`,
    };
  }
  const readable = careers.find((p) => pageText(p.html).length >= 200);
  if (readable) return { found: { ats: "page", url: readable.url }, how: "own careers page, read by the local model — please verify" };
  return null;
}
