import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse, stringify } from "yaml";
import { z } from "zod";

import { PolicyCore } from "./policy-core.js";
import { verifyMaterializerIntegrity } from "./materializer-policy.js";
import { materializeActivation } from "./materializer-runtime.js";
import {
  activationMaterializerSchema,
  policyRevisionSchema,
  profileIdSchema,
  requestMaterializerSchema,
} from "./schemas.js";
import type {
  AuthorizationTest,
  ActivationMaterializer,
  Profile,
  ProfileBinding,
  ProfileProposal,
  RequestMaterializer,
} from "./types.js";

const cedarGroupingSchema = z.object({
  id: z.string().min(1),
  policies: z.record(z.string(), z.union([
    z.string(),
    z.array(z.string().min(1)).min(1),
  ])),
}).strict();
const diskProfileSchema = z.object({
  activationMaterializer: activationMaterializerSchema.optional(),
  allowedTargets: z.array(z.string().min(1)),
  groupings: z.array(cedarGroupingSchema),
  id: profileIdSchema,
  policyRevision: z.string().min(1),
  sessionContext: z.array(z.string().min(1)).optional(),
  targetScope: z.literal("single").optional(),
  requestMaterializer: requestMaterializerSchema.optional(),
}).strict();
const diskProposalSchema = diskProfileSchema.extend({
  policyRevision: z.literal("pending-review"),
}).strict();
const bindingsSchema = z.record(z.string().min(1), z.object({
  allowedTargets: z.array(z.string().min(1)).min(1),
  fingerprint: z.string().length(64),
  policyRevision: z.string().min(1),
  profileId: profileIdSchema,
}).strict());
const auditEntriesSchema = z.array(z.record(z.string(), z.unknown()));
const authorizationTestsSchema = z.array(z.object({
  activationArguments: z.record(z.string(), z.unknown()).optional(),
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

  return { ...proposal, policyRevision: liveProfile.policyRevision };
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

async function readVerifiedMaterializerSource(
  root: string,
  policyRevision: string,
  relativePath: string,
): Promise<string> {
  const reviewedSource = readCommittedFile(root, policyRevision, relativePath);
  const currentSource = await readFile(join(root, relativePath), "utf8");
  if (currentSource !== reviewedSource) {
    throw new Error(`materializer ${relativePath} does not match policy revision ${policyRevision}`);
  }
  return reviewedSource;
}

async function verifiedMaterializer<T extends ActivationMaterializer | RequestMaterializer>(
  root: string,
  policyRevision: string,
  materializer: T,
): Promise<T & { readonly reviewedSource: string }> {
  const reviewedSource = await readVerifiedMaterializerSource(
    root,
    policyRevision,
    relative(root, materializer.file),
  );
  verifyMaterializerIntegrity(materializer, reviewedSource);
  return { ...materializer, reviewedSource };
}

function committedMaterializer<T extends ActivationMaterializer | RequestMaterializer>(
  root: string,
  policyRevision: string,
  materializer: T,
): T & { readonly reviewedSource: string } {
  const reviewedSource = readCommittedFile(root, policyRevision, materializer.file);
  verifyMaterializerIntegrity(materializer, reviewedSource);
  return { ...materializer, file: join(root, materializer.file), reviewedSource };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function profileFromDisk(root: string, profile: DiskProfile): Profile {
  const activationMaterializer = profile.activationMaterializer && {
    ...profile.activationMaterializer,
    file: join(root, profile.activationMaterializer.file),
  };
  const requestMaterializer = profile.requestMaterializer && {
    ...profile.requestMaterializer,
    file: join(root, profile.requestMaterializer.file),
  };
  return {
    ...profile,
    allowedTargets: new Set(profile.allowedTargets),
    activationMaterializer,
    requestMaterializer,
  };
}

export class PolicyRepository {
  #repositoryMutation = Promise.resolve();

  constructor(readonly root: string) {}

  async loadProfile(profileId: string): Promise<Profile> {
    profileIdSchema.parse(profileId);
    const file = join(this.root, "profiles", `${profileId}.json`);
    const candidate: unknown = JSON.parse(await readFile(file, "utf8"));
    const profile = parseProfile(candidate, file);
    if (profile.id !== profileId) {
      throw new Error(`${file} does not match its requested profile ID`);
    }

    return profileFromDisk(this.root, profile);
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
    const profile = profileFromDisk(this.root, diskProfile);
    const activationMaterializer = profile.activationMaterializer &&
      await verifiedMaterializer(this.root, diskProfile.policyRevision, profile.activationMaterializer);
    const requestMaterializer = profile.requestMaterializer &&
      await verifiedMaterializer(this.root, diskProfile.policyRevision, profile.requestMaterializer);
    return {
      ...profile,
      activationMaterializer,
      requestMaterializer,
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

  async listVerifiedProfiles(): Promise<string[]> {
    const candidates = await this.listProfiles();
    const verified = await Promise.all(candidates.map(async (profileId) => {
      try {
        await this.loadVerifiedProfile(profileId);
        return profileId;
      } catch {
        return undefined;
      }
    }));
    return verified.filter((profileId): profileId is string => profileId !== undefined);
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
    await this.#verifyProposalTests(proposal, profileId, policyRevision);
    const reviewedProfile = { ...proposal, policyRevision };
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

  async updateState(
    update: (bindings: Readonly<Record<string, ProfileBinding>>) => Readonly<Record<string, ProfileBinding>>,
  ): Promise<void> {
    await this.#serializeMutation(async () => {
      await this.writeState(update(await this.readState()));
    });
  }

  async appendAudit(entry: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#serializeMutation(async () => {
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
    });
  }

  async #serializeMutation(mutation: () => Promise<void>): Promise<void> {
    const queued = this.#repositoryMutation.then(mutation);
    this.#repositoryMutation = queued.catch(() => undefined);
    await queued;
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
    const activationMaterializer = profile.activationMaterializer &&
      committedMaterializer(this.root, policyRevision, profile.activationMaterializer);
    const requestMaterializer = profile.requestMaterializer &&
      committedMaterializer(this.root, policyRevision, profile.requestMaterializer);
    for (const authorizationTest of tests) {
      const activation = activationMaterializer
        ? materializeActivation(activationMaterializer, authorizationTest.activationArguments ?? {}, this.root)
        : { targets: profile.allowedTargets };
      if (!activation) {
        throw new Error(`authorization test activation failed: ${authorizationTest.name}`);
      }
      const reviewedProfile: Profile = {
        ...profile,
        activationMaterializer,
        allowedTargets: new Set(activation.targets),
        policyRevision,
        requestMaterializer,
      };
      const core = new PolicyCore();
      core.activate(reviewedProfile, authorizationTest.request.threadId);
      const result = await core.evaluate(authorizationTest.request);
      if (result.decision !== authorizationTest.expected) {
        throw new Error(`authorization test failed: ${authorizationTest.name}`);
      }
    }
  }
}
