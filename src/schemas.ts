import { z } from "zod";

export const hostSchema = z.enum(["claude", "codex"]);
export const profileIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const nonEmptyStringSchema = z.string().min(1);
export const policyRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "policyRevision must be a full Git commit ID");
const materializerPermissionEntrySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(","), "permission entries must not contain commas");
export const materializerPermissionManifestSchema = z
  .object({
    env: z.array(materializerPermissionEntrySchema),
    ffi: z.array(materializerPermissionEntrySchema),
    net: z.array(materializerPermissionEntrySchema),
    read: z.array(materializerPermissionEntrySchema),
    run: z.array(materializerPermissionEntrySchema),
    sys: z.array(materializerPermissionEntrySchema),
    write: z.array(materializerPermissionEntrySchema),
  })
  .strict();
const materializerReferenceShape = {
  integrity: z.string().regex(/^[0-9a-f]{64}$/),
  language: z.literal("typescript"),
  permissions: materializerPermissionManifestSchema,
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
};
export const activationMaterializerSchema = z
  .object({
    file: z.string().regex(/^materializers\/activation\/[a-z0-9-]+\.ts$/),
    ...materializerReferenceShape,
  })
  .strict();
export const requestMaterializerSchema = z
  .object({
    file: z.string().regex(/^materializers\/requests\/[a-z0-9-]+\.ts$/),
    ...materializerReferenceShape,
  })
  .strict();
export const requestArgumentsSchema = z.record(z.string(), z.unknown());
export const cedarGroupingSchema = z
  .object({
    id: nonEmptyStringSchema,
    policies: z.record(
      nonEmptyStringSchema,
      z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema).min(1)]),
    ),
  })
  .strict();
export const authorizationTestSchema = z
  .object({
    activationArguments: requestArgumentsSchema.optional(),
    expected: z.enum(["allow", "deny", "abstain"]),
    name: nonEmptyStringSchema,
    request: z
      .object({
        action: nonEmptyStringSchema,
        arguments: requestArgumentsSchema,
        resource: nonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();
export const normalizedRequestSchema = z
  .object({
    action: nonEmptyStringSchema,
    arguments: requestArgumentsSchema,
    resource: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
  })
  .strict();
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
