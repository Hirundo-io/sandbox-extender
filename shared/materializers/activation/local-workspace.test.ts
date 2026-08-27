import { describe, expect, test } from "bun:test";

import { materializeLocalWorkspaceActivation, runLocalWorkspaceActivationMaterializer } from "./local-workspace.js";

describe("local workspace activation materializer", () => {
  test("returns a normalized absolute workspace", () => {
    expect(materializeLocalWorkspaceActivation({ workspace: "/tmp/example/../workspace" })).toBe("/tmp/workspace");
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(await runLocalWorkspaceActivationMaterializer(Promise.resolve({ workspace: "/tmp/workspace" }), output.push.bind(output)))
      .toBe(true);
    expect(output).toEqual(['{"targets":["/tmp/workspace"]}']);
    expect(await runLocalWorkspaceActivationMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([undefined, null, {}, { workspace: 42 }, { workspace: "relative" }])(
    "rejects invalid arguments %#",
    (candidate) => expect(materializeLocalWorkspaceActivation(candidate)).toBeUndefined(),
  );
});
