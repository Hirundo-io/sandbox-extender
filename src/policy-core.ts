import type {
  CedarGrouping,
  DecisionToken,
  EvaluationResult,
  NormalizedRequest,
  Profile,
} from "./types.js";
import { evaluateCedarGrouping } from "./cedar.js";
import { parseShellCommands } from "./shell-parser.js";

type ActiveProfile = {
  readonly profile: Profile;
  readonly threadId: string;
};

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
    const resolvedRequest = resolveProfileTarget(profile, request);
    if (!resolvedRequest) {
      return { decision: "abstain", reason: "profile could not resolve the request target" };
    }
    if (!profile.allowedTargets.has(resolvedRequest.resource)) {
      return {
        decision: "abstain",
        reason: "resolved target is outside the allowed target set",
      };
    }

    const commands = shellCommands(resolvedRequest);
    if (!commands) {
      return { decision: "abstain", reason: "shell syntax cannot be authorized safely" };
    }

    let matchedGroupingId: string | undefined;
    for (const command of commands) {
      if (isHarmlessShellBuiltin(command)) continue;
      const commandRequest = {
        ...resolvedRequest,
        arguments: { ...resolvedRequest.arguments, command },
      };
      const result = evaluateCommand(profile, commandRequest);
      if (result.decision !== "allow") return result;
      matchedGroupingId = result.matchedGroupingId;
    }

    const token = this.#issueToken(resolvedRequest, profile.policyRevision);
    return {
      decision: "allow",
      matchedGroupingId,
      reason: "allowed by capability grouping",
      token,
    };
  }

  consumeToken(tokenId: string, request: NormalizedRequest): boolean {
    const token = this.#tokens.get(tokenId);
    this.#tokens.delete(tokenId);

    return Boolean(
      token &&
        token.expiresAt.getTime() > Date.now() &&
        sameRequest(token.request, request),
    );
  }

  #issueToken(
    request: NormalizedRequest,
    policyRevision: string,
  ): DecisionToken {
    const token: DecisionToken = {
      expiresAt: new Date(Date.now() + this.tokenLifetimeMs),
      id: crypto.randomUUID(),
      policyRevision,
      request,
      resolvedTarget: request.resource,
    };
    this.#tokens.set(token.id, token);
    return token;
  }
}

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

/**
 * Extracts simple-command units from portable Bash/Zsh syntax. Quotes, nested
 * substitutions, control-flow keywords, functions, and pipelines are handled
 * without executing the script. Redirections and heredocs remain fail-closed.
 */
function shellCommands(request: NormalizedRequest): string[] | undefined {
  const command = request.arguments.command;
  if (typeof command !== "string") return [""];
  return parseShellCommands(command);
}

function isHarmlessShellBuiltin(command: string): boolean {
  return /^(?:cd|:|true|false|pwd|echo|printf|test)(?:\s|$)/.test(command);
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
