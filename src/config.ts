import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parse, parseDocument, type YAMLMap } from "yaml";
import { ATS_TYPES, type Company, type Config } from "./types.ts";

export const ROOT = process.env.JOB_WATCH_HOME ?? join(dirname(fileURLToPath(import.meta.url)), "..");
export const paths = {
  companies: join(ROOT, "companies.yaml"),
  config: join(ROOT, "config.yaml"),
  profile: join(ROOT, "profile.md"),
  env: join(ROOT, ".env"),
  seen: join(ROOT, "data", "seen.json"),
  reports: join(ROOT, "reports"),
};

export function loadEnv(): void {
  if (existsSync(paths.env)) process.loadEnvFile(paths.env);
}

export function loadCompanies(file = paths.companies): Company[] {
  const raw = parse(readFileSync(file, "utf8")) as Company[] | null;
  if (!Array.isArray(raw)) throw new Error(`${file} must be a YAML list`);
  const names = new Set<string>();
  return raw.map((c, i) => {
    if (!c?.name) throw new Error(`${file}: entry #${i + 1} has no name`);
    if (names.has(c.name)) throw new Error(`${file}: duplicate company name "${c.name}"`);
    names.add(c.name);
    const ats = c.ats ?? "unknown";
    if (!ATS_TYPES.includes(ats)) throw new Error(`${file}: ${c.name} has unknown ats "${ats}"`);
    return { ...c, ats, slug: c.slug == null ? undefined : String(c.slug) };
  });
}

/** Writes back the board fields of each company, keeping the file's comments and order. */
export function saveCompanies(companies: Company[], file = paths.companies): void {
  const doc = parseDocument(readFileSync(file, "utf8"));
  const byName = new Map(companies.map((c) => [c.name, c]));
  const seq = doc.contents;
  if (!isSeq(seq)) throw new Error(`${file} must be a YAML list`);
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const map = item as unknown as YAMLMap<string, unknown>;
    const c = byName.get(String(map.get("name")));
    if (!c) continue;
    for (const key of ["ats", "slug", "url", "linkPattern", "verify"] as const) {
      const v = c[key];
      if (v == null || v === false) map.delete(key);
      else map.set(key, v);
    }
  }
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

export function loadConfig(file = paths.config): Config {
  const c = parse(readFileSync(file, "utf8")) as Partial<Config>;
  return {
    titleInclude: c.titleInclude ?? [],
    titleExclude: c.titleExclude ?? [],
    strongScore: c.strongScore ?? 7,
    maybeScore: c.maybeScore ?? 4,
    maxDescriptionChars: c.maxDescriptionChars ?? 4000,
    concurrency: c.concurrency ?? 6,
  };
}

export function loadProfile(file = paths.profile): string {
  return readFileSync(file, "utf8");
}
