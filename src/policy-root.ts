import { homedir } from "node:os";
import { join } from "node:path";

export function getPolicyRoot(): string {
  return join(process.env.HOME_FOLDER ?? homedir(), ".agents", "sandbox-extender");
}
