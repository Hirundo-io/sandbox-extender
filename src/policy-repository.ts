import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";
import { z } from "zod";

import { PolicyCore } from "./policy-core.js";
import { policyRevisionSchema, profileIdSchema } from "./schemas.js";
import type {
  AuthorizationTest,
  Profile,
  ProfileBinding,
  ProfileProposal,
} from "./types.js";

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
  targetResolver: z.object({
    file: z.string().regex(/^resolvers\/[a-z0-9-]+\.js$/),
    language: z.literal("javascript"),
  }).strict().optional(),
}).strict();
const bindingsSchema = z.record(z.string().min(1), z.object({
  fingerprint: z.string().length(64),
  policyRevision: z.string().min(1),
  profileId: profileIdSchema,
}).strict());
const auditEntriesSchema = z.array(z.record(z.string(), z.unknown()));
const authorizationTestsSchema = z.array(z.object({
  expected: z.enum(["allow", "deny", "abstain"]),
  name: z.string().min(1),
  request: z.object({
    action: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    resource: z.string().min(1),
    threadId: z.string().min(1),
  }).strict(),
}).strict()).min(1);

type DiskProfile = z.infer<typeof diskProfileSchema>;

function readCommittedFile(
  root: string,
  revision: string,
  relativePath: string,
): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, "show", `${revision}:${relativePath}`],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `policy revision ${revision} does not contain ${relativePath}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
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

export class PolicyRepository {
  constructor(readonly root: string) {}

  async loadProfile(profileId: string): Promise<Profile> {
    profileIdSchema.parse(profileId);
    const file = join(this.root, "profiles", `${profileId}.json`);
    const candidate: unknown = JSON.parse(await readFile(file, "utf8"));
    const profile = parseProfile(candidate, file);
    if (profile.id !== profileId) {
      throw new Error(`${file} does not match its requested profile ID`);
    }

    const targetResolver = profile.targetResolver && {
      ...profile.targetResolver,
      file: join(this.root, profile.targetResolver.file),
    };
    return {
      ...profile,
      allowedTargets: new Set(profile.allowedTargets),
      targetResolver,
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
    policyRevisionSchema.parse(policyRevision);
    await this.initialize();
    const proposalFile = `proposals/${profileId}.json`;
    const candidate: unknown = JSON.parse(readCommittedFile(
      this.root,
      policyRevision,
      proposalFile,
    ));
    const profile = parseProfile(candidate, proposalFile);
    if (profile.id !== profileId) {
      throw new Error(`${proposalFile} does not match its requested profile ID`);
    }
    await this.#verifyProposalTests(profile, profileId, policyRevision);
    const reviewedProfile = { ...profile, policyRevision };
    await writeFile(
      join(this.root, "profiles", `${profileId}.json`),
      `${JSON.stringify(reviewedProfile, null, 2)}\n`,
      "utf8",
    );
  }

  async readState(): Promise<Record<string, ProfileBinding>> {
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

  async writeState(bindings: Readonly<Record<string, ProfileBinding>>): Promise<void> {
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

  async #verifyProposalTests(
    profile: DiskProfile,
    profileId: string,
    policyRevision: string,
  ): Promise<void> {
    const testFile = `tests/${profileId}.json`;
    const candidate: unknown = JSON.parse(readCommittedFile(
      this.root,
      policyRevision,
      testFile,
    ));
    const tests = authorizationTestsSchema.parse(candidate);
    const reviewedProfile: Profile = {
      ...profile,
      allowedTargets: new Set(profile.allowedTargets),
      policyRevision,
    };
    for (const authorizationTest of tests) {
      const core = new PolicyCore();
      core.activate(reviewedProfile, authorizationTest.request.threadId);
      const result = core.evaluate(authorizationTest.request);
      if (result.decision !== authorizationTest.expected) {
        throw new Error(`authorization test failed: ${authorizationTest.name}`);
      }
    }
  }
}
