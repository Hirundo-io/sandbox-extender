import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializerIntegrity,
  requestResourcePermission,
  workingDirectoryPermission,
} from "./materializer-policy.js";
import {
  assertSupportedPlatform,
  denoPackageName,
  materializeActivation,
  materializeRequest,
} from "./materializer-runtime.js";
import type {
  ActivationMaterializer,
  MaterializerPermissionManifest,
  RequestMaterializer,
} from "./types.js";

const noPermissions = {
  env: [],
  ffi: [],
  net: [],
  read: [],
  run: [],
  sys: [],
  write: [],
} as const satisfies MaterializerPermissionManifest;

const activationSource = [
  "const input = await new Response(Deno.stdin.readable).json();",
  "if (typeof input.repository !== 'string' || typeof input.pullRequest !== 'number') Deno.exit(1);",
  "console.log(JSON.stringify({targets: [`github:pull-request:${input.repository}#${input.pullRequest}`]}));",
].join("\n");

const requestSource = [
  "const input = await new Response(Deno.stdin.readable).json();",
  "console.log(JSON.stringify({resource: input.resource, context: {cwd: Deno.cwd(), operation: input.command.executable}}));",
].join("\n");

function activationMaterializer(
  source: string,
  permissions: MaterializerPermissionManifest = noPermissions,
  runtimeVersion = "2.8.1",
): ActivationMaterializer {
  return {
    file: "materializers/activation/test.ts",
    integrity: materializerIntegrity(source, permissions, runtimeVersion),
    language: "typescript",
    permissions,
    reviewedSource: source,
    runtimeVersion,
  };
}

function requestMaterializer(
  source: string,
  permissions: MaterializerPermissionManifest = noPermissions,
  runtimeVersion = "2.8.1",
): RequestMaterializer {
  return {
    file: "materializers/requests/test.ts",
    integrity: materializerIntegrity(source, permissions, runtimeVersion),
    language: "typescript",
    permissions,
    reviewedSource: source,
    runtimeVersion,
  };
}

function request() {
  return {
    action: "codex.unified_exec",
    arguments: { command: "npm install" },
    resource: "/work",
    threadId: "t",
  };
}

describe("materializer runtime", () => {
  test("resolves supported Deno packages and rejects unsupported platforms", () => {
    expect(denoPackageName("darwin", "arm64")).toBe("darwin-arm64");
    expect(denoPackageName("linux", "x64")).toBe("linux-x64-glibc");
    expect(denoPackageName("win32", "x64")).toBe("win32-x64");
    expect(() => denoPackageName("freebsd", "x64")).toThrow("unsupported Deno platform");
    expect(() => denoPackageName("linux", "riscv64")).toThrow("unsupported Deno platform");
  });

  test("rejects Linux musl before materialization", () => {
    expect(() => assertSupportedPlatform("linux", true)).toThrow("requires glibc");
    expect(() => assertSupportedPlatform("linux", false)).not.toThrow();
  });

  test("materializes activation arguments with the exact local Deno runtime", () => {
    expect(
      materializeActivation(activationMaterializer(activationSource), {
        pullRequest: 42,
        repository: "acme/example",
      }),
    ).toEqual({ targets: ["github:pull-request:acme/example#42"] });
  });

  test("uses the actual request working directory", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "materializer-cwd-"));
    try {
      expect(
        materializeRequest(requestMaterializer(requestSource), request(), workingDirectory, {
          arguments: [],
          executable: "npm",
          subcommand: "install",
          words: ["npm", "install"],
        }),
      ).toEqual({
        context: { cwd: realpathSync(workingDirectory), operation: "npm" },
        resource: "/work",
      });
    } finally {
      rmSync(workingDirectory, { force: true, recursive: true });
    }
  });

  test("grants only declared read access", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "materializer-read-"));
    const source = [
      'import { readFileSync } from "node:fs";',
      "const input = await new Response(Deno.stdin.readable).json();",
      "console.log(JSON.stringify({resource: input.resource, context: {value: readFileSync('allowed.txt', 'utf8')}}));",
    ].join("\n");
    const allowedPermissions = { ...noPermissions, read: [workingDirectoryPermission] };
    try {
      writeFileSync(join(workingDirectory, "allowed.txt"), "allowed");
      expect(
        materializeRequest(requestMaterializer(source), request(), workingDirectory),
      ).toBeUndefined();
      expect(
        materializeRequest(
          requestMaterializer(source, allowedPermissions),
          request(),
          workingDirectory,
        ),
      ).toEqual({ context: { value: "allowed" }, resource: "/work" });
    } finally {
      rmSync(workingDirectory, { force: true, recursive: true });
    }
  });

  test("rejects a symlinked approved request resource", () => {
    const outside = mkdtempSync(join(tmpdir(), "materializer-outside-"));
    const root = mkdtempSync(join(tmpdir(), "materializer-root-"));
    const link = join(root, "linked");
    try {
      symlinkSync(outside, link);
      const permissions = { ...noPermissions, read: [requestResourcePermission] };
      expect(
        materializeRequest(
          requestMaterializer(requestSource, permissions),
          {
            ...request(),
            resource: link,
          },
          link,
        ),
      ).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("rejects a materializer working directory outside its approved request resource", () => {
    const resource = realpathSync(mkdtempSync(join(tmpdir(), "materializer-resource-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "materializer-outside-")));
    try {
      const permissions = { ...noPermissions, read: [requestResourcePermission] };
      expect(
        materializeRequest(
          requestMaterializer(requestSource, permissions),
          {
            ...request(),
            resource,
          },
          outside,
        ),
      ).toBeUndefined();
    } finally {
      rmSync(resource, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("grants subprocess access only when run is declared", () => {
    const source = [
      "const input = await new Response(Deno.stdin.readable).json();",
      "const result = new Deno.Command('printf', {args: ['ok'], stdout: 'piped'}).outputSync();",
      "console.log(JSON.stringify({resource: input.resource, context: {output: new TextDecoder().decode(result.stdout)}}));",
    ].join("\n");
    expect(
      materializeRequest(requestMaterializer(source), request(), process.cwd()),
    ).toBeUndefined();
    expect(
      materializeRequest(
        requestMaterializer(source, { ...noPermissions, run: ["printf"] }),
        request(),
        process.cwd(),
      ),
    ).toEqual({ context: { output: "ok" }, resource: "/work" });
  });

  test("rejects changed source and non-self-contained imports", () => {
    const changed = activationMaterializer(activationSource);
    expect(
      materializeActivation({ ...changed, reviewedSource: `${activationSource}\n// changed` }, {}),
    ).toBeUndefined();
    const importedSource =
      'import "./dependency.ts"; console.log(JSON.stringify({targets:["one"]}));';
    expect(materializeActivation(activationMaterializer(importedSource), {})).toBeUndefined();
  });

  test("rejects a reviewed runtime version that does not match the local binary", () => {
    expect(
      materializeActivation(activationMaterializer(activationSource, noPermissions, "9.9.9"), {}),
    ).toBeUndefined();
  });

  test("fails closed on malformed output, timeout, process failure, and output overflow", () => {
    for (const [source, options] of [
      ["console.log('not-json')", {}],
      ["Deno.exit(1)", {}],
      ["while (true) {}", { timeoutMs: 25 }],
      ["console.log('x'.repeat(1024))", { outputLimitBytes: 128 }],
    ] as const) {
      expect(
        materializeActivation(activationMaterializer(source), {}, process.cwd(), options),
      ).toBeUndefined();
    }
    expect(
      materializeActivation(activationMaterializer(activationSource), {}, process.cwd(), {
        outputLimitBytes: 0,
      }),
    ).toBeUndefined();
    expect(
      materializeActivation(activationMaterializer(activationSource), {}, process.cwd(), {
        timeoutMs: 0,
      }),
    ).toBeUndefined();
  });

  test("validates materialized output shape", () => {
    for (const source of [
      "console.log('{}')",
      "console.log(JSON.stringify({targets: []}))",
      "console.log(JSON.stringify({targets: [1]}))",
      "console.log(JSON.stringify({targets: ['same', 'same']}))",
    ])
      expect(materializeActivation(activationMaterializer(source), {})).toBeUndefined();

    for (const source of [
      "console.log('{}')",
      "console.log(JSON.stringify({resource: '', context: {}}))",
      "console.log(JSON.stringify({resource: '/work', context: null}))",
    ])
      expect(
        materializeRequest(requestMaterializer(source), request(), process.cwd()),
      ).toBeUndefined();
  });
});
