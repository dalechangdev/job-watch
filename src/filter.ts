import type { Config, Job } from "./types.ts";

export function makeTitleFilter(cfg: Pick<Config, "titleInclude" | "titleExclude">): (job: Job) => boolean {
  const inc = cfg.titleInclude.map((p) => new RegExp(p, "i"));
  const exc = cfg.titleExclude.map((p) => new RegExp(p, "i"));
  return (job) => (inc.length === 0 || inc.some((r) => r.test(job.title))) && !exc.some((r) => r.test(job.title));
}
