import { describe, expect, test } from "bun:test";

import {
  materializeTargetSetActivation,
  runTargetSetActivationMaterializer,
} from "./target-set.js";

describe("target set activation materializer", () => {
  test("returns a non-empty unique target set", () => {
    expect(materializeTargetSetActivation({ targets: ["one", "two"] })).toEqual(["one", "two"]);
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
  ])("rejects invalid arguments %#", (candidate) => {
    expect(materializeTargetSetActivation(candidate)).toBeUndefined();
  });
});
