import { fileURLToPath } from "node:url";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

await Parser.init();

const bashLanguage = await Language.load(fileURLToPath(new URL(
  "../node_modules/tree-sitter-wasms/out/tree-sitter-bash.wasm",
  import.meta.url,
)));
const parser = new Parser();
parser.setLanguage(bashLanguage);

const unsafeNodeTypes = new Set([
  "command_substitution",
  "expansion",
  "file_redirect",
  "herestring_redirect",
  "heredoc_redirect",
  "process_substitution",
  "redirected_statement",
]);

/**
 * Returns every statically known simple command in Bash-compatible source.
 * Control flow is supported, but dynamically constructed commands and I/O
 * redirection abstain because their effective arguments cannot be proven.
 */
export function parseShellCommands(script: string): string[] | undefined {
  const tree = parser.parse(script);
  if (!tree) return undefined;
  try {
    if (tree.rootNode.hasError) return undefined;
    if (hasUnsafeDescendant(tree.rootNode)) return undefined;
    const commands = descendants(tree.rootNode, "command")
      .sort((left, right) => left.startIndex - right.startIndex);
    if (commands.some((command) => !isStaticCommand(command))) return undefined;
    return commands.map((command) => command.text);
  } finally {
    tree.delete();
  }
}

function descendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const nodes = [node];
  while (nodes.length > 0) {
    const current = nodes.pop()!;
    if (current.type === type) result.push(current);
    nodes.push(...current.namedChildren.filter((child): child is SyntaxNode => child !== null));
  }
  return result;
}

function isStaticCommand(command: SyntaxNode): boolean {
  const firstChild = command.firstNamedChild;
  if (!firstChild || firstChild.type !== "command_name") {
    return false;
  }
  return descendants(command, "command").length === 1 &&
    !descendants(command, "error").length &&
    !hasUnsafeDescendant(command);
}

function hasUnsafeDescendant(node: SyntaxNode): boolean {
  const nodes = [...node.namedChildren];
  while (nodes.length > 0) {
    const current = nodes.pop()!;
    if (unsafeNodeTypes.has(current.type)) return true;
    nodes.push(...current.namedChildren.filter((child): child is SyntaxNode => child !== null));
  }
  return false;
}
