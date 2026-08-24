import { handlePermissionRequest, hookOutput } from "./hook.js";
import { hookEventSchema, hostSchema } from "./schemas.js";

const fallbackHost = hostSchema.safeParse(process.argv[2]).data ?? "codex";

try {
  const event: unknown = JSON.parse(await Bun.stdin.text());
  const host = hostSchema.parse(process.argv[2]);
  const hookEvent = hookEventSchema.parse(event);
  console.log(JSON.stringify(await handlePermissionRequest(hookEvent, host)));
} catch {
  console.log(JSON.stringify(hookOutput(
    "abstain",
    fallbackHost,
    "policy context is unavailable",
  )));
}
