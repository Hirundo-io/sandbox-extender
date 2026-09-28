import { expect, test } from "bun:test";
import { assertBoundedAuthoringInput } from "../src/authoring-limits.js";
import { parseProfileMutationIntent } from "../src/mutation-authorization.js";

test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects primitives that JSON serialization loses or changes: %s",
  (value) => {
    expect(() => assertBoundedAuthoringInput(value)).toThrow("JSON values");
    expect(() => assertBoundedAuthoringInput({ nested: [value] })).toThrow("JSON values");
  },
);

test("bounds total bytes, escaping, UTF-8, nesting, and cyclic input without serialization", () => {
  expect(() =>
    assertBoundedAuthoringInput(Array.from({ length: 5 }, () => "x".repeat(250000))),
  ).toThrow("1 MiB");
  expect(() => assertBoundedAuthoringInput("\u0000".repeat(200000))).toThrow("1 MiB");
  expect(() => assertBoundedAuthoringInput("é".repeat(140000))).toThrow("256 KiB");
  let deep: unknown = null;
  for (let index = 0; index < 34; index++) deep = { deep };
  expect(() => assertBoundedAuthoringInput(deep)).toThrow("nesting");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => assertBoundedAuthoringInput(cyclic)).toThrow("cycles");
  expect(() => assertBoundedAuthoringInput({ a: "x".repeat(262144) })).not.toThrow();
});

test("bounds mutation intent before schema traversal", () => {
  expect(() =>
    parseProfileMutationIntent({
      operation: "propose_complete_profile",
      arguments: { payload: "x".repeat(262145) },
    }),
  ).toThrow("256 KiB");
});
