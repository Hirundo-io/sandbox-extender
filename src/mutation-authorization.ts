import { z } from "zod";

import { nonEmptyStringSchema, policyRevisionSchema, profileIdSchema, requestArgumentsSchema } from "./schemas.js";

const emptyArgumentsSchema = z.object({}).strict();

const mutationIntentSchema = z.discriminatedUnion("operation", [
  z.object({ arguments: emptyArgumentsSchema, operation: z.literal("initialize_policy_repository") }).strict(),
  z.object({
    arguments: z.object({ action: nonEmptyStringSchema, arguments: requestArgumentsSchema, profileId: profileIdSchema, resource: nonEmptyStringSchema }).strict(),
    operation: z.literal("propose_profile"),
  }).strict(),
  z.object({
    arguments: z.object({ policyRevision: policyRevisionSchema, profileId: profileIdSchema }).strict(),
    operation: z.literal("promote_profile"),
  }).strict(),
  z.object({
    arguments: z.object({ arguments: requestArgumentsSchema, profileId: profileIdSchema }).strict(),
    operation: z.literal("activate_profile"),
  }).strict(),
  z.object({ arguments: emptyArgumentsSchema, operation: z.literal("disable_profile") }).strict(),
]);

export type ProfileMutationIntent = z.infer<typeof mutationIntentSchema>;

export function parseProfileMutationIntent(candidate: unknown): ProfileMutationIntent {
  return mutationIntentSchema.parse(candidate);
}
