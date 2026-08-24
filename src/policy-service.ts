import { createHash } from "node:crypto";
import { PolicyCore } from "./policy-core.js";
import { PolicyRepository } from "./policy-repository.js";
import type { EvaluationResult, NormalizedRequest } from "./types.js";

export async function evaluateForThread(
  repository: PolicyRepository,
  request: NormalizedRequest,
): Promise<EvaluationResult> {
  try {
    const bindings = await repository.readState();
    const binding = bindings[request.threadId];
    if (!binding) {
      const result = { decision: "abstain" as const, reason: "no active profile for thread" };
      await recordEvaluation(repository, request, result);
      return result;
    }
    const core = new PolicyCore();
    const profile = await repository.loadProfile(binding.profileId);
    if (profile.policyRevision === "pending-review" ||
      profile.policyRevision !== binding.policyRevision ||
      fingerprint(profile) !== binding.fingerprint) {
      return { decision: "abstain", reason: "active profile no longer matches review" };
    }
    core.activate(profile, request.threadId);
    const result = core.evaluate(request);
    if (result.decision === "allow" && !core.consumeToken(result.token?.id ?? "", request)) {
      return { decision: "abstain", reason: "authorization token is unavailable" };
    }
    await recordEvaluation(repository, request, result, binding.profileId);
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
  const entry = {
    action: request.action,
    decision: result.decision,
    event: "extension-request",
    profileId,
    reason: result.reason,
    resource: request.resource,
    threadId: request.threadId,
  };
  if (result.decision === "allow") {
    await repository.appendAudit(entry);
    return;
  }
  try {
    await repository.appendAudit(entry);
  } catch {
    // Abstentions never extend host authority, so their audit failure is safe.
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
  await repository.writeState({ ...bindings, [threadId]: {
    fingerprint: fingerprint(profile),
    policyRevision: profile.policyRevision,
    profileId,
  } });
}

function fingerprint(profile: import("./types.js").Profile): string {
  return createHash("sha256").update(JSON.stringify({
    allowedTargets: [...profile.allowedTargets].sort(),
    groupings: profile.groupings,
    id: profile.id,
    policyRevision: profile.policyRevision,
    sessionContext: profile.sessionContext ?? [],
    targetResolver: profile.targetResolver,
  })).digest("hex");
}

export async function disableProfile(
  repository: PolicyRepository,
  threadId: string,
): Promise<void> {
  const bindings = await repository.readState();
  const { [threadId]: _, ...remaining } = bindings;
  await repository.writeState(remaining);
}
