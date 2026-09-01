import type {
  CedarGrouping,
  DecisionToken,
  EvaluationResult,
  NormalizedRequest,
  Profile,
  ShellCommandContext,
} from "./types.js";
import { evaluateCedarGrouping } from "./cedar.js";
import { materializeRequest } from "./materializer-runtime.js";
import { compileShell, type ExecutableSegment } from "./shell-parser.js";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

type ActiveProfile = {
  readonly profile: Profile;
  readonly threadId: string;
};

const directoryOptions = new Set([
  "-C",
  "--chdir",
  "--cwd",
  "--directory",
  "--prefix",
  "--root",
  "--workdir",
  "--working-directory",
]);

type DirectoryOption = {
  readonly consumed: number;
  readonly value: string;
};

type SafeBuiltinDecision = "auto-allow" | "defer-to-policy" | "not-safe-builtin";

const automaticallyAllowedBuiltins = new Set([":", "true", "false", "pwd", "echo"]);

const unaryFilesystemTestOperators = new Set([
  "-a",
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-G",
  "-g",
  "-h",
  "-k",
  "-L",
  "-N",
  "-O",
  "-p",
  "-r",
  "-S",
  "-s",
  "-u",
  "-w",
  "-x",
]);

const binaryFilesystemTestOperators = new Set(["-ef", "-nt", "-ot"]);

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.includes("/../"));
}

function canonicalExistingAncestor(path: string): string | undefined {
  const candidates = [path];
  for (
    let candidate = path, parent = dirname(candidate);
    parent !== candidate;
    candidate = parent, parent = dirname(candidate)
  ) {
    candidates.push(parent);
  }

  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
  }
  return undefined;
}

function resolvesWithinWorkspace(
  workspace: string,
  workingDirectory: string,
  path: string,
): string | undefined {
  const candidate = resolve(workingDirectory, path);
  if (!isWithin(workspace, candidate)) return undefined;

  const canonicalWorkspace = canonicalExistingAncestor(workspace);
  const canonicalCandidate = canonicalExistingAncestor(candidate);
  return canonicalWorkspace &&
    canonicalCandidate &&
    isWithin(canonicalWorkspace, canonicalCandidate)
    ? candidate
    : undefined;
}

function isFilesystemPath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    value.includes("/./") ||
    value.includes("/../") ||
    value.endsWith("/.") ||
    value.endsWith("/..")
  );
}

function pathCandidates(argument: string): readonly string[] {
  const candidates = [argument];
  const equals = argument.indexOf("=");
  if (equals >= 0) candidates.push(argument.slice(equals + 1));

  // Many Unix tools support a single-letter option with an attached path,
  // such as -C../other-worktree or -I/usr/include.
  const attachedShortOption = argument.match(/^-[A-Za-z](?:=)?(.+)$/);
  if (attachedShortOption) candidates.push(attachedShortOption[1]);
  return candidates;
}

function directoryOption(words: readonly string[], index: number): DirectoryOption | undefined {
  const argument = words[index];
  if (directoryOptions.has(argument)) {
    const value = words[index + 1];
    return value ? { consumed: 2, value } : undefined;
  }

  for (const option of directoryOptions) {
    if (option === "-C") {
      if (argument.startsWith("-C=")) {
        return argument.length > 3 ? { consumed: 1, value: argument.slice(3) } : undefined;
      }
      if (argument.startsWith("-C") && argument.length > 2) {
        return { consumed: 1, value: argument.slice(2) };
      }
      continue;
    }
    const prefix = `${option}=`;
    if (argument.startsWith(prefix) && argument.length > prefix.length) {
      return { consumed: 1, value: argument.slice(prefix.length) };
    }
  }
  return undefined;
}

function isDirectoryOptionArgument(argument: string): boolean {
  if (directoryOptions.has(argument)) return true;
  return [...directoryOptions].some((option) =>
    option === "-C" ? argument.startsWith("-C") : argument.startsWith(`${option}=`),
  );
}

function validatesWorkspacePaths(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): boolean {
  let commandDirectory = workingDirectory;
  for (let index = 0; index < words.length; index += 1) {
    const directory = index > 0 ? directoryOption(words, index) : undefined;
    if (directory) {
      if (directory.value.startsWith("-")) return false;
      const next = resolvesWithinWorkspace(workspace, commandDirectory, directory.value);
      if (!next) return false;
      commandDirectory = next;
      index += directory.consumed - 1;
      continue;
    }
    if (index > 0 && isDirectoryOptionArgument(words[index])) return false;
    for (const candidate of pathCandidates(words[index])) {
      if (
        isFilesystemPath(candidate) &&
        !resolvesWithinWorkspace(workspace, commandDirectory, candidate)
      ) {
        return false;
      }
    }
  }
  return true;
}

function filesystemTestOperands(words: readonly string[]): readonly string[] | undefined {
  if (words[0] !== "test") return undefined;
  const operands = words.slice(1);

  const paths: string[] = [];
  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index];
    if (unaryFilesystemTestOperators.has(operand)) {
      const path = operands[index + 1];
      if (path !== undefined) paths.push(path);
      continue;
    }
    if (binaryFilesystemTestOperators.has(operand)) {
      const left = operands[index - 1];
      const right = operands[index + 1];
      if (left !== undefined) paths.push(left);
      if (right !== undefined) paths.push(right);
    }
  }
  return paths;
}

function safePrintfDecision(words: readonly string[]): SafeBuiltinDecision {
  if (words[0] !== "printf") return "not-safe-builtin";

  const firstArgument = words[1];
  return firstArgument === undefined || firstArgument === "--" || !firstArgument.startsWith("-")
    ? "auto-allow"
    : "defer-to-policy";
}

function safeBuiltinDecision(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): SafeBuiltinDecision {
  if (automaticallyAllowedBuiltins.has(words[0])) return "auto-allow";

  const printfDecision = safePrintfDecision(words);
  if (printfDecision !== "not-safe-builtin") return printfDecision;

  const paths = filesystemTestOperands(words);
  if (!paths) return "not-safe-builtin";
  return paths.every((path) => resolvesWithinWorkspace(workspace, workingDirectory, path))
    ? "auto-allow"
    : "defer-to-policy";
}

function changeDirectory(
  root: string,
  currentDirectory: string,
  words: readonly string[],
): string | undefined {
  let index = 1;
  while (words[index] === "-L" || words[index] === "-P" || words[index] === "-e") {
    index += 1;
  }
  if (words[index] === "--") index += 1;
  const path = words[index];
  if (!path || path === "-" || index + 1 !== words.length) return undefined;
  return resolvesWithinWorkspace(root, currentDirectory, path);
}

function materializeProfileRequest(
  profile: Profile,
  request: NormalizedRequest,
  workingDirectory = request.resource,
  command?: ShellCommandContext,
):
  | { readonly context?: Readonly<Record<string, unknown>>; readonly request: NormalizedRequest }
  | undefined {
  if (!profile.requestMaterializer) return { request };
  const permissions = profile.requestMaterializer.permissions;
  const executable = command?.words[0];
  const materializerCanInspectResource =
    permissions.read.length > 0 ||
    permissions.write.length > 0 ||
    permissions.ffi.length > 0 ||
    (executable !== undefined && permissions.run.includes(executable));
  if (materializerCanInspectResource && !profile.allowedTargets.has(request.resource))
    return undefined;
  const materialized = materializeRequest(
    profile.requestMaterializer,
    request,
    workingDirectory,
    command,
  );
  return materialized
    ? { context: materialized.context, request: { ...request, resource: materialized.resource } }
    : undefined;
}

function hasValidTargetScope(profile: Profile): boolean {
  return profile.targetScope !== "single" || profile.allowedTargets.size === 1;
}

function evaluateCommand(
  profile: Profile,
  request: NormalizedRequest,
  command?: ShellCommandContext,
  materialized?: Readonly<Record<string, unknown>>,
): EvaluationResult {
  const context = {
    command,
    materialized,
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

async function shellSegments(request: NormalizedRequest): Promise<ExecutableSegment[] | undefined> {
  const command = request.arguments.command;
  if (!isShellAction(request.action)) return [{ source: "", words: [] }];
  if (typeof command !== "string" || command.trim().length === 0) {
    return undefined;
  }
  return compileShell(command);
}

function isShellAction(action: string): boolean {
  return action.endsWith(".Bash") || action.endsWith(".unified_exec");
}

function isCedarGrouping(grouping: Profile["groupings"][number]): grouping is CedarGrouping {
  return "policies" in grouping;
}

function sameRequest(left: NormalizedRequest, right: NormalizedRequest): boolean {
  return (
    left.action === right.action &&
    left.resource === right.resource &&
    left.threadId === right.threadId &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments)
  );
}

function sameTargets(left: readonly string[], right: readonly string[] | undefined): boolean {
  return (
    right !== undefined &&
    left.length === right.length &&
    left.every((target, index) => target === right[index])
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
    if (profile.groupings.some((grouping) => grouping.id.length === 0)) {
      throw new Error("grouping IDs must not be empty");
    }

    this.#activeProfiles.set(threadId, { profile, threadId });
  }

  disable(threadId: string): void {
    this.#activeProfiles.delete(threadId);
  }

  async evaluate(request: NormalizedRequest): Promise<EvaluationResult> {
    const activeProfile = this.#activeProfiles.get(request.threadId);
    if (!activeProfile) {
      return { decision: "abstain", reason: "no active profile for thread" };
    }

    const { profile } = activeProfile;
    if (!hasValidTargetScope(profile)) {
      return {
        decision: "abstain",
        reason: "profile requires exactly one allowed target",
      };
    }
    const segments = await shellSegments(request);
    if (!segments) {
      return { decision: "abstain", reason: "shell syntax cannot be authorized safely" };
    }
    if (profile.singleCommand && segments.length !== 1) {
      return { decision: "abstain", reason: "profile requires one shell command" };
    }

    const matchedGroupingIds: string[] = [];
    const resolvedTargets: string[] = [];
    const rootDirectory = request.resource;
    let workingDirectory = rootDirectory;
    for (const segment of segments) {
      const words = isShellAction(request.action) ? segment.words : undefined;
      if (words && words[0] === "cd") {
        const nextDirectory = changeDirectory(rootDirectory, workingDirectory, words);
        if (!nextDirectory) {
          return { decision: "abstain", reason: "directory change is outside the request scope" };
        }
        workingDirectory = nextDirectory;
        continue;
      }
      const builtinDecision =
        words && isAbsolute(rootDirectory)
          ? safeBuiltinDecision(rootDirectory, workingDirectory, words)
          : "not-safe-builtin";
      if (builtinDecision === "auto-allow") continue;
      if (
        words &&
        isAbsolute(rootDirectory) &&
        builtinDecision !== "defer-to-policy" &&
        !validatesWorkspacePaths(rootDirectory, workingDirectory, words)
      ) {
        return { decision: "abstain", reason: "filesystem path is outside the request workspace" };
      }
      const commandRequest = {
        ...request,
        arguments: { ...request.arguments, command: segment.source },
      };
      const commandContext = words
        ? {
            arguments: words.slice(2),
            ...(segment.controlFlow === undefined ? {} : { controlFlow: segment.controlFlow }),
            executable: words[0],
            ...(segment.iteration === undefined ? {} : { iteration: segment.iteration }),
            ...(segment.repetition === undefined ? {} : { repetition: segment.repetition }),
            ...(segment.role === undefined ? {} : { role: segment.role }),
            ...(words[1] === undefined ? {} : { subcommand: words[1] }),
            words,
          }
        : undefined;
      const materializedRequest = materializeProfileRequest(
        profile,
        commandRequest,
        workingDirectory,
        commandContext,
      );
      if (!materializedRequest) {
        return { decision: "abstain", reason: "profile could not materialize the request" };
      }
      const resolvedRequest = materializedRequest.request;
      if (!profile.allowedTargets.has(resolvedRequest.resource)) {
        return {
          decision: "abstain",
          reason: "resolved target is outside the allowed target set",
        };
      }
      const result = evaluateCommand(
        profile,
        resolvedRequest,
        commandContext,
        materializedRequest.context,
      );
      if (result.decision !== "allow") return result;
      if (result.matchedGroupingId !== undefined) matchedGroupingIds.push(result.matchedGroupingId);
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

  async consumeToken(tokenId: string, request: NormalizedRequest): Promise<boolean> {
    const token = this.#tokens.get(tokenId);
    this.#tokens.delete(tokenId);
    const activeProfile = this.#activeProfiles.get(request.threadId);
    const reevaluated =
      token && activeProfile && sameRequest(token.request, request)
        ? await this.evaluate(request)
        : undefined;
    if (reevaluated?.token) this.#tokens.delete(reevaluated.token.id);

    return Boolean(
      token &&
      activeProfile &&
      reevaluated?.decision === "allow" &&
      token.expiresAt.getTime() > Date.now() &&
      token.policyRevision === activeProfile.profile.policyRevision &&
      sameTargets(token.resolvedTargets, reevaluated.resolvedTargets) &&
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
