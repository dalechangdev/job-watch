import { XMLParser } from "fast-xml-parser";
import type { AtsType, Company, Job } from "./types.ts";
import { decodeEntities, getJson, getText, htmlToText, http, HttpError } from "./util.ts";

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
  const site = parts.filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p))[0];
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
const DEFAULT_LINK_PATTERN = "(job|career|position|vacanc|opening|posting|role)s?[/_-]";
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
    const text = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    const title = text || decodeURIComponent(abs.pathname.split("/").filter(Boolean).pop() ?? "").replace(/[-_]+/g, " ");
    const prev = seen.get(key);
    if (!prev || prev.title.length < title.length) seen.set(key, { id: key, title: title.slice(0, 200), url: abs.href });
  }
  return [...seen.values()];
}
const html: Fetcher = async (c) => {
  const url = need(c, "url");
  return extractLinks(await getText(url), url, c.linkPattern);
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
  workday,
  html,
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
    default:
      return c.url ?? c.careersUrl ?? c.website;
  }
}

export async function fetchJobs(c: Company): Promise<Job[]> {
  const fn = ADAPTERS[c.ats];
  if (!fn) throw new Error(`No fetcher for ats "${c.ats}"`);
  return fn(c);
}
