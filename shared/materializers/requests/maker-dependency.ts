import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

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
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^\s\/:]+)?$/;
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
  command: string,
  positionals: readonly string[],
  pattern: RegExp,
): boolean {
  const minimum = ["add", "remove", "uninstall"].includes(command) ? 1 : 0;
  return positionals.length >= minimum && positionals.every((value) => pattern.test(value));
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

function operationFacts(
  manager: string,
  command: string,
  parsed: NonNullable<ReturnType<typeof materializeOptions>>,
  positionalsValid: boolean,
  pathsWithinWorkspace: boolean,
  resource: string,
): DependencyOperation {
  return {
    command,
    duplicateOptionCount: parsed.duplicateOptionCount,
    manager,
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
    validPositionals(command, parsed.positionals, settings.positionalPattern(command)),
    optionPaths.every((path) => resolvesWithinWorkspace(workspace, workingDirectory, path)),
    workspace,
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

export function materializeMakerDependency(candidate: unknown): DependencyOperation | undefined {
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
  const manager = words[0] as DependencyManager;
  const settings = dependencyManagerSettings[manager];
  return settings
    ? materializeDependency(manager, settings, value.resource, value.workingDirectory, words)
    : undefined;
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

// prettier-ignore
void (import.meta.main && Deno.exit((await runMakerDependencyMaterializer(new Response(Deno.stdin.readable).json())) ? 0 : 1));
