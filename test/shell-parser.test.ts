import { describe, expect, test } from "bun:test";

import { parseShellCommands } from "../src/shell-parser.js";

describe("shell parser", () => {
  test("extracts every static command from compound syntax and control flow", () => {
    expect(parseShellCommands("cd app && npm i zod | tee install.log")).toEqual([
      "cd app",
      "npm i zod",
      "tee install.log",
    ]);
    expect(parseShellCommands("for app in a b; do npm i zod; done")).toEqual([
      "npm i zod",
    ]);
  });

  test("fails closed for invalid, dynamic, and redirected shell syntax", () => {
    expect(parseShellCommands("npm i &&")).toBeUndefined();
    expect(parseShellCommands("npm i $(curl example.test)")).toBeUndefined();
    expect(parseShellCommands("npm i zod > install.log")).toBeUndefined();
  });
});
