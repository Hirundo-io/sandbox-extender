import type {
  CedarGrouping,
  DecisionToken,
  EvaluationResult,
  NormalizedRequest,
  Profile,
} from "./types.js";
import { evaluateCedarGrouping } from "./cedar.js";
import { parseShellCommands } from "./shell-parser.js";
import { relative, resolve } from "node:path";

type ActiveProfile = {
  readonly profile: Profile;
  readonly threadId: string;
};

function resolveProfileTarget(
  profile: Profile,
  request: NormalizedRequest,
): NormalizedRequest | undefined {
  if (!profile.targetResolver) return request;
  try {
    const process = Bun.spawnSync({
      cmd: ["bun", profile.targetResolver.file],
      stdin: new TextEncoder().encode(JSON.stringify({
        localTarget: request.resource,
        requestArguments: request.arguments,
      })),
      stderr: "ignore",
      stdout: "pipe",
    });
    const resource = new TextDecoder().decode(process.stdout).trim();
    return process.exitCode === 0 && resource.length > 0
      ? { ...request, resource }
      : undefined;
  } catch {
    return undefined;
  }
}

function evaluateCommand(
  profile: Profile,
  request: NormalizedRequest,
): EvaluationResult {
  const context = {
    policyRevision: profile.policyRevision,
    profileId: profile.id,
    request,
    resolvedTarget: request.resource,
  };
  for (const grouping of profile.groupings) {
    const decision = isCedarGrouping(grouping)
      ? evaluateCedarGrouping(grouping, context)
      : grouping.evaluate(context);
    if (decision === "abstain") continue;
    if (decision === "allow") {
      return {
        decision,
        matchedGroupingId: grouping.id,
        reason: "allowed by capability grouping",
      };
    }
    return {
      decision,
      matchedGroupingId: grouping.id,
      reason: "denied by capability grouping",
    };
  }
  return { decision: "abstain", reason: "no grouping made a decision" };
}

function shellCommands(request: NormalizedRequest): string[] | undefined {
  const command = request.arguments.command;
  if (!isShellAction(request.action)) return [""];
  if (typeof command !== "string" || command.trim().length === 0) {
    return undefined;
  }
  return parseShellCommands(command);
}

function isShellAction(action: string): boolean {
  return action.endsWith(".Bash") || action.endsWith(".unified_exec");
}

function isHarmlessShellBuiltin(command: string): boolean {
  return /^(?::|true|false|pwd|echo|printf|test)(?:\s|$)/.test(command);
}

function changeDirectory(
  root: string,
  currentDirectory: string,
  command: string,
): string | undefined {
  const match = command.match(/^cd(?:\s+([^\s]+))?$/);
  if (!match) return undefined;
  const next = resolve(currentDirectory, match[1] ?? ".");
  const path = relative(root, next);
  return path === "" || (!path.startsWith("..") && !path.includes("/../"))
    ? next
    : undefined;
}

function isCedarGrouping(
  grouping: Profile["groupings"][number],
): grouping is CedarGrouping {
  return "policies" in grouping;
}

function sameRequest(
  left: NormalizedRequest,
  right: NormalizedRequest,
): boolean {
  return (
    left.action === right.action &&
    left.resource === right.resource &&
    left.threadId === right.threadId &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments)
  );
}

/**
 * Coordinates profile activation, ordered capability evaluation, and one-time
 * authorization tokens. It intentionally does not execute agent requests.
 */
export class PolicyCore {
  readonly #activeProfiles = new Map<string, ActiveProfile>();
  readonly #tokens = new Map<string, DecisionToken>();

  constructor(private readonly tokenLifetimeMs = 60_000) {
    if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs <= 0) {
      throw new Error("tokenLifetimeMs must be a positive safe integer");
    }
  }

  activate(profile: Profile, threadId: string): void {
    if (!threadId) {
      throw new Error("threadId is required");
    }

    this.#activeProfiles.set(threadId, { profile, threadId });
  }

  disable(threadId: string): void {
    this.#activeProfiles.delete(threadId);
  }

  evaluate(request: NormalizedRequest): EvaluationResult {
    const activeProfile = this.#activeProfiles.get(request.threadId);
    if (!activeProfile) {
      return { decision: "abstain", reason: "no active profile for thread" };
    }

    const { profile } = activeProfile;
    const commands = shellCommands(request);
    if (!commands) {
      return { decision: "abstain", reason: "shell syntax cannot be authorized safely" };
    }

    const matchedGroupingIds: string[] = [];
    const resolvedTargets: string[] = [];
    const rootDirectory = request.resource;
    let workingDirectory = rootDirectory;
    for (const command of commands) {
      if (command.startsWith("cd")) {
        const nextDirectory = changeDirectory(rootDirectory, workingDirectory, command);
        if (!nextDirectory) {
          return { decision: "abstain", reason: "directory change is outside the request scope" };
        }
        workingDirectory = nextDirectory;
        continue;
      }
      if (isHarmlessShellBuiltin(command)) continue;
      const commandRequest = {
        ...request,
        arguments: { ...request.arguments, command },
      };
      const resolvedRequest = resolveProfileTarget(profile, commandRequest);
      if (!resolvedRequest) {
        return { decision: "abstain", reason: "profile could not resolve the request target" };
      }
      if (!profile.allowedTargets.has(resolvedRequest.resource)) {
        return {
          decision: "abstain",
          reason: "resolved target is outside the allowed target set",
        };
      }
      const result = evaluateCommand(profile, resolvedRequest);
      if (result.decision !== "allow") return result;
      if (result.matchedGroupingId) matchedGroupingIds.push(result.matchedGroupingId);
      resolvedTargets.push(resolvedRequest.resource);
    }

    const targets = resolvedTargets.length > 0 ? resolvedTargets : [request.resource];
    const token = this.#issueToken(request, profile.policyRevision, targets);
    return {
      decision: "allow",
      matchedGroupingId: matchedGroupingIds.at(-1),
      matchedGroupingIds,
      reason: "allowed by capability grouping",
      resolvedTarget: targets.at(-1),
      resolvedTargets: targets,
      token,
    };
  }

  consumeToken(tokenId: string, request: NormalizedRequest): boolean {
    const token = this.#tokens.get(tokenId);
    this.#tokens.delete(tokenId);
    const activeProfile = this.#activeProfiles.get(request.threadId);
    const resolvedRequest = activeProfile && resolveProfileTarget(
      activeProfile.profile,
      request,
    );

    return Boolean(
      token &&
        activeProfile &&
        resolvedRequest &&
        token.expiresAt.getTime() > Date.now() &&
        token.policyRevision === activeProfile.profile.policyRevision &&
        token.resolvedTargets.includes(resolvedRequest.resource) &&
        sameRequest(token.request, request),
    );
  }

  #issueToken(
    request: NormalizedRequest,
    policyRevision: string,
    resolvedTargets: readonly string[],
  ): DecisionToken {
    const token: DecisionToken = {
      expiresAt: new Date(Date.now() + this.tokenLifetimeMs),
      id: crypto.randomUUID(),
      policyRevision,
      request,
      resolvedTarget: resolvedTargets.at(-1)!,
      resolvedTargets,
    };
    this.#tokens.set(token.id, token);
    return token;
  }
}
