/**
 * End-to-end: a local "careers site" plus a fake OpenAI-compatible model server,
 * then real runs of `check` and `discover` in a temp folder.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

let server: Server;
let base = "";
let jobs = ["Senior Software Engineer", "Office Manager"];
const llmRequests: any[] = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/careers") {
      res.end(`<html><body>${jobs.map((t, i) => `<a href="/jobs/${i}">${t}</a>`).join("")}</body></html>`);
    } else if (req.url === "/site") {
      res.end(`<a href="/about">About</a><a href="/join">Join us</a>`);
    } else if (req.url === "/join") {
      res.end(`<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeclimate"></script>`);
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [] }));
    } else if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        llmRequests.push(parsed);
        const posting: string = parsed.messages[1].content;
        const score = posting.includes("Engineer") ? 9 : 1;
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score, locationOk: "yes", reason: "fixture" }) } }] }));
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

function workspace(llmUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "job-watch-"));
  copyFileSync(join(ROOT, "config.yaml"), join(dir, "config.yaml"));
  copyFileSync(join(ROOT, "profile.md"), join(dir, "profile.md"));
  writeFileSync(
    join(dir, "companies.yaml"),
    `# header comment stays\n- name: Acme\n  ats: html\n  url: ${base}/careers\n  linkPattern: /jobs/\n` +
      `# section comment stays\n- name: Acme Climate\n  website: ${base}/site\n  ats: unknown\n- name: Paused\n  ats: html\n  url: ${base}/nope\n  enabled: false\n`,
  );
  writeFileSync(join(dir, ".env"), `LLM_BASE_URL=${llmUrl}\nLLM_MODEL=fake\n`);
  return dir;
}

const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const check = (dir: string, ...args: string[]) =>
  run(tsx, [join(ROOT, "src", "check.ts"), "--quiet", ...args], { env: { ...process.env, JOB_WATCH_HOME: dir } });

describe("check", () => {
  it("baselines, then reports and scores only new jobs", async () => {
    jobs = ["Senior Software Engineer", "Office Manager"];
    const dir = workspace(`${base}/v1`);

    const first = await check(dir);
    assert.match(first.stdout, /First check/);
    assert.match(first.stdout, /Nothing new/);
    assert.match(first.stdout, /Job board not found yet[\s\S]*Acme Climate/);
    assert.doesNotMatch(first.stdout, /Paused/);
    assert.equal(llmRequests.length, 0);

    jobs = [...jobs, "Backend Engineer", "Sales Lead"];
    const second = await check(dir);
    assert.match(second.stdout, /## Strong matches[\s\S]*Backend Engineer[\s\S]*9\/10/);
    assert.doesNotMatch(second.stdout, /Sales Lead/); // removed by the title filter, never sent to the model
    assert.doesNotMatch(second.stdout, /Senior Software Engineer/); // already seen
    assert.equal(llmRequests.length, 1);
    assert.equal(llmRequests[0].model, "fake");
    assert.ok(existsSync(join(dir, "reports", "latest.md")));

    const third = await check(dir);
    assert.match(third.stdout, /Nothing new/);
  });

  it("reports unscored jobs when the model is down, and --dry-run leaves state alone", async () => {
    jobs = ["Platform Engineer"];
    const dir = workspace("http://127.0.0.1:9/v1");
    await check(dir);
    jobs = ["Platform Engineer", "Frontend Developer"];
    const out = await check(dir, "--dry-run");
    assert.match(out.stdout, /New \(not scored\)[\s\S]*Local model unavailable[\s\S]*Frontend Developer/);
    const again = await check(dir, "--dry-run");
    assert.match(again.stdout, /Frontend Developer/); // still new, because the dry run didn't save
  });
});

describe("discover", () => {
  it("follows a careers link to a Greenhouse embed and keeps YAML comments", async () => {
    const dir = workspace(`${base}/v1`);
    await run(tsx, [join(ROOT, "src", "discover.ts")], { env: { ...process.env, JOB_WATCH_HOME: dir } });
    const yaml = readFileSync(join(dir, "companies.yaml"), "utf8");
    assert.match(yaml, /# header comment stays/);
    assert.match(yaml, /# section comment stays/);
    assert.match(yaml, /name: Acme Climate\n\s+website: .*\n\s+ats: greenhouse\n\s+slug: acmeclimate/);
    assert.doesNotMatch(yaml, /verify/);
  });
});
