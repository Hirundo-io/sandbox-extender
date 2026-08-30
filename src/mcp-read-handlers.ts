import { PolicyRepository } from "./policy-repository.js";
import { getActiveProfileStatus } from "./policy-service.js";

export type McpTextResult = {
  readonly content: { type: "text"; text: string }[];
};

function text(value: string): McpTextResult {
  return { content: [{ type: "text", text: value }] };
}

export async function listProfilesHandler(repository: PolicyRepository): Promise<McpTextResult> {
  return text(JSON.stringify(await repository.listVerifiedProfiles()));
}

export async function getActiveProfileHandler(
  repository: PolicyRepository,
  threadId: string,
): Promise<McpTextResult> {
  return text(JSON.stringify(await getActiveProfileStatus(repository, threadId)));
}
