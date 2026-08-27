import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeLocalWorkspaceActivation, runLocalWorkspaceActivationMaterializer } from "./local-workspace.js";

describe("local workspace activation materializer", () => {
  test("returns a normalized absolute workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sandbox-extender-workspace-"));
    try {
      expect(materializeLocalWorkspaceActivation({ workspace })).toBe(realpathSync(workspace));
    } finally {
      rmSync(workspace, { recursive: true });
    }
  });

  test("writes the executable result and reports invalid input", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sandbox-extender-workspace-"));
    const output: string[] = [];
    try {
      expect(await runLocalWorkspaceActivationMaterializer(Promise.resolve({ workspace }), output.push.bind(output)))
        .toBe(true);
      expect(output).toEqual([JSON.stringify({ targets: [realpathSync(workspace)] })]);
      expect(await runLocalWorkspaceActivationMaterializer(Promise.resolve({}))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true });
    }
  });

  test.each([undefined, null, {}, { workspace: 42 }, { workspace: "relative" }, { workspace: "/does/not/exist" }])(
    "rejects invalid arguments %#",
    (candidate) => expect(materializeLocalWorkspaceActivation(candidate)).toBeUndefined(),
  );
});
