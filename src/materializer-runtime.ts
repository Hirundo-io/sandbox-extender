import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activationWorkspacePermission,
  denoPermissionFlags,
  verifyMaterializerIntegrity,
} from "./materializer-policy.js";
import type {
  ActivationMaterializer,
  NormalizedRequest,
  RequestMaterializer,
  ShellCommandContext,
} from "./types.js";

export function denoPackageName(platform: NodeJS.Platform, architecture: string): string {
  const platformName = platform === "linux" ? "linux" : platform;
  const architectureName =
    architecture === "x64" || architecture === "arm64" ? architecture : undefined;
  if (!architectureName || !["darwin", "linux", "win32"].includes(platformName)) {
    throw new Error(`unsupported Deno platform: ${platform}-${architecture}`);
  }
  const libc = platformName === "linux" ? "-glibc" : "";
  return `${platformName}-${architectureName}${libc}`;
}

const denoExecutableName = process.platform === "win32" ? "deno.exe" : "deno";
const defaultDenoExecutable = fileURLToPath(
  new URL(
    `../node_modules/@deno/${denoPackageName(process.platform, process.arch)}/${denoExecutableName}`,
    import.meta.url,
  ),
);
const defaultTimeoutMs = 5_000;
const defaultOutputLimitBytes = 64 * 1024;

type ActivationResult = {
  readonly targets: readonly string[];
};

export type RequestMaterialization = {
  readonly context: Readonly<Record<string, unknown>>;
  readonly resource: string;
};

export type MaterializerRuntimeOptions = {
  readonly denoExecutable?: string;
  readonly outputLimitBytes?: number;
  readonly timeoutMs?: number;
};

function exactDenoVersion(output: string): string | undefined {
  return /^deno (\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1];
}

function runtimeOptions(options: MaterializerRuntimeOptions): Required<MaterializerRuntimeOptions> {
  return {
    denoExecutable: options.denoExecutable ?? defaultDenoExecutable,
    outputLimitBytes: options.outputLimitBytes ?? defaultOutputLimitBytes,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
  };
}

function validateRuntimeOptions(options: Required<MaterializerRuntimeOptions>): void {
  if (!Number.isSafeInteger(options.outputLimitBytes) || options.outputLimitBytes <= 0) {
    throw new Error("outputLimitBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
}

function verifyDenoVersion(executable: string, expectedVersion: string): void {
  const result = Bun.spawnSync({ cmd: [executable, "--version"], stderr: "pipe", stdout: "pipe" });
  const output = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0 || exactDenoVersion(output) !== expectedVersion) {
    throw new Error(`local Deno runtime does not match reviewed version ${expectedVersion}`);
  }
}

export function assertSupportedPlatform(
  platform = process.platform,
  muslLoaderPresent = existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1"),
): void {
  if (platform === "linux" && muslLoaderPresent) {
    throw new Error("Linux musl is unsupported; Sandbox Extender requires glibc");
  }
}

function executeMaterializer(
  materializer: ActivationMaterializer | RequestMaterializer,
  input: Readonly<Record<string, unknown>>,
  workingDirectory: string,
  requestResource: string | undefined,
  options: MaterializerRuntimeOptions,
): unknown {
  if (!materializer.reviewedSource) throw new Error("materializer source was not reviewed");
  verifyMaterializerIntegrity(materializer, materializer.reviewedSource);
  const resolvedOptions = runtimeOptions(options);
  validateRuntimeOptions(resolvedOptions);
  verifyDenoVersion(resolvedOptions.denoExecutable, materializer.runtimeVersion);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "sandbox-extender-materializer-"));
  const artifact = join(temporaryDirectory, "materializer.ts");
  const dependencyDirectory = materializer.dependencies
    ? join(dirname(dirname(dirname(materializer.file))), materializer.dependencies.directory)
    : undefined;
  try {
    writeFileSync(artifact, materializer.reviewedSource, { encoding: "utf8", mode: 0o600 });
    if (materializer.dependencies && dependencyDirectory) {
      const packageJson = readFileSync(
        join(dependencyDirectory, materializer.dependencies.packageJson),
      );
      const denoLock = readFileSync(join(dependencyDirectory, materializer.dependencies.denoLock));
      if (
        createHash("sha256").update(packageJson).digest("hex") !==
          materializer.dependencies.packageJsonIntegrity ||
        createHash("sha256").update(denoLock).digest("hex") !==
          materializer.dependencies.denoLockIntegrity
      )
        throw new Error("materializer dependency integrity mismatch");
      writeFileSync(join(temporaryDirectory, "package.json"), packageJson, { mode: 0o600 });
      writeFileSync(join(temporaryDirectory, "deno.lock"), denoLock, { mode: 0o600 });
      cpSync(
        dirname(fileURLToPath(import.meta.resolve("graphql"))),
        join(temporaryDirectory, "node_modules", "graphql"),
        { recursive: true },
      );
      writeFileSync(
        join(temporaryDirectory, "deno.json"),
        JSON.stringify({ imports: { graphql: "./node_modules/graphql/index.mjs" } }),
        { mode: 0o600 },
      );
    }
    const process = Bun.spawnSync({
      cmd: [
        resolvedOptions.denoExecutable,
        "run",
        "--no-prompt",
        "--no-config",
        "--cached-only",
        "--frozen",
        ...(materializer.dependencies
          ? [
              "--node-modules-dir=none",
              `--lock=${join(temporaryDirectory, "deno.lock")}`,
              `--import-map=${join(temporaryDirectory, "deno.json")}`,
              `--allow-read=${temporaryDirectory}`,
            ]
          : ["--no-lock"]),
        ...denoPermissionFlags(
          materializer.permissions,
          workingDirectory,
          requestResource,
          requestResource === undefined ? (input as Readonly<Record<string, unknown>>) : undefined,
        ),
        artifact,
      ],
      cwd: workingDirectory,
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stderr: "pipe",
      stdout: "pipe",
      timeout: resolvedOptions.timeoutMs,
      maxBuffer: resolvedOptions.outputLimitBytes,
    });
    if (
      process.exitCode !== 0 ||
      process.stdout.byteLength > resolvedOptions.outputLimitBytes ||
      process.stderr.byteLength > resolvedOptions.outputLimitBytes
    )
      throw new Error("materializer process failed");
    return JSON.parse(new TextDecoder().decode(process.stdout));
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function activationResult(candidate: unknown): ActivationResult | undefined {
  if (typeof candidate !== "object" || candidate === null || !("targets" in candidate))
    return undefined;
  const targets = candidate.targets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !targets.every((target) => typeof target === "string" && target.length > 0) ||
    new Set(targets).size !== targets.length
  )
    return undefined;
  return { targets };
}

function requestResult(candidate: unknown): RequestMaterialization | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const result = candidate as Record<string, unknown>;
  if (
    typeof result.resource !== "string" ||
    result.resource.length === 0 ||
    typeof result.context !== "object" ||
    result.context === null ||
    Array.isArray(result.context)
  )
    return undefined;
  return {
    context: result.context as Readonly<Record<string, unknown>>,
    resource: result.resource,
  };
}

function canonicalActivationArguments(
  materializer: ActivationMaterializer,
  activationArguments: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const workspace = activationArguments.workspace;
  return materializer.permissions.read.includes(activationWorkspacePermission) &&
    typeof workspace === "string"
    ? { ...activationArguments, workspace: realpathSync(workspace) }
    : activationArguments;
}

export function materializeActivation(
  materializer: ActivationMaterializer,
  arguments_: Readonly<Record<string, unknown>>,
  workingDirectory = process.cwd(),
  options: MaterializerRuntimeOptions = {},
): ActivationResult | undefined {
  assertSupportedPlatform();
  try {
    const canonicalArguments = canonicalActivationArguments(materializer, arguments_);
    return activationResult(
      executeMaterializer(materializer, canonicalArguments, workingDirectory, undefined, options),
    );
  } catch {
    return undefined;
  }
}

export function materializeRequest(
  materializer: RequestMaterializer,
  request: NormalizedRequest,
  workingDirectory: string,
  command?: ShellCommandContext,
  options: MaterializerRuntimeOptions = {},
): RequestMaterialization | undefined {
  assertSupportedPlatform();
  try {
    return requestResult(
      executeMaterializer(
        materializer,
        {
          command,
          requestArguments: request.arguments,
          resource: request.resource,
          workingDirectory,
        },
        workingDirectory,
        request.resource,
        options,
      ),
    );
  } catch {
    return undefined;
  }
}
