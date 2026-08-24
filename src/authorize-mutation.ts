import { authorizeProfileMutation } from "./mutation-authorization.js";
import { getPolicyRoot } from "./policy-root.js";

const threadId = process.argv[2];
if (!threadId) {
  throw new Error("usage: bun src/authorize-mutation.ts <thread-id>");
}

await authorizeProfileMutation(getPolicyRoot(), threadId);
console.log(`Authorized one profile mutation for thread ${threadId}.`);
