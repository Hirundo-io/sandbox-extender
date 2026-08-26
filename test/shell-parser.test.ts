import { describe, expect, test } from "bun:test";

import { parseShellCommands, parseShellWords } from "../src/shell-parser.js";

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

  test("splits static command words once for policy resolvers", () => {
    expect(parseShellWords('npm install "package name" --cache=.cache/npm')).toEqual([
      "npm",
      "install",
      "package name",
      "--cache=.cache/npm",
    ]);
    expect(parseShellWords("npm install 'unterminated")).toBeUndefined();
    expect(parseShellWords("npm install trailing\\")).toBeUndefined();
  });
});
