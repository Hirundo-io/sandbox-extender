import { z } from "zod";

export const hostSchema = z.enum(["claude", "codex"]);
export const profileIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const nonEmptyStringSchema = z.string().min(1);
export const requestArgumentsSchema = z.record(z.string(), z.unknown());
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
