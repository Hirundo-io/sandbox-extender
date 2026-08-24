import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";
import { z } from "zod";

import { profileIdSchema } from "./schemas.js";
import type { Profile, ProfileProposal } from "./types.js";

const cedarGroupingSchema = z.object({
  id: z.string().min(1),
  policies: z.record(z.string(), z.union([
    z.string(),
    z.array(z.string().min(1)).min(1),
  ])),
}).strict();
const diskProfileSchema = z.object({
  allowedTargets: z.array(z.string().min(1)),
  groupings: z.array(cedarGroupingSchema),
  id: profileIdSchema,
  policyRevision: z.string().min(1),
  sessionContext: z.array(z.string().min(1)).optional(),
}).strict();
const bindingsSchema = z.record(z.string().min(1), profileIdSchema);
const auditEntriesSchema = z.array(z.record(z.string(), z.unknown()));

type DiskProfile = z.infer<typeof diskProfileSchema>;

export class PolicyRepository {
  constructor(readonly root: string) {}

  async loadProfile(profileId: string): Promise<Profile> {
    profileIdSchema.parse(profileId);
    const file = join(this.root, "profiles", `${profileId}.json`);
    const candidate: unknown = JSON.parse(await readFile(file, "utf8"));
    const profile = parseProfile(candidate, file);

    return {
      ...profile,
      allowedTargets: new Set(profile.allowedTargets),
    };
  }

  async listProfiles(): Promise<string[]> {
    const directory = join(this.root, "profiles");
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "profiles"), { recursive: true }),
      mkdir(join(this.root, "proposals"), { recursive: true }),
      mkdir(join(this.root, "tests"), { recursive: true }),
      mkdir(join(this.root, "state"), { recursive: true }),
    ]);
  }

  async writeProposal(proposal: ProfileProposal): Promise<void> {
    await this.initialize();
    const id = proposal.profile.id;
    await writeFile(
      join(this.root, "proposals", `${id}.json`),
      `${JSON.stringify(proposal.profile, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(this.root, "tests", `${id}.json`),
      `${JSON.stringify(proposal.tests, null, 2)}\n`,
      "utf8",
    );
  }

  async promoteProposal(profileId: string, policyRevision: string): Promise<void> {
    profileIdSchema.parse(profileId);
    if (!policyRevision || policyRevision === "pending-review") {
      throw new Error("policyRevision must identify the reviewed policy state");
    }
    await this.initialize();
    const proposalFile = join(this.root, "proposals", `${profileId}.json`);
    const candidate: unknown = JSON.parse(await readFile(proposalFile, "utf8"));
    const profile = parseProfile(candidate, proposalFile);
    const reviewedProfile = { ...profile, policyRevision };
    await writeFile(
      join(this.root, "profiles", `${profileId}.json`),
      `${JSON.stringify(reviewedProfile, null, 2)}\n`,
      "utf8",
    );
  }

  async readState(): Promise<Record<string, string>> {
    const file = join(this.root, "state", "thread-bindings.json");
    try {
      const candidate: unknown = JSON.parse(await readFile(file, "utf8"));
      return bindingsSchema.parse(candidate);
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
  }

  async writeState(bindings: Readonly<Record<string, string>>): Promise<void> {
    const file = join(this.root, "state", "thread-bindings.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
  }

  async appendAudit(entry: Readonly<Record<string, unknown>>): Promise<void> {
    const file = join(this.root, "audit.yaml");
    let entries: unknown[] = [];
    try {
      const candidate: unknown = parse(await readFile(file, "utf8"));
      entries = auditEntriesSchema.parse(candidate);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }

    entries.push({ ...entry, timestamp: new Date().toISOString() });
    await writeFile(file, stringify(entries), "utf8");
  }
}

function parseProfile(candidate: unknown, file: string): DiskProfile {
  const result = diskProfileSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`${file} is not a valid policy profile`, { cause: result.error });
  }
  return result.data;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
