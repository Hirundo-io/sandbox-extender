import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import type { ActivationMaterializer, MaterializerPermissionManifest, RequestMaterializer } from "./types.js";

export const workingDirectoryPermission = "$WORKING_DIRECTORY";
export const requestResourcePermission = "$REQUEST_RESOURCE";

const permissionNames = ["read", "write", "env", "net", "sys", "run", "ffi"] as const;

function canonicalPermissions(permissions: MaterializerPermissionManifest): MaterializerPermissionManifest {
  return {
    env: [...permissions.env],
    ffi: [...permissions.ffi],
    net: [...permissions.net],
    read: [...permissions.read],
    run: [...permissions.run],
    sys: [...permissions.sys],
    write: [...permissions.write],
  };
}

function pathForms(path: string): readonly string[] {
  const canonical = realpathSync(path);
  return canonical === path ? [path] : [path, canonical];
}

function resolvedPermissions(
  value: string,
  workingDirectory: string,
  requestResource: string | undefined,
): readonly string[] {
  if (value === workingDirectoryPermission) return pathForms(workingDirectory);
  if (value === requestResourcePermission) return requestResource ? pathForms(requestResource) : [];
  return [value];
}

export function assertSelfContainedMaterializer(source: string): void {
  const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
  const unsupported = imports.find((entry) => entry.kind !== "import-statement" || !entry.path.startsWith("node:"));
  if (unsupported) throw new Error(`materializer import is not self-contained: ${unsupported.path}`);
}

export function materializerIntegrity(
  source: string,
  permissions: MaterializerPermissionManifest,
  runtimeVersion: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    permissions: canonicalPermissions(permissions),
    runtimeVersion,
    source,
  })).digest("hex");
}

export function verifyMaterializerIntegrity(
  materializer: ActivationMaterializer | RequestMaterializer,
  source: string,
): void {
  assertSelfContainedMaterializer(source);
  const actual = materializerIntegrity(source, materializer.permissions, materializer.runtimeVersion);
  if (actual !== materializer.integrity) throw new Error(`materializer integrity mismatch for ${materializer.file}`);
}

export function denoPermissionFlags(
  permissions: MaterializerPermissionManifest,
  workingDirectory: string,
  requestResource?: string,
): string[] {
  return permissionNames.flatMap((name) => permissions[name].flatMap((value) =>
    resolvedPermissions(value, workingDirectory, requestResource)
      .map((resolved) => `--allow-${name}=${resolved}`)));
}
