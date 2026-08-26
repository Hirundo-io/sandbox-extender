import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse, stringify } from "yaml";
import { z } from "zod";

import { PolicyCore } from "./policy-core.js";
import {
  policyRevisionSchema,
  profileIdSchema,
  pullRequestBindingSchema,
  targetResolverSchema,
} from "./schemas.js";
import {
  materializePullRequestProfile,
  materializePullRequestProfileForTarget,
} from "./pull-request-binding.js";
import type { PullRequestCommandRunner } from "./pull-request-binding.js";
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
  targetScope: z.literal("single").optional(),
  targetResolver: targetResolverSchema.optional(),
}).strict();
const diskProposalSchema = diskProfileSchema.extend({
  policyRevision: z.literal("pending-review"),
  pullRequestBinding: pullRequestBindingSchema.optional(),
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
type DiskProposal = z.infer<typeof diskProposalSchema>;

function verifyCommitRevision(root: string, revision: string): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, "cat-file", "-t", revision],
    stderr: "pipe",
    stdout: "pipe",
  });
  const objectType = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0 || objectType !== "commit") {
    throw new Error(`policy revision ${revision} is not a Git commit`);
  }
}

function readCommittedFile(
  root: string,
  revision: string,
  relativePath: string,
): string {
  verifyCommitRevision(root, revision);
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

function parseProposal(candidate: unknown, file: string): DiskProposal {
  const result = diskProposalSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`${file} is not a valid policy proposal`, { cause: result.error });
  }
  return result.data;
}

function reconstructReviewedProfile(
  root: string,
  profileId: string,
  liveProfile: DiskProfile,
): DiskProfile {
  policyRevisionSchema.parse(liveProfile.policyRevision);
  const proposalFile = `proposals/${profileId}.json`;
  const candidate: unknown = JSON.parse(readCommittedFile(
    root,
    liveProfile.policyRevision,
    proposalFile,
  ));
  const proposal = parseProposal(candidate, proposalFile);
  if (proposal.id !== profileId) {
    throw new Error(`${proposalFile} does not match its requested profile ID`);
  }

  const reviewedProfile: DiskProfile = proposal.pullRequestBinding
    ? materializePullRequestProfileForTarget(
      { ...proposal, pullRequestBinding: proposal.pullRequestBinding },
      liveProfile.allowedTargets[0] ?? "",
    )
    : proposal;
  return { ...reviewedProfile, policyRevision: liveProfile.policyRevision };
}

function verifyReviewedProfile(
  root: string,
  profileId: string,
  liveProfile: DiskProfile,
): void {
  const reviewedProfile = reconstructReviewedProfile(root, profileId, liveProfile);
  if (!isDeepStrictEqual(liveProfile, reviewedProfile)) {
    throw new Error(`profile ${profileId} does not match policy revision ${liveProfile.policyRevision}`);
  }
}

async function readVerifiedResolverSource(
  root: string,
  policyRevision: string,
  relativePath: string,
): Promise<string> {
  const reviewedSource = readCommittedFile(root, policyRevision, relativePath);
  const currentSource = await readFile(join(root, relativePath), "utf8");
  if (currentSource !== reviewedSource) {
    throw new Error(`resolver ${relativePath} does not match policy revision ${policyRevision}`);
  }
  return reviewedSource;
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
  constructor(
    readonly root: string,
    private readonly pullRequestCommandRunner?: PullRequestCommandRunner,
  ) {}

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

  async loadVerifiedProfile(profileId: string): Promise<Profile> {
    profileIdSchema.parse(profileId);
    const file = join(this.root, "profiles", `${profileId}.json`);
    const candidate: unknown = JSON.parse(await readFile(file, "utf8"));
    const diskProfile = parseProfile(candidate, file);
    if (diskProfile.id !== profileId) {
      throw new Error(`${file} does not match its requested profile ID`);
    }
    if (diskProfile.policyRevision === "pending-review") {
      throw new Error("profile must be reviewed before activation");
    }
    verifyReviewedProfile(this.root, profileId, diskProfile);
    const profile = await this.loadProfile(profileId);
    if (!profile.targetResolver) return profile;
    const relativePath = relative(this.root, profile.targetResolver.file);
    const reviewedSource = await readVerifiedResolverSource(
      this.root,
      diskProfile.policyRevision,
      relativePath,
    );
    return {
      ...profile,
      targetResolver: { ...profile.targetResolver, reviewedSource },
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
    const proposal = parseProposal(candidate, proposalFile);
    if (proposal.id !== profileId) {
      throw new Error(`${proposalFile} does not match its requested profile ID`);
    }
    const profile: DiskProfile = proposal.pullRequestBinding
      ? materializePullRequestProfile(
        { ...proposal, pullRequestBinding: proposal.pullRequestBinding },
        this.pullRequestCommandRunner,
      )
      : proposal;
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
    bindingsSchema.parse(bindings);
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
    const targetResolver = profile.targetResolver && {
      ...profile.targetResolver,
      file: join(this.root, profile.targetResolver.file),
      reviewedSource: readCommittedFile(
        this.root,
        policyRevision,
        profile.targetResolver.file,
      ),
    };
    const reviewedProfile: Profile = {
      ...profile,
      allowedTargets: new Set(profile.allowedTargets),
      policyRevision,
      targetResolver,
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
