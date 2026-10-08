import { XMLParser } from "fast-xml-parser";
import { extractJobTitles, llmOptionsFromEnv } from "./llm.ts";
import type { AtsType, Company, Job } from "./types.ts";
import { decodeEntities, getJson, getText, htmlToText, http, HttpError, slugify } from "./util.ts";

type Fetcher = (c: Company) => Promise<Job[]>;

const xml = new XMLParser({ ignoreAttributes: false, cdataPropName: false, parseTagValue: false });
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));
const join = (...parts: (string | undefined | null)[]) => parts.filter(Boolean).join(", ") || undefined;

function need(c: Company, field: "slug" | "url"): string {
  const v = c[field];
  if (!v) throw new Error(`${c.name}: ats "${c.ats}" needs a "${field}" in companies.yaml`);
  return v;
}

// ---------------------------------------------------------------- Greenhouse
interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  content?: string;
  departments?: { name: string }[];
}
const greenhouse: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return data.jobs.map((j) => ({
    id: String(j.id),
    title: j.title.trim(),
    url: j.absolute_url,
    location: str(j.location?.name),
    department: str(j.departments?.[0]?.name),
    postedAt: j.first_published ?? j.updated_at,
    description: htmlToText(j.content),
  }));
};

// ---------------------------------------------------------------- Lever
interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { location?: string; team?: string; allLocations?: string[] };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
}
const lever =
  (host: string): Fetcher =>
  async (c) => {
    const slug = need(c, "slug");
    const data = await getJson<LeverJob[]>(`https://${host}/v0/postings/${slug}?mode=json`);
    return data.map((j) => ({
      id: j.id,
      title: j.text.trim(),
      url: j.hostedUrl,
      location: join(...(j.categories?.allLocations ?? [j.categories?.location]), j.workplaceType),
      remote: j.workplaceType ? j.workplaceType === "remote" : undefined,
      department: str(j.categories?.team),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      description: [
        j.descriptionPlain,
        ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
        j.additionalPlain,
      ]
        .filter(Boolean)
        .join("\n"),
    }));
  };

// ---------------------------------------------------------------- Ashby
interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  department?: string;
  publishedAt?: string;
  isListed?: boolean;
  descriptionPlain?: string;
}
const ashby: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: j.id,
      title: j.title.trim(),
      url: j.jobUrl,
      location: join(j.location, ...(j.secondaryLocations ?? []).map((s) => s.location), j.workplaceType),
      remote: j.isRemote,
      department: str(j.department),
      postedAt: j.publishedAt,
      description: j.descriptionPlain,
    }));
};

// ---------------------------------------------------------------- Workable
interface WorkableJob {
  title: string;
  shortcode: string;
  url?: string;
  shortlink?: string;
  telecommuting?: boolean;
  department?: string;
  published_on?: string;
  created_at?: string;
  city?: string;
  country?: string;
  locations?: { city?: string; country?: string }[];
  description?: string;
}
const workable: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<{ jobs: WorkableJob[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
  );
  return data.jobs.map((j) => ({
    id: j.shortcode,
    title: j.title.trim(),
    url: j.url ?? j.shortlink ?? `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
    location:
      join(...(j.locations?.length ? j.locations.map((l) => join(l.city, l.country)) : [join(j.city, j.country)])) ??
      undefined,
    remote: j.telecommuting,
    department: str(j.department),
    postedAt: j.published_on ?? j.created_at,
    description: htmlToText(j.description),
  }));
};

// ---------------------------------------------------------------- Recruitee
interface RecruiteeOffer {
  id: number;
  title: string;
  careers_url: string;
  location?: string;
  remote?: boolean;
  department?: string;
  published_at?: string;
  description?: string;
  requirements?: string;
  status?: string;
}
const recruitee: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<{ offers: RecruiteeOffer[] }>(`https://${slug}.recruitee.com/api/offers/`);
  return data.offers
    .filter((o) => !o.status || o.status === "published")
    .map((o) => ({
      id: String(o.id),
      title: o.title.trim(),
      url: o.careers_url,
      location: str(o.location),
      remote: o.remote,
      department: str(o.department),
      postedAt: o.published_at,
      description: htmlToText(`${o.description ?? ""}\n${o.requirements ?? ""}`),
    }));
};

// ---------------------------------------------------------------- Personio
const personio: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const body = await getText(`https://${slug}.jobs.personio.de/xml?language=en`);
  const doc = xml.parse(body);
  const positions = asArray(doc?.["workzag-jobs"]?.position);
  return positions.map((p: Record<string, any>) => {
    const offices = [p.office, ...asArray(p.additionalOffices?.office)].filter(Boolean).map(String);
    const descs = asArray(p.jobDescriptions?.jobDescription)
      .map((d: Record<string, any>) => `${d.name ?? ""}\n${htmlToText(String(d.value ?? ""))}`)
      .join("\n");
    return {
      id: String(p.id),
      title: decodeEntities(String(p.name)).trim(),
      url: `https://${slug}.jobs.personio.de/job/${p.id}`,
      location: join(...offices),
      department: str(p.department),
      postedAt: str(p.createdAt),
      description: descs,
    };
  });
};

// ---------------------------------------------------------------- Teamtailor (RSS)
const teamtailor: Fetcher = async (c) => {
  const feed = c.url ?? `https://${need(c, "slug")}.teamtailor.com/jobs.rss`;
  const doc = xml.parse(await getText(feed));
  const items = asArray(doc?.rss?.channel?.item);
  return items.map((it: Record<string, any>) => {
    const link = String(it.link ?? "");
    const guid = typeof it.guid === "object" ? it.guid?.["#text"] : it.guid;
    const locs = asArray(it["tt:locations"]?.["tt:location"])
      .map((l: Record<string, any>) => join(str(l["tt:city"]), str(l["tt:country"])))
      .filter(Boolean) as string[];
    return {
      id: String(guid ?? link),
      title: decodeEntities(String(it.title ?? "")).trim(),
      url: link,
      location: join(...locs, str(it.remoteStatus)),
      department: str(it["tt:department"]),
      postedAt: it.pubDate ? new Date(String(it.pubDate)).toISOString() : undefined,
      description: htmlToText(String(it.description ?? "")),
    };
  });
};

// ---------------------------------------------------------------- SmartRecruiters
interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; country?: string; remote?: boolean; fullLocation?: string };
  department?: { label?: string };
}
const smartrecruiters: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const out: Job[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await getJson<{ totalFound: number; content: SrPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`,
    );
    for (const p of page.content) {
      out.push({
        id: p.id,
        title: p.name.trim(),
        url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
        location: p.location?.fullLocation ?? join(p.location?.city, p.location?.country),
        remote: p.location?.remote,
        department: str(p.department?.label),
        postedAt: p.releasedDate,
      });
    }
    if (offset + 100 >= page.totalFound) break;
  }
  return out;
};

// ---------------------------------------------------------------- BambooHR
interface BambooJob {
  id: string | number;
  jobOpeningName: string;
  departmentLabel?: string;
  isRemote?: boolean | null;
  location?: { city?: string; state?: string };
  atsLocation?: { city?: string; country?: string };
}
const bamboohr: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<{ result: BambooJob[] }>(`https://${slug}.bamboohr.com/careers/list`);
  return data.result.map((j) => ({
    id: String(j.id),
    title: j.jobOpeningName.trim(),
    url: `https://${slug}.bamboohr.com/careers/${j.id}`,
    location: join(j.atsLocation?.city ?? j.location?.city, j.atsLocation?.country ?? j.location?.state),
    remote: j.isRemote ?? undefined,
    department: str(j.departmentLabel),
  }));
};

// ---------------------------------------------------------------- Rippling
interface RipplingJob {
  id: string;
  name: string;
  url: string;
  department?: { name?: string };
  locations?: { name?: string; workplaceType?: string }[];
}
const rippling: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const out = new Map<string, Job>();
  let pages = 1;
  for (let page = 0; page < Math.min(pages, 20); page++) {
    const data = await getJson<{ items: RipplingJob[]; totalPages?: number }>(
      `https://ats.rippling.com/api/v2/board/${slug}/jobs?page=${page}&pageSize=50`,
    );
    pages = data.totalPages ?? 1;
    for (const j of data.items ?? []) {
      const types = (j.locations ?? []).map((l) => l.workplaceType);
      out.set(j.id, {
        id: j.id,
        title: j.name.trim(),
        url: j.url,
        location: join(...(j.locations ?? []).map((l) => l.name)),
        remote: types.includes("REMOTE") ? true : undefined,
        department: str(j.department?.name),
      });
    }
  }
  return [...out.values()];
};

// ---------------------------------------------------------------- Gem
interface GemJob {
  id: string;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  location_type?: string;
  departments?: { name: string }[];
  first_published_at?: string;
  content_plain?: string;
  content?: string;
}
const gem: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<GemJob[]>(`https://api.gem.com/job_board/v0/${slug}/job_posts/`);
  return data.map((j) => ({
    id: j.id,
    title: j.title.trim(),
    url: j.absolute_url,
    location: str(j.location?.name),
    remote: j.location_type === "remote" ? true : undefined,
    department: str(j.departments?.[0]?.name),
    postedAt: j.first_published_at,
    description: j.content_plain?.trim() || htmlToText(j.content),
  }));
};

// ---------------------------------------------------------------- Breezy HR
interface BreezyJob {
  id: string;
  name: string;
  url: string;
  published_date?: string;
  department?: string;
  location?: { name?: string; is_remote?: boolean };
}
const breezy: Fetcher = async (c) => {
  const slug = need(c, "slug");
  const data = await getJson<BreezyJob[]>(`https://${slug}.breezy.hr/json`);
  return data.map((j) => ({
    id: j.id,
    title: j.name.trim(),
    url: j.url,
    location: str(j.location?.name),
    remote: j.location?.is_remote ?? undefined,
    department: str(j.department),
    postedAt: j.published_date,
  }));
};

// ---------------------------------------------------------------- Workday
interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
}
export function parseWorkdayUrl(url: string): { origin: string; tenant: string; site: string } {
  const u = new URL(url);
  const tenant = u.hostname.split(".")[0] as string;
  const parts = u.pathname.split("/").filter(Boolean);
  const site = parts.filter((p) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(p))[0];
  if (!site) throw new Error(`Can't find the Workday site name in ${url}`);
  return { origin: u.origin, tenant, site };
}
const workday: Fetcher = async (c) => {
  const { origin, tenant, site } = parseWorkdayUrl(need(c, "url"));
  const out: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < Math.min(total, 500); offset += 20) {
    const res = await http(`${origin}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
    });
    if (!res.ok) throw new HttpError(res.status, res.url);
    const page = (await res.json()) as { total?: number; jobPostings: WdPosting[] };
    if (offset === 0) total = page.total ?? 0;
    if (!page.jobPostings?.length) break;
    for (const p of page.jobPostings) {
      out.push({
        id: p.externalPath,
        title: p.title.trim(),
        url: `${origin}/${site}${p.externalPath}`,
        location: str(p.locationsText),
        postedAt: str(p.postedOn), // text, e.g. "Posted Today"
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------- Plain HTML page
const DEFAULT_LINK_PATTERN =
  "(jobs?|careers?|positions?|vacanc(y|ies)|openings?|postings?|roles?|stellen(angebote?)?|empleos?|ofertas?)[/_-]";
/** Link text that names the button rather than the job, e.g. "See job posting" or "Apply now". */
const GENERIC_LINK_TEXT = /^(see|view|read|learn|apply|more|details?|find out|open|go to|ver|más|mehr)\b.{0,30}$/i;

/** Links that sit among the jobs on many careers pages but aren't one. */
const NOT_A_JOB = /\b(open|speculative|spontaneous|unsolicited|general) application\b|initiativbewerbung|candidatura espont[aá]nea/i;

function headingBefore(html: string, index: number): string | undefined {
  const before = html.slice(Math.max(0, index - 2000), index);
  const headings = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  const text = htmlToText(headings.at(-1)?.[1]).replace(/\s+/g, " ").trim();
  return text.length >= 3 && text.length <= 150 ? text : undefined;
}

export function extractLinks(html: string, pageUrl: string, pattern?: string): Job[] {
  const re = new RegExp(pattern ?? DEFAULT_LINK_PATTERN, "i");
  const page = new URL(pageUrl);
  const seen = new Map<string, Job>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let abs: URL;
    try {
      abs = new URL(decodeEntities(m[1] as string), page);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    const key = abs.origin + abs.pathname.replace(/\/$/, "");
    if (key === page.origin + page.pathname.replace(/\/$/, "")) continue;
    if (!re.test(abs.pathname + abs.search)) continue;
    let text = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    const slug = decodeURIComponent(abs.pathname.split("/").filter(Boolean).pop() ?? "").replace(/[-_]+/g, " ");
    // A button label says nothing; a wordy address ("/careers/front-end-developer") or the card's heading does.
    if (GENERIC_LINK_TEXT.test(text)) text = (/[a-z]{3,} [a-z]{3,}/i.test(slug) ? slug : headingBefore(html, m.index)) ?? text;
    const title = text || slug;
    if (!pattern && NOT_A_JOB.test(title)) continue;
    const prev = seen.get(key);
    if (!prev || prev.title.length < title.length) seen.set(key, { id: key, title: title.slice(0, 200), url: abs.href });
  }
  return [...seen.values()];
}

/** Jobs from schema.org JobPosting data embedded in a page (many self-built careers pages have it for Google). */
export function extractJsonLd(html: string, pageUrl: string): Job[] {
  const out = new Map<string, Job>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, any>;
    const title = str(o.title ?? o.name)?.trim();
    if ([o["@type"]].flat().includes("JobPosting") && title) {
      let url = pageUrl;
      try {
        if (o.url) url = new URL(String(o.url), pageUrl).href;
      } catch {}
      const address = [o.jobLocation].flat()[0]?.address;
      const id = url === pageUrl ? slugify(title) : url;
      out.set(id, {
        id,
        title,
        url,
        location: typeof address === "string" ? address : join(address?.addressLocality, address?.addressRegion, address?.addressCountry),
        remote: o.jobLocationType === "TELECOMMUTE" ? true : undefined,
        postedAt: str(o.datePosted),
        description: htmlToText(str(o.description)) || undefined,
      });
    }
    Object.values(o).forEach(visit);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1] as string));
    } catch {}
  }
  return [...out.values()];
}

/** What `ats: html` reads from a page: embedded JobPosting data if there is any, otherwise job-looking links. */
export function extractJobs(html: string, pageUrl: string, pattern?: string): Job[] {
  const structured = pattern ? [] : extractJsonLd(html, pageUrl);
  return structured.length ? structured : extractLinks(html, pageUrl, pattern);
}
const html: Fetcher = async (c) => {
  const url = need(c, "url");
  return extractJobs(await getText(url), url, c.linkPattern);
};

// ---------------------------------------------------------------- Any page, read by the local model
const PAGE_TEXT_CHARS = 12_000;
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The readable text of a page, without menus and footers. */
export function pageText(html: string): string {
  return htmlToText(html.replace(/<(nav|header|footer|noscript|svg|form)\b[\s\S]*?<\/\1>/gi, " "))
    .replace(/\n(\s*-?\s*\n)+/g, "\n")
    .slice(0, PAGE_TEXT_CHARS);
}

const page: Fetcher = async (c) => {
  const url = need(c, "url");
  const llm = llmOptionsFromEnv();
  if (!llm) throw new Error(`${c.name}: ats "page" needs the local model, and LLM_SCORING is off`);
  const body = await getText(url);
  const text = pageText(body);
  if (text.length < 200) throw new Error(`${url} has almost no text without JavaScript; use ats: manual`);
  const titles = await extractJobTitles(llm, c.name, text);
  const links = extractLinks(body, url, ".");
  return titles.map((title) => ({
    // The title is the only stable handle a free-form page gives us.
    id: slugify(title),
    title,
    url: links.find((l) => squash(l.title).includes(squash(title)))?.url ?? url,
  }));
};

// ---------------------------------------------------------------- registry
export const ADAPTERS: Partial<Record<AtsType, Fetcher>> = {
  greenhouse,
  lever: lever("api.lever.co"),
  "lever-eu": lever("api.eu.lever.co"),
  ashby,
  workable,
  recruitee,
  personio,
  teamtailor,
  smartrecruiters,
  bamboohr,
  rippling,
  gem,
  breezy,
  workday,
  html,
  page,
};

/** Public board URL for humans (used in reports and discover output). */
export function boardUrl(c: Company): string | undefined {
  const s = c.slug;
  switch (c.ats) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${s}`;
    case "lever":
      return `https://jobs.lever.co/${s}`;
    case "lever-eu":
      return `https://jobs.eu.lever.co/${s}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${s}`;
    case "workable":
      return `https://apply.workable.com/${s}/`;
    case "recruitee":
      return `https://${s}.recruitee.com/`;
    case "personio":
      return `https://${s}.jobs.personio.de/`;
    case "teamtailor":
      return c.url ?? `https://${s}.teamtailor.com/jobs`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${s}`;
    case "bamboohr":
      return `https://${s}.bamboohr.com/careers`;
    case "rippling":
      return `https://ats.rippling.com/${s}/jobs`;
    case "gem":
      return `https://jobs.gem.com/${s}`;
    case "breezy":
      return `https://${s}.breezy.hr/`;
    default:
      return c.url ?? c.careersUrl ?? c.website;
  }
}

export async function fetchJobs(c: Company): Promise<Job[]> {
  const fn = ADAPTERS[c.ats];
  if (!fn) throw new Error(`No fetcher for ats "${c.ats}"`);
  return fn(c);
}
