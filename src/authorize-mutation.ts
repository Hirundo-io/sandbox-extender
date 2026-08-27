import {
  authorizeProfileMutation,
  parseProfileMutationIntent,
} from "./mutation-authorization.js";
import { getPolicyRoot } from "./policy-root.js";

const USAGE = `Usage:
  bun run authorize:mutation -- <operation> --thread-id <host-thread-id> [--arguments-json '<json-object>']

Operations:
  initialize_policy_repository  arguments: {}
  propose_profile               arguments: {"action":"...","arguments":{},"profileId":"...","resource":"..."}
  promote_profile               arguments: {"policyRevision":"<40-character-commit-id>","profileId":"..."}
  activate_profile              arguments: {"arguments":{},"profileId":"..."}
  disable_profile               arguments: {}

Example:
  bun run authorize:mutation -- activate_profile --thread-id <host-thread-id> --arguments-json '{"arguments":{"repository":"owner/repository","pullRequest":42},"profileId":"babysitter"}'`;

type CliInput = {
  readonly argumentsJson: string;
  readonly operation: string;
  readonly threadId: string;
};

function readCliInput(argv: readonly string[]): CliInput | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return undefined;
  const [operation, ...options] = argv;
  if (!operation) throw new Error("an operation is required");

  let argumentsJson = "{}";
  let threadId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!option || !value) throw new Error(`a value is required after ${option ?? "the option"}`);
    if (seen.has(option)) throw new Error(`${option} may be provided only once`);
    seen.add(option);
    if (option === "--arguments-json") {
      argumentsJson = value;
    } else if (option === "--thread-id") {
      threadId = value;
    } else {
      throw new Error(`unknown option ${option}`);
    }
  }
  if (!threadId) throw new Error("--thread-id is required");
  return { argumentsJson, operation, threadId };
}

async function main(argv: readonly string[]): Promise<void> {
  const input = readCliInput(argv);
  if (!input) {
    console.log(USAGE);
    return;
  }

  let mutationArguments: unknown;
  try {
    mutationArguments = JSON.parse(input.argumentsJson);
  } catch {
    throw new Error("--arguments-json must be a valid JSON object");
  }
  const intent = parseProfileMutationIntent({
    arguments: mutationArguments,
    operation: input.operation,
  });
  const authorization = await authorizeProfileMutation(
    getPolicyRoot(),
    input.threadId,
    intent,
  );
  console.log(
    `Authorized one ${intent.operation} mutation for host thread ${input.threadId}.`,
  );
  console.log("The authorization is bound to the supplied arguments.");
  console.log(`Expires at ${authorization.expiresAt}.`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not create mutation authorization: ${message}\n\n${USAGE}`);
  process.exitCode = 1;
}
