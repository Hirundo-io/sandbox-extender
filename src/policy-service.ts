import { PolicyCore } from "./policy-core.js";
import { PolicyRepository } from "./policy-repository.js";
import type { EvaluationResult, NormalizedRequest } from "./types.js";

export async function evaluateForThread(
  repository: PolicyRepository,
  request: NormalizedRequest,
): Promise<EvaluationResult> {
  const bindings = await repository.readState();
  const profileId = bindings[request.threadId];
  if (!profileId) {
    const result = { decision: "abstain" as const, reason: "no active profile for thread" };
    await recordEvaluation(repository, request, result);
    return result;
  }

  const core = new PolicyCore();
  try {
    core.activate(await repository.loadProfile(profileId), request.threadId);
    const result = core.evaluate(request);
    await recordEvaluation(repository, request, result, profileId);
    return result;
  } catch {
    return { decision: "abstain", reason: "policy repository is unavailable" };
  }
}

async function recordEvaluation(
  repository: PolicyRepository,
  request: NormalizedRequest,
  result: EvaluationResult,
  profileId?: string,
): Promise<void> {
  try {
    await repository.appendAudit({
      action: request.action,
      decision: result.decision,
      event: "extension-request",
      profileId,
      reason: result.reason,
      resource: request.resource,
      threadId: request.threadId,
    });
  } catch {
    // A missing policy repository cannot create an extension decision or an audit entry.
  }
}

export async function activateProfile(
  repository: PolicyRepository,
  threadId: string,
  profileId: string,
): Promise<void> {
  const profile = await repository.loadProfile(profileId);
  if (profile.policyRevision === "pending-review") {
    throw new Error("profile must be reviewed before activation");
  }
  const bindings = await repository.readState();
  await repository.writeState({ ...bindings, [threadId]: profileId });
}

export async function disableProfile(
  repository: PolicyRepository,
  threadId: string,
): Promise<void> {
  const bindings = await repository.readState();
  const { [threadId]: _, ...remaining } = bindings;
  await repository.writeState(remaining);
}
