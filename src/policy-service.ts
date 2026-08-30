import { createHash } from "node:crypto";
import { PolicyCore } from "./policy-core.js";
import { PolicyRepository, ProfileStaleError } from "./policy-repository.js";
import { materializeActivation } from "./materializer-runtime.js";
import type { EvaluationResult, NormalizedRequest, Profile } from "./types.js";

export type PreparedProfileActivation = {
  readonly profile: Profile;
  readonly targets: readonly string[];
};

export type ActiveProfileStatus =
  | { readonly status: "active"; readonly profileId: string; readonly policyRevision: string; readonly allowedTargets: readonly string[] }
  | { readonly status: "inactive"; readonly reason: "no active profile for thread" }
  | { readonly status: "stale"; readonly profileId: string; readonly policyRevision: string; readonly allowedTargets: readonly string[]; readonly reason: "active profile no longer matches review" }
  | { readonly status: "unavailable"; readonly reason: "policy repository is unavailable" };

type LoadedActiveProfile =
  | { readonly status: "active"; readonly binding: import("./types.js").ProfileBinding; readonly profile: Profile }
  | Exclude<ActiveProfileStatus, { readonly status: "active" }>;

const credentialOptionPattern = /(^|\s)(--(?:access[-_]?key|access[-_]?token|api[-_]?key|api[-_]?token|authorization|client[-_]?secret|connection[-_]?string|cookie|database[-_]?url|password|passwd|private[-_]?token|refresh[-_]?token|secret|token|webhook[-_]?secret))(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const credentialAssignmentPattern = /(^|\s)([A-Za-z_][A-Za-z0-9_]*(?:ACCESS[-_]?(?:KEY|TOKEN)|ACCOUNT[-_]?KEY|API[-_]?KEY|API[-_]?TOKEN|AUTH(?:ORIZATION)?|CLIENT[-_]?SECRET|CONNECTION[-_]?STRING|COOKIE|CREDENTIAL|DATABASE[-_]?URL|PASSWORD|PASSWD|PRIVATE[-_]?TOKEN|REFRESH[-_]?TOKEN|SECRET|SHARED[-_]?ACCESS[-_]?KEY|TOKEN|WEBHOOK[-_]?SECRET)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;
const credentialUrlPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi;
const credentialQueryParameterPattern = /([?&](?:access[-_]?key|access[-_]?token|account[-_]?key|api[-_]?key|api[-_]?token|client[-_]?secret|password|secret|shared[-_]?access[-_]?key|token|webhook[-_]?secret)=)[^&#\s]+/gi;
const connectionStringSecretPattern = /(\b(?:AccountKey|AccessKey|ApiKey|ClientSecret|Password|Pwd|Secret|SharedAccessKey|Token)\s*=\s*)("[^"]*"|'[^']*'|[^;\s]+)/gi;
const githubTokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;
const gitlabTokenPattern = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const pypiTokenPattern = /\bpypi-[A-Za-z0-9_-]{20,}\b/g;
const slackTokenPattern = /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/g;
const stripeSecretPattern = /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})\b/g;
const awsAccessKeyIdPattern = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const openAiTokenPattern = /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/g;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/g;
const privateKeyPattern = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
const headerOptionPattern = /(^|\s)(-H|--header)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const standaloneHeaderPattern = /(^|[\n,])(\s*)(Authorization|Cookie|Gitlab-Token|Private-Token|Proxy-Authorization|Set-Cookie|Stripe-Signature|X-Access-Token|X-Amz-Security-Token|X-Api-Key|X-Auth-Token|X-Gitlab-Token|X-Hub-Signature(?:-256)?|X-Slack-Signature|X-Webhook-(?:Secret|Token))\s*:\s*[^\r\n,]*/gi;
const sensitiveHeaderNames = new Set([
  "authorization",
  "cookie",
  "gitlab-token",
  "private-token",
  "proxy-authorization",
  "set-cookie",
  "stripe-signature",
  "x-access-token",
  "x-amz-security-token",
  "x-api-key",
  "x-auth-token",
  "x-gitlab-token",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-slack-signature",
  "x-webhook-secret",
  "x-webhook-token",
]);
const credentialKeys = new Set([
  "access-key",
  "access-token",
  "account-key",
  "api-key",
  "api-token",
  "authorization",
  "authentication",
  "client-secret",
  "connection-string",
  "cookie",
  "credential",
  "credentials",
  "database-url",
  "password",
  "passwd",
  "private-key",
  "private-token",
  "refresh-token",
  "secret",
  "secret-key",
  "shared-access-key",
  "signing-key",
  "ssh-key",
  "token",
  "webhook-secret",
]);
const credentialKeySuffixes = [
  "access-key",
  "access-token",
  "account-key",
  "api-key",
  "api-token",
  "client-secret",
  "connection-string",
  "database-url",
  "password",
  "private-key",
  "private-token",
  "refresh-token",
  "secret",
  "secret-key",
  "shared-access-key",
  "signing-key",
  "token",
  "webhook-secret",
];
const maxAuditJsonStringLength = 64 * 1024;
const maxAuditRedactionDepth = 16;
const redactedDeeplyNestedValue = "[redacted deeply nested audit value]";
const redactedOversizedJson = "[redacted oversized JSON]";

type AuditValueRedactor = (value: unknown, depth: number) => unknown;

function isCredentialKey(key: string): boolean {
  const canonicalKey = key
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return credentialKeys.has(canonicalKey) || credentialKeySuffixes.some((suffix) =>
    canonicalKey.endsWith(`-${suffix}`),
  );
}

function isSensitiveHeaderName(value: unknown): value is string {
  return typeof value === "string" && sensitiveHeaderNames.has(value.trim().toLowerCase());
}

function redactHeaderOption(
  _match: string,
  leadingWhitespace: string,
  option: string,
  separator: string,
  value: string,
): string {
  const quote = value.startsWith("\"") || value.startsWith("'") ? value[0] : "";
  const header = quote ? value.slice(1, -1) : value;
  const colon = header.indexOf(":");
  if (colon === -1 || !isSensitiveHeaderName(header.slice(0, colon))) {
    return `${leadingWhitespace}${option}${separator}${value}`;
  }
  const redactedHeader = `${header.slice(0, colon)}: [redacted]`;
  return `${leadingWhitespace}${option}${separator}${quote}${redactedHeader}${quote}`;
}

function redactSecretsInString(value: string): string {
  return value
    .replace(privateKeyPattern, "[redacted private key]")
    .replace(credentialOptionPattern, "$1$2 [redacted]")
    .replace(credentialAssignmentPattern, "$1$2=[redacted]")
    .replace(headerOptionPattern, redactHeaderOption)
    .replace(standaloneHeaderPattern, "$1$2$3: [redacted]")
    .replace(credentialUrlPattern, "$1[redacted]@")
    .replace(credentialQueryParameterPattern, "$1[redacted]")
    .replace(connectionStringSecretPattern, "$1[redacted]")
    .replace(githubTokenPattern, "[redacted GitHub token]")
    .replace(gitlabTokenPattern, "[redacted GitLab token]")
    .replace(pypiTokenPattern, "[redacted PyPI token]")
    .replace(slackTokenPattern, "[redacted Slack token]")
    .replace(stripeSecretPattern, "[redacted Stripe secret]")
    .replace(awsAccessKeyIdPattern, "[redacted AWS access key ID]")
    .replace(openAiTokenPattern, "[redacted OpenAI token]")
    .replace(jwtPattern, "[redacted JWT]");
}

function redactJsonString(
  value: string,
  depth: number,
  redactValue: AuditValueRedactor,
): string | undefined {
  const trimmedValue = value.trim();
  const isJsonContainer = (trimmedValue.startsWith("{") && trimmedValue.endsWith("}")) ||
    (trimmedValue.startsWith("[") && trimmedValue.endsWith("]"));
  if (!isJsonContainer) return undefined;
  if (value.length > maxAuditJsonStringLength) return redactedOversizedJson;
  if (depth >= maxAuditRedactionDepth) return redactedDeeplyNestedValue;

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    return undefined;
  }

  const leadingWhitespaceLength = value.length - value.trimStart().length;
  const trailingWhitespaceLength = value.length - value.trimEnd().length;
  const leadingWhitespace = value.slice(0, leadingWhitespaceLength);
  const trailingWhitespace = trailingWhitespaceLength === 0
    ? ""
    : value.slice(value.length - trailingWhitespaceLength);
  return `${leadingWhitespace}${JSON.stringify(redactValue(parsedValue, depth + 1))}${trailingWhitespace}`;
}

function redactHeaders(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= maxAuditRedactionDepth) return redactedDeeplyNestedValue;
    return value.map((item, index) =>
      index > 0 && isSensitiveHeaderName(value[index - 1])
        ? "[redacted]"
        : redactAuditArguments(item, depth + 1),
    );
  }
  if (typeof value === "object" && value !== null) {
    if (depth >= maxAuditRedactionDepth) return redactedDeeplyNestedValue;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveHeaderName(key) ? "[redacted]" : redactAuditArguments(item, depth + 1),
      ]),
    );
  }
  return redactAuditArguments(value, depth);
}

function redactAuditArguments(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return redactJsonString(value, depth, redactAuditArguments) ?? redactSecretsInString(value);
  }
  if (Array.isArray(value)) {
    if (depth >= maxAuditRedactionDepth) return redactedDeeplyNestedValue;
    return value.map((item) => redactAuditArguments(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= maxAuditRedactionDepth) return redactedDeeplyNestedValue;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isCredentialKey(key) ? "[redacted]" : key.toLowerCase() === "headers"
          ? redactHeaders(item, depth + 1)
          : redactAuditArguments(item, depth + 1),
      ]),
    );
  }
  return "[unsupported audit value]";
}

function fingerprint(profile: import("./types.js").Profile): string {
  return createHash("sha256").update(JSON.stringify({
    allowedTargets: [...profile.allowedTargets].sort(),
    groupings: profile.groupings,
    id: profile.id,
    policyRevision: profile.policyRevision,
    sessionContext: profile.sessionContext ?? [],
    targetScope: profile.targetScope,
    activationMaterializer: profile.activationMaterializer,
    requestMaterializer: profile.requestMaterializer,
  })).digest("hex");
}

function staleProfileStatus(
  binding: import("./types.js").ProfileBinding,
): Extract<ActiveProfileStatus, { readonly status: "stale" }> {
  return {
    status: "stale",
    profileId: binding.profileId,
    policyRevision: binding.policyRevision,
    allowedTargets: binding.allowedTargets.map(redactSecretsInString),
    reason: "active profile no longer matches review",
  };
}

async function loadActiveProfile(
  repository: PolicyRepository,
  threadId: string,
): Promise<LoadedActiveProfile> {
  let binding: import("./types.js").ProfileBinding | undefined;
  try {
    binding = (await repository.readState())[threadId];
  } catch {
    return { status: "unavailable", reason: "policy repository is unavailable" };
  }
  if (!binding) {
    return { status: "inactive", reason: "no active profile for thread" };
  }

  try {
    const reviewedProfile = await repository.loadVerifiedProfile(binding.profileId);
    const profile = { ...reviewedProfile, allowedTargets: new Set(binding.allowedTargets) };
    if (
      profile.policyRevision === "pending-review" ||
      profile.policyRevision !== binding.policyRevision ||
      fingerprint(profile) !== binding.fingerprint
    ) {
      return staleProfileStatus(binding);
    }
    return { status: "active", binding, profile };
  } catch (error) {
    if (error instanceof ProfileStaleError) return staleProfileStatus(binding);
    return { status: "unavailable", reason: "policy repository is unavailable" };
  }
}

export async function getActiveProfileStatus(
  repository: PolicyRepository,
  threadId: string,
): Promise<ActiveProfileStatus> {
  const activeProfile = await loadActiveProfile(repository, threadId);
  if (activeProfile.status !== "active") return activeProfile;
  return {
    status: "active",
    profileId: activeProfile.profile.id,
    policyRevision: activeProfile.profile.policyRevision,
    allowedTargets: activeProfile.binding.allowedTargets.map(redactSecretsInString),
  };
}

async function recordEvaluation(
  repository: PolicyRepository,
  request: NormalizedRequest,
  result: EvaluationResult,
  profileId?: string,
  policyRevision?: string,
): Promise<void> {
  const entry = {
    action: request.action,
    arguments: redactAuditArguments(request.arguments),
    decision: result.decision,
    event: "extension-request",
    profileId,
    policyRevision,
    reason: result.reason,
    resource: result.resolvedTarget ?? request.resource,
    resolvedTarget: result.resolvedTarget,
    resolvedTargets: result.resolvedTargets,
    matchedGroupingId: result.matchedGroupingId,
    matchedGroupingIds: result.matchedGroupingIds,
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

export async function evaluateForThread(
  repository: PolicyRepository,
  request: NormalizedRequest,
): Promise<EvaluationResult> {
  try {
    const activeProfile = await loadActiveProfile(repository, request.threadId);
    if (activeProfile.status === "inactive") {
      const result = { decision: "abstain" as const, reason: "no active profile for thread" };
      await recordEvaluation(repository, request, result);
      return result;
    }
    if (activeProfile.status === "stale") {
      const result = { decision: "abstain" as const, reason: "active profile no longer matches review" };
      await recordEvaluation(repository, request, result, activeProfile.profileId, activeProfile.policyRevision);
      return result;
    }
    if (activeProfile.status === "unavailable") {
      return { decision: "abstain", reason: "policy repository is unavailable" };
    }
    const core = new PolicyCore();
    const { profile } = activeProfile;
    core.activate(profile, request.threadId);
    const evaluated = await core.evaluate(request);
    if (evaluated.decision === "allow" && !await core.consumeToken(evaluated.token?.id ?? "", request)) {
      const result = { decision: "abstain" as const, reason: "authorization token is unavailable" };
      await recordEvaluation(repository, request, result, activeProfile.binding.profileId, profile.policyRevision);
      return result;
    }
    await recordEvaluation(repository, request, evaluated, activeProfile.binding.profileId, profile.policyRevision);
    const { token: _, ...result } = evaluated;
    return result;
  } catch {
    return { decision: "abstain", reason: "policy repository is unavailable" };
  }
}

export async function prepareProfileActivation(
  repository: PolicyRepository,
  profileId: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<PreparedProfileActivation> {
  const reviewedProfile = await repository.loadVerifiedProfile(profileId);
  if (reviewedProfile.policyRevision === "pending-review") {
    throw new Error("profile must be reviewed before activation");
  }
  const activation = reviewedProfile.activationMaterializer
    ? materializeActivation(reviewedProfile.activationMaterializer, arguments_, repository.root)
    : Object.keys(arguments_).length === 0 && reviewedProfile.allowedTargets.size > 0
      ? { targets: [...reviewedProfile.allowedTargets] }
      : undefined;
  if (!activation) throw new Error("profile activation arguments could not be materialized");
  if (reviewedProfile.targetScope === "single" && activation.targets.length !== 1) {
    throw new Error("profile activation requires exactly one target");
  }
  const profile = { ...reviewedProfile, allowedTargets: new Set(activation.targets) };
  return { profile, targets: activation.targets };
}

export async function activatePreparedProfile(
  repository: PolicyRepository,
  threadId: string,
  activation: PreparedProfileActivation,
): Promise<readonly string[]> {
  await repository.updateState((bindings) => ({ ...bindings, [threadId]: {
    allowedTargets: activation.targets,
    fingerprint: fingerprint(activation.profile),
    policyRevision: activation.profile.policyRevision,
    profileId: activation.profile.id,
  } }));
  return activation.targets;
}

export async function activateProfile(
  repository: PolicyRepository,
  threadId: string,
  profileId: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<readonly string[]> {
  return activatePreparedProfile(
    repository,
    threadId,
    await prepareProfileActivation(repository, profileId, arguments_),
  );
}

export async function disableProfile(
  repository: PolicyRepository,
  threadId: string,
): Promise<void> {
  await repository.updateState((bindings) => {
    const { [threadId]: _, ...remaining } = bindings;
    return remaining;
  });
}
