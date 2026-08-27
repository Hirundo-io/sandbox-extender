import { LangVariant, parse as parseShellSyntax } from "sh-syntax";
import { parse as parseTypedShell } from "unbash";
import type {
  AndOr,
  Command,
  Node,
  ParsedScript,
  Word,
  WordPart,
} from "unbash";

const defaultMaxIterations = 64;
const defaultMaxSegments = 256;
const unquotedGlobPattern = /[*?\[]/;
const shellStateMutations = new Set([
  ".", "alias", "builtin", "declare", "eval", "exec", "export", "local", "read", "readonly",
  "set", "shift", "source", "trap", "typeset", "umask", "unalias", "unset",
]);

export type ShellDialect = "bash" | "posix";

export type ExecutableSegment = {
  readonly controlFlow?: "for" | "until" | "while";
  readonly iteration?: number;
  readonly repetition?: "finite" | "potentially-unbounded";
  readonly role?: "condition" | "body";
  readonly source: string;
  readonly words: readonly string[];
};

export type ShellCompileOptions = {
  readonly dialect?: ShellDialect;
  readonly maxIterations?: number;
  readonly maxSegments?: number;
};

type ControlFlowFacts = Omit<ExecutableSegment, "source" | "words">;

type CompilerState = {
  readonly maxIterations: number;
  readonly maxSegments: number;
  readonly segments: ExecutableSegment[];
  readonly source: string;
};

type Variables = ReadonlyMap<string, string>;

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function dialectVariant(dialect: ShellDialect): number {
  return dialect === "posix" ? LangVariant.LangPOSIX : LangVariant.LangBash;
}

function simpleVariable(text: string): string | undefined {
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(text);
  return match?.[1] ?? match?.[2];
}

function unsafeUnquotedValue(value: string): boolean {
  return value.startsWith("~") || /\s/.test(value) || unquotedGlobPattern.test(value);
}

function unsafeUnquotedLiteral(part: Extract<WordPart, { type: "Literal" }>, first: boolean): boolean {
  return unquotedGlobPattern.test(part.value) || first && part.text.startsWith("~");
}

function unsafeUnquotedReconstruction(value: string): boolean {
  return value.startsWith("~") || unquotedGlobPattern.test(value);
}

function resolveParts(
  parts: readonly WordPart[],
  variables: Variables,
  quoted: boolean,
): string | undefined {
  let result = "";
  let unquotedResult = "";
  for (const part of parts) {
    if (part.type === "Literal") {
      if (!quoted && unsafeUnquotedLiteral(part, unquotedResult.length === 0)) return undefined;
      result += part.value;
      unquotedResult += quoted ? "\0" : part.value;
      continue;
    }
    if (part.type === "SingleQuoted" || part.type === "AnsiCQuoted") {
      result += part.value;
      unquotedResult += "\0";
      continue;
    }
    if (part.type === "DoubleQuoted") {
      const value = resolveParts(part.parts, variables, true);
      if (value === undefined) return undefined;
      result += value;
      unquotedResult += "\0";
      continue;
    }
    const name = part.type === "SimpleExpansion"
      ? simpleVariable(part.text)
      : part.type === "ParameterExpansion" && part.operator === undefined && part.index === undefined &&
          !part.indirect && !part.length
        ? part.parameter
        : undefined;
    if (!name) return undefined;
    const value = variables.get(name);
    if (value === undefined || !quoted && unsafeUnquotedValue(value)) return undefined;
    result += value;
    if (!quoted) unquotedResult += value;
  }
  return !quoted && unsafeUnquotedReconstruction(unquotedResult) ? undefined : result;
}

function resolveWord(word: Word, variables: Variables): string | undefined {
  if (!word.parts) return unsafeUnquotedValue(word.value) ? undefined : word.value;
  return resolveParts(word.parts, variables, false);
}

function commandWords(command: Command, variables: Variables): string[] | undefined {
  if (!command.name || command.prefix.length > 0 || command.redirects.length > 0) return undefined;
  const words = [command.name, ...command.suffix].map((word) => resolveWord(word, variables));
  return words.every((word): word is string => word !== undefined) && words.length > 0 ? words : undefined;
}

function commandMutation(node: Node, variables: Variables): boolean {
  if (node.type === "Statement") return commandMutation(node.command, variables);
  if (node.type === "Command") {
    const words = commandWords(node, variables);
    return !words || words[0] === "cd" || shellStateMutations.has(words[0]!);
  }
  if (node.type === "Pipeline" || node.type === "AndOr") {
    return node.commands.some((command) => commandMutation(command, variables));
  }
  return true;
}

function addCommand(
  command: Command,
  state: CompilerState,
  variables: Variables,
  facts: ControlFlowFacts,
  allowDirectoryChange: boolean,
): boolean {
  const words = commandWords(command, variables);
  if (!words || shellStateMutations.has(words[0]!) || words[0] === "cd" && !allowDirectoryChange) return false;
  if (state.segments.length >= state.maxSegments) return false;
  state.segments.push({ ...facts, source: state.source.slice(command.pos, command.end), words });
  return true;
}

function validConditionalDirectoryChange(andOr: AndOr, variables: Variables, terminal: boolean): boolean {
  if (!andOr.commands.some((command) => commandMutation(command, variables))) return true;
  if (!terminal || andOr.operators.some((operator) => operator !== "&&")) return false;
  const first = andOr.commands[0];
  if (!first || first.type !== "Command") return false;
  const words = commandWords(first, variables);
  return words?.[0] === "cd" && andOr.commands.slice(1).every((command) => !commandMutation(command, variables));
}

function compileNode(
  node: Node,
  state: CompilerState,
  variables: Variables,
  facts: ControlFlowFacts,
  allowDirectoryChange: boolean,
  terminal: boolean,
): boolean {
  if (node.type === "Statement") {
    if (node.background || node.redirects.length > 0) return false;
    return compileNode(node.command, state, variables, facts, allowDirectoryChange, terminal);
  }
  if (node.type === "Command") return addCommand(node, state, variables, facts, allowDirectoryChange);
  if (node.type === "Pipeline") {
    if (node.negated || node.time || node.commands.some((command) => commandMutation(command, variables))) {
      return false;
    }
    return node.commands.every((command) => compileNode(command, state, variables, facts, false, false));
  }
  if (node.type === "AndOr") {
    if (!validConditionalDirectoryChange(node, variables, terminal)) return false;
    return node.commands.every((command, index) =>
      compileNode(command, state, variables, facts, index === 0, false));
  }
  if (node.type === "For") {
    const name = resolveWord(node.name, new Map());
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || node.wordlist.length === 0 ||
      node.wordlist.length > state.maxIterations) return false;
    const values = node.wordlist.map((word) => resolveWord(word, new Map()));
    if (!values.every((value): value is string => value !== undefined)) return false;
    return values.every((value, iteration) => {
      const iterationVariables = new Map(variables);
      iterationVariables.set(name, value);
      const loopFacts = {
        controlFlow: "for" as const,
        iteration,
        repetition: "finite" as const,
        role: "body" as const,
      };
      return node.body.commands.every((statement, index) =>
        compileNode(statement, state, iterationVariables, loopFacts, false, index === node.body.commands.length - 1));
    });
  }
  if (node.type === "While") {
    if (node.clause.commands.some((statement) => commandMutation(statement, variables)) ||
      node.body.commands.some((statement) => commandMutation(statement, variables))) return false;
    const loopFacts = { controlFlow: node.kind, repetition: "potentially-unbounded" as const };
    return node.clause.commands.every((statement, index) => compileNode(
      statement,
      state,
      variables,
      { ...loopFacts, role: "condition" },
      false,
      index === node.clause.commands.length - 1,
    )) && node.body.commands.every((statement, index) => compileNode(
      statement,
      state,
      variables,
      { ...loopFacts, role: "body" },
      false,
      index === node.body.commands.length - 1,
    ));
  }
  if (node.type === "BraceGroup") {
    return node.body.commands.every((statement, index) => compileNode(
      statement, state, variables, facts, allowDirectoryChange, index === node.body.commands.length - 1,
    ));
  }
  if (node.type === "Subshell" && !node.body.commands.some((statement) => commandMutation(statement, variables))) {
    return node.body.commands.every((statement, index) =>
      compileNode(statement, state, variables, facts, false, index === node.body.commands.length - 1));
  }
  return false;
}

function compileTypedAst(script: string, parsed: ParsedScript, options: Required<ShellCompileOptions>): ExecutableSegment[] | undefined {
  if (parsed.errors?.length) return undefined;
  const state = {
    maxIterations: options.maxIterations,
    maxSegments: options.maxSegments,
    segments: [],
    source: script,
  } satisfies CompilerState;
  return parsed.commands.every((statement, index) =>
    compileNode(statement, state, new Map(), {}, true, index === parsed.commands.length - 1)) &&
      state.segments.length > 0
    ? state.segments
    : undefined;
}

/** Compiles the supported Bash/POSIX subset into independently authorized executable segments. */
export async function compileShell(
  script: string,
  options: ShellCompileOptions = {},
): Promise<ExecutableSegment[] | undefined> {
  const resolvedOptions = {
    dialect: options.dialect ?? "bash",
    maxIterations: options.maxIterations ?? defaultMaxIterations,
    maxSegments: options.maxSegments ?? defaultMaxSegments,
  };
  if (!validLimit(resolvedOptions.maxIterations) || !validLimit(resolvedOptions.maxSegments)) return undefined;
  try {
    await parseShellSyntax(script, { variant: dialectVariant(resolvedOptions.dialect) });
    return compileTypedAst(script, parseTypedShell(script), resolvedOptions);
  } catch {
    return undefined;
  }
}
