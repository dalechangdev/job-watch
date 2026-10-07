import type { Company } from "./types.ts";

export type Found = Pick<Company, "ats" | "slug" | "url" | "linkPattern">;

const BAD_SLUGS = new Set(["embed", "api", "j", "www", "app", "assets", "careers", "jobs", "static", "cdn"]);
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
  if ((m = hay.match(/https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[\w-]+/)))
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

