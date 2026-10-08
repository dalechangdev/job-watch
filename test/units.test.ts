import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { extractJobs, extractJsonLd, extractLinks, fetchJobs, pageText, parseWorkdayUrl } from "../src/adapters.ts";
import { detectAts, ownCareersPage } from "../src/detect.ts";
import { makeTitleFilter } from "../src/filter.ts";
import { parseScore, parseTitles } from "../src/llm.ts";
import { diffAndRecord, type SeenState } from "../src/state.ts";
import type { Company } from "../src/types.ts";
import { htmlToText } from "../src/util.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route fetch calls to canned bodies by URL substring. */
function mockFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const body = routes[key];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const co = (c: Partial<Company>): Company => ({ name: "Acme", ats: "unknown", ...c });

describe("adapters", () => {
  it("greenhouse", async () => {
    mockFetch({
      "boards-api.greenhouse.io/v1/boards/acme/jobs": {
        jobs: [
          {
            id: 42,
            title: " Senior Software Engineer ",
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/42",
            location: { name: "Madrid, Spain" },
            updated_at: "2026-10-06T10:00:00Z",
            content: "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;",
            departments: [{ name: "Engineering" }],
          },
        ],
      },
    });
    const [j] = await fetchJobs(co({ ats: "greenhouse", slug: "acme" }));
    assert.equal(j?.id, "42");
    assert.equal(j?.title, "Senior Software Engineer");
    assert.equal(j?.location, "Madrid, Spain");
    assert.equal(j?.department, "Engineering");
    assert.match(j?.description ?? "", /Build & ship/);
    assert.match(j?.description ?? "", /- TypeScript/);
  });

  it("lever and lever-eu", async () => {
    const calls = mockFetch({
      "/v0/postings/acme": [
        {
          id: "abc",
          text: "Backend Engineer",
          hostedUrl: "https://jobs.lever.co/acme/abc",
          createdAt: Date.UTC(2026, 9, 6),
          workplaceType: "remote",
          categories: { location: "Remote - Europe", team: "Eng" },
          descriptionPlain: "About",
          lists: [{ text: "You have", content: "<li>Python</li>" }],
        },
      ],
    });
    const [j] = await fetchJobs(co({ ats: "lever", slug: "acme" }));
    assert.equal(j?.remote, true);
    assert.equal(j?.postedAt, "2026-10-06T00:00:00.000Z");
    assert.match(j?.location ?? "", /Remote - Europe/);
    assert.match(j?.description ?? "", /You have\n- Python/);
    await fetchJobs(co({ ats: "lever-eu", slug: "acme" }));
    assert.ok(calls[1]?.url.startsWith("https://api.eu.lever.co/"));
  });

  it("ashby skips unlisted jobs", async () => {
    mockFetch({
      "api.ashbyhq.com/posting-api/job-board/acme": {
        jobs: [
          { id: "1", title: "Frontend Engineer", jobUrl: "u1", location: "Berlin", secondaryLocations: [{ location: "Madrid" }], isRemote: true, isListed: true, publishedAt: "2026-10-06" },
          { id: "2", title: "Hidden", jobUrl: "u2", isListed: false },
        ],
      },
    });
    const jobs = await fetchJobs(co({ ats: "ashby", slug: "acme" }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.location, "Berlin, Madrid");
  });

  it("workable, recruitee, smartrecruiters, bamboohr", async () => {
    mockFetch({
      "apply.workable.com/api/v1/widget/accounts/acme": {
        jobs: [{ title: "Dev", shortcode: "XYZ", url: "https://apply.workable.com/acme/j/XYZ/", city: "Barcelona", country: "Spain", telecommuting: false }],
      },
      "acme.recruitee.com/api/offers": {
        offers: [{ id: 7, title: "Dev", careers_url: "https://acme.recruitee.com/o/dev", location: "Lisbon", status: "published" }],
      },
      "api.smartrecruiters.com/v1/companies/acme/postings": {
        totalFound: 1,
        content: [{ id: "9", name: "Dev", location: { city: "Paris", country: "fr" } }],
      },
      "acme.bamboohr.com/careers/list": { result: [{ id: 3, jobOpeningName: "Dev", location: { city: "Austin", state: "TX" } }] },
    });
    assert.equal((await fetchJobs(co({ ats: "workable", slug: "acme" })))[0]?.location, "Barcelona, Spain");
    assert.equal((await fetchJobs(co({ ats: "recruitee", slug: "acme" })))[0]?.id, "7");
    assert.equal((await fetchJobs(co({ ats: "smartrecruiters", slug: "acme" })))[0]?.url, "https://jobs.smartrecruiters.com/acme/9");
    assert.equal((await fetchJobs(co({ ats: "bamboohr", slug: "acme" })))[0]?.url, "https://acme.bamboohr.com/careers/3");
  });

  it("rippling paginates; gem and breezy", async () => {
    const calls = mockFetch({
      "board/acme/jobs?page=0": {
        totalPages: 2,
        items: [{ id: "a", name: "Dev", url: "https://ats.rippling.com/acme/jobs/a", department: { name: "Eng" }, locations: [{ name: "Madrid", workplaceType: "REMOTE" }, { name: "Lisbon" }] }],
      },
      "board/acme/jobs?page=1": { totalPages: 2, items: [{ id: "b", name: "Ops", url: "https://ats.rippling.com/acme/jobs/b" }] },
      "api.gem.com/job_board/v0/acme/job_posts": [
        { id: "g1", title: " Dev ", absolute_url: "https://jobs.gem.com/acme/g1", location: { name: "Remote, Spain" }, location_type: "remote", departments: [{ name: "Eng" }], content_plain: "Build things" },
      ],
      "acme.breezy.hr/json": [{ id: "b1", name: "Dev", url: "https://acme.breezy.hr/p/b1-dev", location: { name: "Ghent, BE", is_remote: true }, department: "Eng" }],
    });
    const rippling = await fetchJobs(co({ ats: "rippling", slug: "acme" }));
    assert.deepEqual(rippling.map((j) => j.id), ["a", "b"]);
    assert.equal(rippling[0]?.location, "Madrid, Lisbon");
    assert.equal(rippling[0]?.remote, true);
    assert.equal(calls.length, 2);
    const gem = (await fetchJobs(co({ ats: "gem", slug: "acme" })))[0];
    assert.deepEqual([gem?.title, gem?.remote, gem?.description], ["Dev", true, "Build things"]);
    assert.equal((await fetchJobs(co({ ats: "breezy", slug: "acme" })))[0]?.remote, true);
  });

  it("personio XML", async () => {
    mockFetch({
      "acme.jobs.personio.de/xml": `<?xml version="1.0"?><workzag-jobs>
        <position><id>111</id><office>Berlin</office><additionalOffices><office>Madrid</office></additionalOffices>
          <department>Tech</department><name>Full Stack Developer (m/w/d)</name><createdAt>2026-10-06T08:00:00+00:00</createdAt>
          <jobDescriptions><jobDescription><name>Your tasks</name><value><![CDATA[<p>React &amp; Node</p>]]></value></jobDescription></jobDescriptions>
        </position></workzag-jobs>`,
    });
    const [j] = await fetchJobs(co({ ats: "personio", slug: "acme" }));
    assert.equal(j?.id, "111");
    assert.equal(j?.location, "Berlin, Madrid");
    assert.equal(j?.url, "https://acme.jobs.personio.de/job/111");
    assert.match(j?.description ?? "", /React & Node/);
  });

  it("teamtailor RSS", async () => {
    mockFetch({
      "acme.teamtailor.com/jobs.rss": `<?xml version="1.0"?><rss xmlns:tt="https://teamtailor.com/locations"><channel>
        <item><title>Software Engineer</title><link>https://acme.teamtailor.com/jobs/1-se</link><guid>abc-1</guid>
        <pubDate>Tue, 06 Oct 2026 09:00:00 +0000</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description>
        <tt:locations><tt:location><tt:city>Madrid</tt:city><tt:country>Spain</tt:country></tt:location></tt:locations></item>
      </channel></rss>`,
    });
    const [j] = await fetchJobs(co({ ats: "teamtailor", slug: "acme" }));
    assert.equal(j?.id, "abc-1");
    assert.equal(j?.location, "Madrid, Spain");
    assert.equal(j?.postedAt, "2026-10-06T09:00:00.000Z");
  });

  it("workday paginates with POST", async () => {
    const page = (n: number, off: number) => ({
      total: 25,
      jobPostings: Array.from({ length: n }, (_, i) => ({ title: `Job ${off + i}`, externalPath: `/job/Madrid/J${off + i}`, locationsText: "Madrid", postedOn: "Posted Today" })),
    });
    let call = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      call++;
      return new Response(JSON.stringify(body.offset === 0 ? page(20, 0) : page(5, 20)));
    }) as typeof fetch;
    const jobs = await fetchJobs(co({ ats: "workday", url: "https://acme.wd3.myworkdayjobs.com/en-US/External" }));
    assert.equal(jobs.length, 25);
    assert.equal(call, 2);
    assert.equal(jobs[0]?.url, "https://acme.wd3.myworkdayjobs.com/External/job/Madrid/J0");
    assert.deepEqual(parseWorkdayUrl("https://x.wd1.myworkdayjobs.com/Careers"), { origin: "https://x.wd1.myworkdayjobs.com", tenant: "x", site: "Careers" });
    assert.equal(parseWorkdayUrl("https://x.wd3.myworkdayjobs.com/es/Empleo").site, "Empleo");
  });

  it("html link extraction", () => {
    const html = `<a href="/careers">Careers</a>
      <a href="/job_posting/senior-engineer-123"><span>Senior Engineer</span></a>
      <a href="https://acme.factorialhr.com/job_posting/senior-engineer-123?x=1">Senior Engineer – Madrid</a>
      <a href="/job_posting/designer-9">Designer</a><a href="mailto:x@y.z">mail</a>`;
    const jobs = extractLinks(html, "https://acme.factorialhr.com", "/job_posting/");
    assert.deepEqual(
      jobs.map((j) => j.title),
      ["Senior Engineer – Madrid", "Designer"],
    );
  });
});

describe("pages without a job platform", () => {
  it("names jobs behind button-style links from the address or the card heading", () => {
    const html = `<h3>Site Manager</h3><a href="/vacancy/123/">Read more</a>
      <p>Frontend</p><a href="/careers/front-end-developer"><p>Apply</p></a>`;
    assert.deepEqual(
      extractLinks(html, "https://acme.com/careers").map((j) => j.title),
      ["Site Manager", "front end developer"],
    );
  });

  it("reads schema.org JobPosting data, and prefers it to links", () => {
    const html = `<a href="/jobs/1">See job posting</a><script type="application/ld+json">
      {"@type": "WebPage", "hasPart": [
        {"@type": "JobPosting", "title": "Data Engineer", "url": "/jobs/1", "datePosted": "2026-01-02",
         "jobLocation": {"@type": "Place", "address": {"addressLocality": "Madrid", "addressCountry": "ES"}}},
        {"@type": "JobPosting", "title": "Designer"},
        {"@type": "JobPosting", "description": "no title, so not a job"}]}</script>`;
    const jobs = extractJsonLd(html, "https://acme.com/careers");
    assert.deepEqual(jobs.map((j) => [j.id, j.title, j.location]), [
      ["https://acme.com/jobs/1", "Data Engineer", "Madrid, ES"],
      ["designer", "Designer", undefined],
    ]);
    assert.equal(extractJobs(html, "https://acme.com/careers").length, 2);
    assert.equal(extractJobs(html, "https://acme.com/careers", "/jobs/").length, 1); // an explicit linkPattern wins
  });

  it("keeps only titles the page really contains", () => {
    const text = pageText("<nav>Careers Blog</nav><p>Open roles</p><p>Senior   Backend Engineer</p><p>Office Manager</p>");
    assert.doesNotMatch(text, /Blog/);
    assert.deepEqual(parseTitles('Sure: {"jobs": ["senior backend engineer", "Chief Vibes Officer", {"title": "Office Manager"}]}', text), [
      "senior backend engineer",
      "Office Manager",
    ]);
    assert.throws(() => parseTitles('{"score": 3}', text));
  });

  it("picks the company's own careers page when there is no platform", () => {
    const acme = co({ website: "https://www.acme.com" });
    const home = { url: "https://www.acme.com/", html: "<a href='/careers'>Careers</a>" };
    const listed = { url: "https://www.acme.com/careers", html: '<a href="/vacancy/site-manager/">Site Manager</a>' };
    assert.deepEqual(ownCareersPage(acme, [home, listed])?.found, { ats: "html", url: listed.url });
    const prose = { url: "https://acme.com/join-us", html: `<p>We are hiring a Backend Engineer. ${"Write to us. ".repeat(30)}</p>` };
    assert.deepEqual(ownCareersPage(acme, [home, prose])?.found, { ats: "page", url: prose.url });
    // A single-page app that serves the same shell everywhere, and other people's sites, are not careers pages.
    assert.equal(ownCareersPage(acme, [home, { url: "https://www.acme.com/jobs", html: home.html }]), null);
    assert.equal(ownCareersPage(acme, [home, { ...listed, url: "https://www.linkedin.com/company/acme/jobs" }]), null);
  });
});

describe("detectAts", () => {
  const cases: [string, string, object][] = [
    ['<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>', "", { ats: "greenhouse", slug: "acme" }],
    ['<a href="https://job-boards.greenhouse.io/acme/jobs/1">', "", { ats: "greenhouse", slug: "acme" }],
    ['<a href="https://jobs.eu.lever.co/acme">', "", { ats: "lever-eu", slug: "acme" }],
    ['<a href="https://jobs.lever.co/acme/123">', "", { ats: "lever", slug: "acme" }],
    ['<iframe src="https://jobs.ashbyhq.com/acme.io/embed">', "", { ats: "ashby", slug: "acme.io" }],
    ["", "https://apply.workable.com/acme/", { ats: "workable", slug: "acme" }],
    ['<a href="https://acme.jobs.personio.de/">', "", { ats: "personio", slug: "acme" }],
    ['<a href="https://acme.recruitee.com/">', "", { ats: "recruitee", slug: "acme" }],
    ['<a href="https://careers.smartrecruiters.com/Acme1">', "", { ats: "smartrecruiters", slug: "Acme1" }],
    ['<a href="https://acme.wd3.myworkdayjobs.com/en-US/External">', "", { ats: "workday", url: "https://acme.wd3.myworkdayjobs.com/en-US/External" }],
    ['<a href="https://acme.wd3.myworkdayjobs.com/es/Empleo/userHome">', "", { ats: "workday", url: "https://acme.wd3.myworkdayjobs.com/es/Empleo" }],
    ['<a href="https://ats.rippling.com/acme-roles/jobs">', "", { ats: "rippling", slug: "acme-roles" }],
    ['<link href="https://jobs.gem.com/manifest.json"><a href="https://jobs.gem.com/acme">', "", { ats: "gem", slug: "acme" }],
    ['<a href="https://acme.breezy.hr/">', "", { ats: "breezy", slug: "acme" }],
    ['<link href="https://assets-aws.teamtailor-cdn.com/x.css">', "https://careers.acme.com/jobs", { ats: "teamtailor", url: "https://careers.acme.com/jobs.rss" }],
    ['<a href="https://acme.factorialhr.com">', "", { ats: "html", url: "https://acme.factorialhr.com", linkPattern: "/job_posting/" }],
  ];
  for (const [html, url, want] of cases) {
    it(JSON.stringify(want), () => assert.deepEqual(detectAts(html, url), want));
  }
  it("returns null for plain pages", () => assert.equal(detectAts("<a href='/about'>About</a>"), null));
});

describe("state", () => {
  const j = (id: string) => ({ id, title: id, url: id });
  it("baselines, then reports only new ids, and tolerates a job vanishing briefly", () => {
    const s: SeenState = {};
    const d0 = new Date("2026-10-01T08:00:00Z");
    assert.deepEqual(diffAndRecord(s, "A", [j("1"), j("2")], d0), { baseline: true, fresh: [] });
    const r1 = diffAndRecord(s, "A", [j("1"), j("2"), j("3")], new Date("2026-10-02T08:00:00Z"));
    assert.equal(r1.baseline, false);
    assert.deepEqual(r1.fresh.map((x) => x.id), ["3"]);
    // Board glitch: empty result. Next day "2" is back and must not be reported again.
    diffAndRecord(s, "A", [], new Date("2026-10-03T08:00:00Z"));
    assert.deepEqual(diffAndRecord(s, "A", [j("2")], new Date("2026-10-04T08:00:00Z")).fresh, []);
    // Gone for more than 45 days: forgotten, so a repost counts as new.
    diffAndRecord(s, "A", [], new Date("2026-12-01T08:00:00Z"));
    assert.deepEqual(diffAndRecord(s, "A", [j("1")], new Date("2026-12-02T08:00:00Z")).fresh.map((x) => x.id), ["1"]);
  });
});

describe("filter and scoring", () => {
  const keep = makeTitleFilter({
    titleInclude: ["engineer", "developer"],
    titleExclude: ["\\bintern\\b", "electrical", "(solutions|sales) engineer"],
  });
  it("title filter", () => {
    const t = (title: string) => keep({ id: "x", url: "x", title });
    assert.equal(t("Senior Software Engineer"), true);
    assert.equal(t("Full Stack Developer (m/w/d)"), true);
    assert.equal(t("Software Engineer Intern"), false);
    assert.equal(t("Electrical Engineer"), false);
    assert.equal(t("Solutions Engineer"), false);
    assert.equal(t("Account Executive"), false);
  });
  it("parses model replies, including chatty ones", () => {
    assert.deepEqual(parseScore('{"score": 8, "locationOk": "yes", "reason": "TS + React, Madrid"}'), {
      score: 8,
      locationOk: "yes",
      reason: "TS + React, Madrid",
    });
    assert.equal(parseScore('Sure! ```json\n{"score": "11", "location_ok": false, "reason": "x"}\n```').score, 10);
    assert.equal(parseScore('{"score": 3, "locationOk": false, "reason": "US only"}').locationOk, "no");
    assert.throws(() => parseScore("no json here"));
  });
  it("htmlToText", () => {
    assert.equal(htmlToText("<p>a&nbsp;&amp;&#39;b</p><script>x()</script><br>c"), "a &'b\nc");
  });
});
