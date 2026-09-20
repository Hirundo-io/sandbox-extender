import { z } from "zod";

import {
  authorizationTestSchema,
  cedarGroupingSchema,
  materializerPermissionManifestSchema,
  nonEmptyStringSchema,
  policyRevisionSchema,
  profileIdSchema,
  requestArgumentsSchema,
} from "./schemas.js";

const emptyArgumentsSchema = z.object({}).strict();
const authoredMaterializerSchema = z
  .object({
    permissions: materializerPermissionManifestSchema,
    runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    source: z.string().min(1),
  })
  .strict();
export const completeProfileSchema = z
  .object({
    allowedTargets: z.array(nonEmptyStringSchema),
    activationMaterializer: authoredMaterializerSchema.optional(),
    groupings: z.array(cedarGroupingSchema).min(1),
    id: profileIdSchema,
    policyRevision: z.literal("pending-review"),
    requestMaterializer: authoredMaterializerSchema.optional(),
    sessionContext: z.array(nonEmptyStringSchema).optional(),
    targetScope: z.literal("single").optional(),
  })
  .strict();
export const completeProfileProposalArgumentsSchema = z
  .object({ profile: completeProfileSchema, tests: z.array(authorizationTestSchema).min(1) })
  .strict();

const mutationIntentSchema = z.discriminatedUnion("operation", [
  z
    .object({
      arguments: emptyArgumentsSchema,
      operation: z.literal("initialize_policy_repository"),
    })
    .strict(),
  z
    .object({
      arguments: completeProfileProposalArgumentsSchema,
      operation: z.literal("propose_complete_profile"),
    })
    .strict(),
  z
    .object({
      arguments: z
        .object({
          action: nonEmptyStringSchema,
          arguments: requestArgumentsSchema,
          profileId: profileIdSchema,
          resource: nonEmptyStringSchema,
        })
        .strict(),
      operation: z.literal("propose_profile"),
    })
    .strict(),
  z
    .object({
      arguments: z
        .object({ policyRevision: policyRevisionSchema, profileId: profileIdSchema })
        .strict(),
      operation: z.literal("promote_profile"),
    })
    .strict(),
  z
    .object({
      arguments: z
        .object({ arguments: requestArgumentsSchema, profileId: profileIdSchema })
        .strict(),
      operation: z.literal("activate_profile"),
    })
    .strict(),
  z.object({ arguments: emptyArgumentsSchema, operation: z.literal("disable_profile") }).strict(),
]);

export type ProfileMutationIntent = z.infer<typeof mutationIntentSchema>;

export function parseProfileMutationIntent(candidate: unknown): ProfileMutationIntent {
  return mutationIntentSchema.parse(candidate);
}
