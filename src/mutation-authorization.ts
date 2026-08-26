import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  nonEmptyStringSchema,
  policyRevisionSchema,
  profileIdSchema,
  requestArgumentsSchema,
} from "./schemas.js";

const AUTHORIZATION_TTL_MS = 2 * 60 * 1000;

const mutationOperationSchema = z.enum([
  "initialize_policy_repository",
  "propose_profile",
  "promote_profile",
  "activate_profile",
  "disable_profile",
]);

const emptyArgumentsSchema = z.object({}).strict();

const mutationIntentSchema = z.discriminatedUnion("operation", [
  z.object({
    arguments: emptyArgumentsSchema,
    operation: z.literal("initialize_policy_repository"),
  }).strict(),
  z.object({
    arguments: z.object({
      action: nonEmptyStringSchema,
      arguments: requestArgumentsSchema,
      profileId: profileIdSchema,
      resource: nonEmptyStringSchema,
    }).strict(),
    operation: z.literal("propose_profile"),
  }).strict(),
  z.object({
    arguments: z.object({
      policyRevision: policyRevisionSchema,
      profileId: profileIdSchema,
    }).strict(),
    operation: z.literal("promote_profile"),
  }).strict(),
  z.object({
    arguments: z.object({ profileId: profileIdSchema }).strict(),
    operation: z.literal("activate_profile"),
  }).strict(),
  z.object({
    arguments: emptyArgumentsSchema,
    operation: z.literal("disable_profile"),
  }).strict(),
]);

const authorizationSchema = z.object({
  argumentsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime(),
  nonce: z.string().uuid(),
  operation: mutationOperationSchema,
  threadId: nonEmptyStringSchema,
  version: z.literal(1),
}).strict();

export type ProfileMutationIntent = z.infer<typeof mutationIntentSchema>;

export type ProfileMutationAuthorization = {
  readonly expiresAt: string;
};

function authorizationFile(root: string): string {
  return join(root, "state", "mutation-authorization.json");
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJsonValue(record[key])]),
    );
  }
  throw new Error("mutation arguments must contain only JSON values");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function argumentsDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function assertMatchingAuthorization(
  candidate: unknown,
  threadId: string,
  intent: ProfileMutationIntent,
  now: Date,
): void {
  const authorization = authorizationSchema.parse(candidate);
  if (authorization.threadId !== threadId) {
    throw new Error("mutation authorization belongs to another thread");
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new Error("mutation authorization has expired");
  }
  if (authorization.operation !== intent.operation) {
    throw new Error("mutation authorization is for another operation");
  }
  if (authorization.argumentsDigest !== argumentsDigest(intent.arguments)) {
    throw new Error("mutation authorization is for different arguments");
  }
}

export function parseProfileMutationIntent(candidate: unknown): ProfileMutationIntent {
  return mutationIntentSchema.parse(candidate);
}

/** Creates one short-lived, host-confirmed authorization outside the MCP server. */
export async function authorizeProfileMutation(
  root: string,
  threadId: string,
  intent: ProfileMutationIntent,
  now = new Date(),
): Promise<ProfileMutationAuthorization> {
  const authorization = {
    argumentsDigest: argumentsDigest(intent.arguments),
    expiresAt: new Date(now.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
    nonce: randomUUID(),
    operation: intent.operation,
    threadId: nonEmptyStringSchema.parse(threadId),
    version: 1 as const,
  };
  const file = authorizationFile(root);
  const temporaryFile = `${file}.${authorization.nonce}.tmp`;
  await mkdir(join(root, "state"), { recursive: true });
  try {
    await writeFile(temporaryFile, `${JSON.stringify(authorization)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return { expiresAt: authorization.expiresAt };
}

/** Atomically claims and consumes one authorization for the exact mutation intent. */
export async function consumeProfileMutationAuthorization(
  root: string,
  threadId: string,
  intent: ProfileMutationIntent,
  now = new Date(),
): Promise<void> {
  const file = authorizationFile(root);
  const claimedFile = `${file}.${randomUUID()}.consuming`;
  try {
    await rename(file, claimedFile);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("a user mutation authorization is required");
    }
    throw error;
  }

  try {
    const candidate: unknown = JSON.parse(await readFile(claimedFile, "utf8"));
    assertMatchingAuthorization(candidate, threadId, intent, now);
  } finally {
    await rm(claimedFile, { force: true });
  }
}
