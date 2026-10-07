import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Job } from "./types.ts";

export interface SeenEntry {
  first: string;
  last: string;
}
/** company name -> job id -> when it was first and last seen */
export type SeenState = Record<string, Record<string, SeenEntry>>;

/** Forget jobs that have been gone this long, so state doesn't grow forever. */
const FORGET_AFTER_DAYS = 45;

export function loadSeen(file: string): SeenState {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SeenState) : {};
}

export function saveSeen(file: string, state: SeenState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, file);
}

export interface DiffResult {
  /** True when this company has never been checked: everything is recorded, nothing is reported. */
  baseline: boolean;
  fresh: Job[];
}

/**
 * Records `jobs` for `company` in `state` and returns the ones not seen before.
 * Jobs that vanish are remembered for a while, so a board that briefly fails or reshuffles
 * doesn't make old jobs look new.
 */
export function diffAndRecord(state: SeenState, company: string, jobs: Job[], now = new Date()): DiffResult {
  const prev = state[company];
  const baseline = prev === undefined;
  const nowIso = now.toISOString();
  const cutoff = now.getTime() - FORGET_AFTER_DAYS * 86_400_000;
  const next: Record<string, SeenEntry> = {};

  for (const [id, entry] of Object.entries(prev ?? {})) {
    if (Date.parse(entry.last) >= cutoff) next[id] = entry;
  }
  const fresh: Job[] = [];
  for (const job of jobs) {
    const existing = next[job.id];
    if (existing) {
      existing.last = nowIso;
    } else {
      next[job.id] = { first: nowIso, last: nowIso };
      if (!baseline) fresh.push(job);
    }
  }
  state[company] = next;
  return { baseline, fresh };
}
