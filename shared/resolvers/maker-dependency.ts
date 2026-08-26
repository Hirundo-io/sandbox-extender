import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export type MakerDependencyResolverInput = {
  readonly commandWords?: unknown;
  readonly localTarget?: unknown;
  readonly requestArguments?: Readonly<Record<string, unknown>>;
  readonly workingDirectory?: unknown;
};

type ParsedArguments = {
  readonly options: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
};

const packageNamePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const registryPackagePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^\s\/:]+)?$/;
const pythonRequirementPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[^\s\/@:]+)?$/;
const pixiRequirementPattern = /^(?:[A-Za-z0-9._-]+::)?[A-Za-z0-9][A-Za-z0-9._-]*(?:[=<>!~].*)?$/;

function resolverInput(candidate: unknown): MakerDependencyResolverInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const input = candidate as Record<string, unknown>;
  return {
    commandWords: input.commandWords,
    localTarget: input.localTarget,
    requestArguments: typeof input.requestArguments === "object" && input.requestArguments !== null
      ? input.requestArguments as Readonly<Record<string, unknown>>
      : undefined,
    workingDirectory: input.workingDirectory,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalExistingAncestor(path: string): string | undefined {
  for (let candidate = path; ; candidate = dirname(candidate)) {
    try {
      return realpathSync(candidate);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
  }
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
  return canonicalWorkspace && canonicalCandidate && isWithin(canonicalWorkspace, canonicalCandidate)
    ? candidate
    : undefined;
}

function parseArguments(
  arguments_: readonly string[],
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): ParsedArguments | undefined {
  try {
    const optionDefinitions = Object.fromEntries([
      ...[...booleanOptions].map((name) => [name.slice(2), { type: "boolean" as const }]),
      ...[...valueOptions].map((name) => [name.slice(2), { type: "string" as const }]),
    ]);
    const parsed = parseArgs({
      allowPositionals: true,
      args: [...arguments_],
      options: optionDefinitions,
      strict: true,
      tokens: true,
    });
    const optionTokens = parsed.tokens.filter((token) => token.kind === "option");
    if (new Set(optionTokens.map((token) => token.name)).size !== optionTokens.length) return undefined;
    const options = new Map<string, string | true>();
    for (const [name, value] of Object.entries(parsed.values)) {
      if (typeof value === "string" || value === true) options.set(`--${name}`, value);
      else if (value !== undefined) return undefined;
    }
    return { options, positionals: parsed.positionals };
  } catch {
    return undefined;
  }
}

function hasExactOptions(
  parsed: ParsedArguments,
  booleanOptions: readonly string[],
  valueOptions: Readonly<Record<string, (value: string) => boolean>>,
): boolean {
  if (parsed.options.size !== booleanOptions.length + Object.keys(valueOptions).length) return false;
  if (!booleanOptions.every((option) => parsed.options.get(option) === true)) return false;
  return Object.entries(valueOptions).every(([option, validate]) => {
    const value = parsed.options.get(option);
    return typeof value === "string" && validate(value);
  });
}

function validPositionals(
  command: string,
  positionals: readonly string[],
  pattern: RegExp,
): boolean {
  const minimum = ["add", "remove", "uninstall"].includes(command) ? 1 : 0;
  return positionals.length >= minimum && positionals.every((value) => pattern.test(value));
}

function resolveNpm(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): string | undefined {
  const command = words[1];
  if (!command || !["install", "i", "uninstall", "remove", "update", "up"].includes(command)) {
    return undefined;
  }
  const parsed = parseArguments(
    words.slice(2),
    new Set(["--ignore-scripts", "--package-lock-only"]),
    new Set(["--cache", "--global", "--location", "--prefix", "--workspaces"]),
  );
  const within = (value: string): boolean => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined;
  if (!parsed || !hasExactOptions(parsed, ["--ignore-scripts", "--package-lock-only"], {
    "--cache": within,
    "--global": (value) => value === "false",
    "--location": (value) => value === "project",
    "--prefix": within,
    "--workspaces": (value) => value === "false",
  })) return undefined;
  const pattern = ["remove", "uninstall"].includes(command) ? packageNamePattern : registryPackagePattern;
  return validPositionals(command, parsed.positionals, pattern) ? workspace : undefined;
}

function resolveBun(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): string | undefined {
  const command = words[1];
  if (!command || !["install", "i", "add", "remove", "update"].includes(command)) return undefined;
  const parsed = parseArguments(
    words.slice(2),
    new Set(["--ignore-scripts", "--lockfile-only"]),
    new Set(["--cache-dir", "--cwd"]),
  );
  if (!parsed || !hasExactOptions(parsed, ["--ignore-scripts", "--lockfile-only"], {
    "--cache-dir": (value) => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined,
    "--cwd": (value) => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined,
  })) return undefined;
  const pattern = command === "remove" ? packageNamePattern : registryPackagePattern;
  return validPositionals(command, parsed.positionals, pattern) ? workspace : undefined;
}

function resolveUv(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): string | undefined {
  const command = words[1];
  if (!command || !["add", "remove", "lock"].includes(command)) return undefined;
  const required = ["--no-build", "--no-config", "--no-python-downloads", "--no-sources"];
  if (["add", "remove"].includes(command)) required.push("--no-sync");
  const parsed = parseArguments(words.slice(2), new Set(required), new Set(["--cache-dir", "--project"]));
  if (!parsed || !hasExactOptions(parsed, required, {
    "--cache-dir": (value) => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined,
    "--project": (value) => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined,
  })) return undefined;
  const pattern = command === "remove" ? packageNamePattern : pythonRequirementPattern;
  return validPositionals(command, parsed.positionals, pattern) ? workspace : undefined;
}

function resolvePixi(
  workspace: string,
  workingDirectory: string,
  words: readonly string[],
): string | undefined {
  const command = words[1];
  if (!command || !["add", "remove", "update", "lock"].includes(command)) return undefined;
  const parsed = parseArguments(
    words.slice(2),
    new Set(["--no-config", "--no-install", "--offline"]),
    new Set(["--manifest-path"]),
  );
  if (!parsed || !hasExactOptions(parsed, ["--no-config", "--no-install", "--offline"], {
    "--manifest-path": (value) => resolvesWithinWorkspace(workspace, workingDirectory, value) !== undefined,
  })) return undefined;
  return validPositionals(command, parsed.positionals, pixiRequirementPattern) ? workspace : undefined;
}

function resolveTarget(input: MakerDependencyResolverInput): string | undefined {
  const workspace = input.localTarget;
  const workingDirectory = input.workingDirectory;
  const commandWords = input.commandWords;
  if (typeof workspace !== "string" || !isAbsolute(workspace) ||
    typeof workingDirectory !== "string" || !resolvesWithinWorkspace(workspace, workspace, workingDirectory) ||
    !Array.isArray(commandWords) || !commandWords.every((word) => typeof word === "string")) return undefined;
  const words = commandWords as readonly string[];
  if (words[0] === "npm") return resolveNpm(workspace, workingDirectory, words);
  if (words[0] === "bun") return resolveBun(workspace, workingDirectory, words);
  if (words[0] === "uv") return resolveUv(workspace, workingDirectory, words);
  if (words[0] === "pixi") return resolvePixi(workspace, workingDirectory, words);
  return undefined;
}

export function resolveMakerDependencyTarget(candidate: unknown): string | undefined {
  return resolveTarget(resolverInput(candidate));
}

async function main(): Promise<void> {
  const target = resolveMakerDependencyTarget(await Bun.stdin.json());
  if (!target) process.exit(1);
  console.log(target);
}

if (import.meta.main) await main();
