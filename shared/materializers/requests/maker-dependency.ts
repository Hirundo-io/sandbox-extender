import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "smol-toml";

type MaterializerInput = {
  readonly command?: { readonly words?: unknown };
  readonly resource?: unknown;
  readonly workingDirectory?: unknown;
};

type OptionValue = boolean | string;

type ResolveRealPath = (path: string) => string;

type DependencyOperation = {
  readonly command: string;
  readonly duplicateOptionCount: number;
  readonly manager: string;
  readonly npmPrefixValid: boolean;
  readonly pypiNoBuild: boolean;
  readonly optionCount: number;
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly pathsWithinWorkspace: boolean;
  readonly positionalsValid: boolean;
  readonly resource: string;
  readonly unknownOptionCount: number;
};

type DependencyManager = "bun" | "npm" | "pixi" | "uv";

type DependencyManagerSettings = {
  readonly booleanOptions: readonly string[];
  readonly dependencyOptionNames: readonly string[];
  readonly positionalPattern: (command: string) => RegExp;
  readonly stringOptions: readonly string[];
};

const packageNamePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const registryPackagePattern =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@(?!\.{1,2}$)[^\s\x5c/:]+)?$/;
const pythonRequirementPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[^\s\/@:]+)?$/;
const pixiRequirementPattern = /^(?:[A-Za-z0-9._-]+::)?[A-Za-z0-9][A-Za-z0-9._-]*(?:[=<>!~].*)?$/;

function input(candidate: unknown): MaterializerInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const value = candidate as Record<string, unknown>;
  const command =
    typeof value.command === "object" && value.command !== null
      ? (value.command as { readonly words?: unknown })
      : undefined;
  return { command, resource: value.resource, workingDirectory: value.workingDirectory };
}

function optionKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function canonicalExistingAncestor(
  path: string,
  resolveRealPath: ResolveRealPath = realpathSync,
): string | undefined {
  try {
    return resolveRealPath(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? canonicalExistingAncestor(dirname(path), resolveRealPath)
      : undefined;
  }
}

function resolvesWithinWorkspace(
  workspace: string,
  workingDirectory: string,
  path: string,
): boolean {
  const candidate = resolve(workingDirectory, path);
  if (!isWithin(workspace, candidate)) return false;
  const canonicalWorkspace = canonicalExistingAncestor(workspace);
  const canonicalCandidate = canonicalExistingAncestor(candidate);
  return Boolean(
    canonicalWorkspace && canonicalCandidate && isWithin(canonicalWorkspace, canonicalCandidate),
  );
}

function validPositionals(
  manager: DependencyManager,
  command: string,
  positionals: readonly string[],
  pattern: RegExp,
): boolean {
  const minimumPositionalCount =
    ["add", "remove", "uninstall"].includes(command) ||
    (manager === "npm" && ["update", "up"].includes(command))
      ? 1
      : 0;
  return (
    positionals.length >= minimumPositionalCount &&
    positionals.every((value) => pattern.test(value))
  );
}

function materializeOptions(
  arguments_: readonly string[],
  booleanOptions: readonly string[],
  stringOptions: readonly string[],
):
  | {
      readonly duplicateOptionCount: number;
      readonly optionCount: number;
      readonly options: Readonly<Record<string, OptionValue>>;
      readonly positionals: readonly string[];
      readonly unknownOptionCount: number;
    }
  | undefined {
  const definitions = Object.fromEntries([
    ...booleanOptions.map((name) => [name, { type: "boolean" as const }]),
    ...stringOptions.map((name) => [name, { type: "string" as const }]),
  ]);
  const parsed = parseArgs({
    allowPositionals: true,
    args: [...arguments_],
    options: definitions,
    strict: false,
    tokens: true,
  });
  if (
    stringOptions.some((name) => name in parsed.values && typeof parsed.values[name] !== "string")
  )
    return undefined;
  const optionTokens = parsed.tokens.filter((token) => token.kind === "option");
  const names = optionTokens.map((token) => token.name);
  const known = new Set([...booleanOptions, ...stringOptions]);
  return {
    duplicateOptionCount: names.length - new Set(names).size,
    optionCount: optionTokens.length,
    options: Object.fromEntries(
      Object.entries(parsed.values)
        .filter(
          (entry): entry is [string, OptionValue] =>
            typeof entry[1] === "string" || typeof entry[1] === "boolean",
        )
        .map(([name, value]) => [optionKey(name), value]),
    ),
    positionals: parsed.positionals,
    unknownOptionCount: names.filter((name) => !known.has(name)).length,
  };
}

type ReadManifest = (path: string) => string;

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(value: unknown): Record<string, unknown> {
  return isTable(value) ? value : {};
}

function noBuild(options: unknown): boolean {
  return table(options)["no-build"] === true;
}

function pixiNoBuild(
  workspace: string,
  workingDirectory: string,
  manifestPath: OptionValue | undefined,
  readManifest: ReadManifest,
): boolean {
  // Require an explicit manifest file: directory discovery and parent fallback must
  // not select a different manifest than the one whose policy was checked.
  if (typeof manifestPath !== "string") return false;
  const path = resolve(workingDirectory, manifestPath);
  if (!["pixi.toml", "pyproject.toml"].includes(basename(path))) return false;
  if (!resolvesWithinWorkspace(workspace, workingDirectory, manifestPath)) return false;
  try {
    const parsed = parse(readManifest(path));
    const manifest = basename(path) === "pyproject.toml" ? table(table(parsed.tool).pixi) : parsed;
    const workspaceNoBuild = noBuild(table(manifest.workspace)["pypi-options"]);
    const defaultNoBuild = noBuild(manifest["pypi-options"]);
    if (!workspaceNoBuild && !defaultNoBuild) return false;
    const environments = manifest.environments;
    if (environments !== undefined && !isTable(environments)) return false;
    const features = table(manifest.feature);
    return Object.values(table(environments)).every((environment) => {
      if (Array.isArray(environment)) return environment.every((name) => typeof name === "string");
      if (!isTable(environment)) return false;
      const settings = table(environment);
      const excludesDefault = settings["no-default-feature"];
      if (excludesDefault !== undefined && typeof excludesDefault !== "boolean") return false;
      const includedFeatures = settings.features ?? [];
      if (
        !Array.isArray(includedFeatures) ||
        !includedFeatures.every((name) => typeof name === "string")
      )
        return false;
      // Workspace options apply even without the default feature. Blanket true
      // wins Pixi's no-build union when any included feature supplies it.
      return (
        workspaceNoBuild ||
        excludesDefault !== true ||
        includedFeatures.some((name) => noBuild(table(features[name])["pypi-options"]))
      );
    });
  } catch {
    return false;
  }
}

function operationFacts(
  manager: string,
  command: string,
  parsed: NonNullable<ReturnType<typeof materializeOptions>>,
  positionalsValid: boolean,
  pathsWithinWorkspace: boolean,
  resource: string,
  pypiNoBuild: boolean,
): DependencyOperation {
  return {
    command,
    duplicateOptionCount: parsed.duplicateOptionCount,
    manager,
    npmPrefixValid:
      manager !== "npm" || parsed.options.prefix === undefined || parsed.options.prefix === ".",
    pypiNoBuild,
    optionCount: parsed.optionCount,
    options: parsed.options,
    pathsWithinWorkspace,
    positionalsValid,
    resource,
    unknownOptionCount: parsed.unknownOptionCount,
  };
}

function dependencyOptionPaths(
  options: Readonly<Record<string, OptionValue>>,
  optionNames: readonly string[],
): readonly string[] {
  return optionNames
    .map((optionName) => options[optionName])
    .filter((value): value is string => typeof value === "string");
}

function materializeDependency(
  manager: DependencyManager,
  settings: DependencyManagerSettings,
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
  readManifest: ReadManifest,
): DependencyOperation | undefined {
  const command = words[1];
  if (!command) return undefined;
  const parsed = materializeOptions(
    words.slice(2),
    settings.booleanOptions,
    settings.stringOptions,
  );
  if (!parsed) return undefined;
  const optionPaths = dependencyOptionPaths(parsed.options, settings.dependencyOptionNames);
  return operationFacts(
    manager,
    command,
    parsed,
    validPositionals(manager, command, parsed.positionals, settings.positionalPattern(command)),
    optionPaths.every((path) => resolvesWithinWorkspace(workspace, workingDirectory, path)),
    workspace,
    manager !== "pixi" ||
      pixiNoBuild(workspace, workingDirectory, parsed.options.manifestPath, readManifest),
  );
}

const dependencyManagerSettings: Readonly<Record<DependencyManager, DependencyManagerSettings>> = {
  bun: {
    booleanOptions: ["ignore-scripts", "lockfile-only"],
    dependencyOptionNames: ["cacheDir", "cwd"],
    positionalPattern: (command) =>
      command === "remove" ? packageNamePattern : registryPackagePattern,
    stringOptions: ["cache-dir", "cwd"],
  },
  npm: {
    booleanOptions: ["ignore-scripts", "package-lock-only"],
    dependencyOptionNames: ["cache", "prefix"],
    positionalPattern: (command) =>
      ["remove", "uninstall"].includes(command) ? packageNamePattern : registryPackagePattern,
    stringOptions: ["cache", "global", "location", "prefix", "workspaces"],
  },
  pixi: {
    booleanOptions: ["no-config", "no-install", "offline"],
    dependencyOptionNames: ["manifestPath"],
    positionalPattern: () => pixiRequirementPattern,
    stringOptions: ["manifest-path"],
  },
  uv: {
    booleanOptions: ["no-build", "no-config", "no-python-downloads", "no-sources", "no-sync"],
    dependencyOptionNames: ["cacheDir", "project"],
    positionalPattern: (command) =>
      command === "remove" ? packageNamePattern : pythonRequirementPattern,
    stringOptions: ["cache-dir", "project"],
  },
};

export function materializeMakerDependency(
  candidate: unknown,
  readManifest: ReadManifest = (path) => Deno.readTextFileSync(path),
): DependencyOperation | undefined {
  const value = input(candidate);
  const words = value.command?.words;
  if (
    typeof value.resource !== "string" ||
    !isAbsolute(value.resource) ||
    typeof value.workingDirectory !== "string" ||
    !resolvesWithinWorkspace(value.resource, value.resource, value.workingDirectory) ||
    !Array.isArray(words) ||
    !words.every((word) => typeof word === "string")
  )
    return undefined;
  const manager = words[0];
  if (!Object.hasOwn(dependencyManagerSettings, manager)) return undefined;
  const dependencyManager = manager as DependencyManager;
  const settings = dependencyManagerSettings[dependencyManager];
  return materializeDependency(
    dependencyManager,
    settings,
    value.resource,
    value.workingDirectory,
    words,
    readManifest,
  );
}

export async function runMakerDependencyMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeMakerDependency(await candidate);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

type GitRead = (workspace: string, args: readonly string[]) => string | undefined;

function readGit(workspace: string, args: readonly string[]): string | undefined {
  const result = new Deno.Command("git", {
    args: ["-C", workspace, ...args],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!result.success && result.code !== 1) throw new Error("Git metadata lookup failed");
  return result.success ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

function repositoryHooks(workspace: string, git: GitRead): string | undefined {
  const configured = git(workspace, ["config", "--show-scope", "--get", "core.hooksPath"]);
  let hooks: string | undefined;
  if (configured !== undefined) {
    const match = /^(?:local|worktree)\t([^\n]+)$/.exec(configured);
    if (!match) return undefined;
    hooks = match[1];
  } else {
    hooks = git(workspace, ["rev-parse", "--git-path", "hooks"]);
  }
  if (
    !hooks ||
    !resolvesWithinWorkspace(workspace, workspace, hooks) ||
    !resolvesWithinWorkspace(workspace, workspace, resolve(workspace, hooks, "pre-push"))
  )
    return undefined;
  return resolve(workspace, hooks);
}

function makerPushGrant(
  workspace: string,
  git: GitRead,
): { target: string; branch: string } | undefined {
  if (git(workspace, ["rev-parse", "--show-toplevel"]) !== workspace) return undefined;
  const branch = git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return undefined;
  if (git(workspace, ["check-ref-format", `refs/heads/${branch}`]) !== "") return undefined;
  const url = git(workspace, ["remote", "get-url", "--push", "--all", "origin"]);
  if (
    !url ||
    !/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      url,
    )
  )
    return undefined;
  // These options can add refs, recurse into other repositories, or select
  // executable transports despite an explicit remote and refspec.
  for (const key of [
    "remote.origin.mirror",
    "push.followTags",
    "push.recurseSubmodules",
    "push.gpgSign",
  ]) {
    const value = git(workspace, ["config", "--get-all", key]);
    if (value !== undefined && value !== "false" && value !== "no") return undefined;
  }
  for (const key of [
    "remote.origin.receivepack",
    "remote.origin.vcs",
    "push.pushOption",
    "core.sshCommand",
    "core.gitProxy",
    "remote.origin.proxy",
  ]) {
    if (git(workspace, ["config", "--get-all", key]) !== undefined) return undefined;
  }
  const hooks = repositoryHooks(workspace, git);
  if (!hooks) return undefined;
  return { branch, target: `maker:push:${JSON.stringify([workspace, url, branch, hooks])}` };
}

export function materializeMakerActivation(
  candidate: unknown,
  git: GitRead = readGit,
): readonly string[] | undefined {
  if (
    !isTable(candidate) ||
    typeof candidate.workspace !== "string" ||
    !isAbsolute(candidate.workspace)
  )
    return undefined;
  if (candidate.push !== undefined && typeof candidate.push !== "boolean") return undefined;
  try {
    const workspace = realpathSync(candidate.workspace);
    if (candidate.push !== true) return [workspace];
    const grant = makerPushGrant(workspace, git);
    return grant ? [workspace, grant.target] : undefined;
  } catch {
    return undefined;
  }
}

function materializeMakerPush(
  candidate: unknown,
  git: GitRead,
): { operation: string; resource: string } | undefined {
  const value = input(candidate);
  const words = value.command?.words;
  if (
    typeof value.resource !== "string" ||
    !isAbsolute(value.resource) ||
    typeof value.workingDirectory !== "string" ||
    !Array.isArray(words)
  )
    return undefined;
  try {
    const workspace = realpathSync(value.resource);
    if (workspace !== value.resource || realpathSync(value.workingDirectory) !== workspace)
      return undefined;
    const grant = makerPushGrant(workspace, git);
    return grant &&
      words.length === 4 &&
      words[0] === "git" &&
      words[1] === "push" &&
      words[2] === "origin" &&
      words[3] === `HEAD:refs/heads/${grant.branch}`
      ? { operation: "git.push", resource: grant.target }
      : undefined;
  } catch {
    return undefined;
  }
}

export function materializeMakerRequest(
  candidate: unknown,
  git: GitRead = readGit,
  readManifest: ReadManifest = (path) => Deno.readTextFileSync(path),
) {
  const words = input(candidate).command?.words;
  return Array.isArray(words) && words[0] === "git"
    ? materializeMakerPush(candidate, git)
    : materializeMakerDependency(candidate, readManifest);
}

export async function runMakerMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const value = await candidate;
  if (isTable(value) && Object.hasOwn(value, "workspace")) {
    const targets = materializeMakerActivation(value);
    if (!targets) return false;
    write(JSON.stringify({ targets }));
    return true;
  }
  const materialized = materializeMakerRequest(value);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

// prettier-ignore
void (import.meta.main && Deno.exit((await runMakerMaterializer(new Response(Deno.stdin.readable).json())) ? 0 : 1));
