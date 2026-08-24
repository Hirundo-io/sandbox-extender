import { handlePermissionRequest } from "./hook.js";
import { hookEventSchema, hostSchema } from "./schemas.js";

const input = await Bun.stdin.text();
const event: unknown = JSON.parse(input);
const host = hostSchema.parse(process.argv[2]);
const hookEvent = hookEventSchema.parse(event);

console.log(
  JSON.stringify(await handlePermissionRequest(hookEvent, host)),
);
