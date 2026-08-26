import { z } from "zod";

export const hostSchema = z.enum(["claude", "codex"]);
export const profileIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const nonEmptyStringSchema = z.string().min(1);
export const policyRevisionSchema = z.string().regex(
  /^[0-9a-f]{40}$/i,
  "policyRevision must be a full Git commit ID",
);
export const targetResolverSchema = z.object({
  file: z.string().regex(/^resolvers\/[a-z0-9-]+\.ts$/),
  language: z.literal("typescript"),
}).strict();
export const requestArgumentsSchema = z.record(z.string(), z.unknown());
export const pullRequestBindingSchema = z.object({
  pullRequest: z.string().regex(
    /^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*)$/,
    "pullRequest must be a PR number or owner/repository#number",
  ).optional(),
  workspace: z.string().regex(/^\//, "workspace must be an absolute path"),
}).strict();
export const normalizedRequestSchema = z.object({
  action: nonEmptyStringSchema,
  arguments: requestArgumentsSchema,
  resource: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
}).strict();
export const hookEventSchema = z.looseObject({
  cwd: nonEmptyStringSchema.optional(),
  session_id: nonEmptyStringSchema.optional(),
  tool_input: requestArgumentsSchema.optional(),
  tool_name: nonEmptyStringSchema.optional(),
  sessionId: nonEmptyStringSchema.optional(),
  toolInput: requestArgumentsSchema.optional(),
  toolName: nonEmptyStringSchema.optional(),
  working_directory: nonEmptyStringSchema.optional(),
});

export type HookEvent = z.infer<typeof hookEventSchema>;
