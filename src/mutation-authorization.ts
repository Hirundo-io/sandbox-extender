import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const authorizationSchema = z.object({
  nonce: z.string().uuid(),
  threadId: z.string().min(1),
}).strict();

function authorizationFile(root: string): string {
  return join(root, "state", "mutation-authorization.json");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

/**
 * Creates one host-confirmed mutation authorization outside the MCP server.
 * The next mutating MCP call for this thread consumes the artifact.
 */
export async function authorizeProfileMutation(
  root: string,
  threadId: string,
): Promise<void> {
  const file = authorizationFile(root);
  await mkdir(join(root, "state"), { recursive: true });
  await Bun.write(file, `${JSON.stringify({ nonce: randomUUID(), threadId })}\n`);
}

/** Consumes the one-time authorization created by the user-facing CLI. */
export async function consumeProfileMutationAuthorization(
  root: string,
  threadId: string,
): Promise<void> {
  const file = authorizationFile(root);
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("a user mutation authorization is required");
    }
    throw error;
  }
  const authorization = authorizationSchema.parse(candidate);
  if (authorization.threadId !== threadId) {
    throw new Error("mutation authorization belongs to another thread");
  }
  await rm(file);
}
