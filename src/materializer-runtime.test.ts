import { describe, expect, test } from "bun:test";

import { materializeActivation, materializeRequest } from "./materializer-runtime.js";

const activationSource = [
  "const input = await Bun.stdin.json();",
  "if (typeof input.repository !== 'string' || typeof input.pullRequest !== 'number') process.exit(1);",
  "console.log(JSON.stringify({targets: [`github:pull-request:${input.repository}#${input.pullRequest}`]}));",
].join("\n");

const requestSource = [
  "const input = await Bun.stdin.json();",
  "console.log(JSON.stringify({resource: input.resource, context: {operation: input.command.executable}}));",
].join("\n");

describe("materializer runtime", () => {
  test("materializes activation arguments into a frozen target set", () => {
    expect(materializeActivation(
      { file: "unused.ts", language: "typescript", reviewedSource: activationSource },
      { pullRequest: 42, repository: "acme/example" },
    )).toEqual({ targets: ["github:pull-request:acme/example#42"] });
  });

  test("rejects failed and malformed activation output", () => {
    for (const reviewedSource of [
      "process.exit(1)", "console.log('not-json')", "console.log('{}')",
      "console.log(JSON.stringify({targets: []}))", "console.log(JSON.stringify({targets: [1]}))",
      "console.log(JSON.stringify({targets: ['same', 'same']}))",
    ]) {
      expect(materializeActivation({ file: "unused.ts", language: "typescript", reviewedSource }, {})).toBeUndefined();
    }
    expect(materializeActivation({ file: "\0", language: "typescript" }, {})).toBeUndefined();
  });

  test("materializes requests into a resource and Cedar context without a decision", () => {
    expect(materializeRequest(
      { file: "unused.ts", language: "typescript", reviewedSource: requestSource },
      { action: "codex.unified_exec", arguments: { command: "npm install" }, resource: "/work", threadId: "t" },
      "/work",
      { arguments: [], executable: "npm", subcommand: "install", words: ["npm", "install"] },
    )).toEqual({ context: { operation: "npm" }, resource: "/work" });
  });

  test("rejects failed and malformed request output", () => {
    for (const reviewedSource of ["process.exit(1)", "console.log('not-json')", "console.log('{}')",
      "console.log(JSON.stringify({resource: '', context: {}}))", "console.log(JSON.stringify({resource: '/work', context: null}))"]) {
      expect(materializeRequest({ file: "unused.ts", language: "typescript", reviewedSource },
        { action: "a", arguments: {}, resource: "/work", threadId: "t" }, "/work")).toBeUndefined();
    }
    expect(materializeRequest({ file: "\0", language: "typescript" },
      { action: "a", arguments: {}, resource: "/work", threadId: "t" }, "/work")).toBeUndefined();
  });
});
