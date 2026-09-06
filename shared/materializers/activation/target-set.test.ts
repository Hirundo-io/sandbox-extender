import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializeTargetSetActivation,
  runTargetSetActivationMaterializer,
} from "./target-set.js";

describe("target set activation materializer", () => {
  test("returns a non-empty unique target set", () => {
    expect(materializeTargetSetActivation({ targets: ["one", "two"] })).toEqual(["one", "two"]);
  });

  test("binds a workspace activation to its realpath", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sandbox-extender-scout-"));
    try {
      expect(materializeTargetSetActivation({ workspace })).toEqual([realpathSync(workspace)]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("rejects a regular file as a workspace", () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-extender-scout-file-"));
    const file = join(directory, "workspace.txt");
    try {
      writeFileSync(file, "not a directory");
      expect(materializeTargetSetActivation({ workspace: file })).toBeUndefined();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(
      await runTargetSetActivationMaterializer(
        Promise.resolve({ targets: ["one"] }),
        output.push.bind(output),
      ),
    ).toBe(true);
    expect(output).toEqual(['{"targets":["one"]}']);
    expect(await runTargetSetActivationMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined,
    null,
    {},
    { targets: "one" },
    { targets: [] },
    { targets: [""] },
    { targets: ["one", 2] },
    { targets: ["one", "one"] },
    { workspace: "relative" },
    { workspace: "/does/not/exist" },
  ])("rejects invalid arguments %#", (candidate) => {
    expect(materializeTargetSetActivation(candidate)).toBeUndefined();
  });
});
