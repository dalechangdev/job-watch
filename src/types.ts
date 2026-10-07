export const ATS_TYPES = [
  "greenhouse",
  "lever",
  "lever-eu",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "teamtailor",
  "smartrecruiters",
  "bamboohr",
  "workday",
  "html",
  "manual",
  "unknown",
] as const;

export type AtsType = (typeof ATS_TYPES)[number];

export interface Company {
  name: string;
  website?: string;
  careersUrl?: string;
  ats: AtsType;
  slug?: string;
  url?: string;
  linkPattern?: string;
  verify?: boolean;
  enabled?: boolean;
}

/** A job posting, normalised across platforms. */
export interface Job {
  id: string;
  title: string;
  url: string;
  location?: string;
  remote?: boolean;
  department?: string;
  /** ISO date when the platform exposes one (Workday gives text like "Posted Today"). */
  postedAt?: string;
  description?: string;
}

export interface Score {
  score: number;
  locationOk: "yes" | "no" | "unknown";
  reason: string;
}

export interface ScoredJob extends Job {
  company: string;
  score?: Score;
}

export interface Config {
  titleInclude: string[];
  titleExclude: string[];
  strongScore: number;
  maybeScore: number;
  maxDescriptionChars: number;
  concurrency: number;
}
