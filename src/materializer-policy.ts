import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  ActivationMaterializer,
  MaterializerPermissionManifest,
  RequestMaterializer,
} from "./types.js";

export const workingDirectoryPermission = "$WORKING_DIRECTORY";
export const requestResourcePermission = "$REQUEST_RESOURCE";
export const activationWorkspacePermission = "$ACTIVATION_WORKSPACE";

const permissionNames = ["read", "write", "env", "net", "sys", "run", "ffi"] as const;

function canonicalPermissions(
  permissions: MaterializerPermissionManifest,
): MaterializerPermissionManifest {
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
  return [realpathSync(path)];
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolvedPermissions(
  value: string,
  workingDirectory: string,
  requestResource: string | undefined,
  activationArguments: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  if (value === workingDirectoryPermission) return pathForms(workingDirectory);
  if (value === requestResourcePermission) return requestResource ? pathForms(requestResource) : [];
  if (value === activationWorkspacePermission) {
    const workspace = activationArguments?.workspace;
    return typeof workspace === "string" && isAbsolute(workspace) ? pathForms(workspace) : [];
  }
  return [value];
}

export function assertSelfContainedMaterializer(
  source: string,
  _dependencies?: ActivationMaterializer["dependencies"],
): void {
  const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
  const unsupported = imports.find(
    (entry) =>
      entry.kind !== "import-statement" ||
      (!entry.path.startsWith("node:") && entry.path !== "graphql"),
  );
  if (unsupported)
    throw new Error(`materializer import is not self-contained: ${unsupported.path}`);
}

export function materializerIntegrity(
  source: string,
  permissions: MaterializerPermissionManifest,
  runtimeVersion: string,
  dependencies?: ActivationMaterializer["dependencies"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        permissions: canonicalPermissions(permissions),
        runtimeVersion,
        source,
        dependencies: dependencies && {
          denoLock: dependencies.denoLock,
          denoLockIntegrity: dependencies.denoLockIntegrity,
          directory: dependencies.directory,
          packageJson: dependencies.packageJson,
          packageJsonIntegrity: dependencies.packageJsonIntegrity,
        },
      }),
    )
    .digest("hex");
}

export function verifyMaterializerIntegrity(
  materializer: ActivationMaterializer | RequestMaterializer,
  source: string,
): void {
  assertSelfContainedMaterializer(source, materializer.dependencies);
  const actual = materializerIntegrity(
    source,
    materializer.permissions,
    materializer.runtimeVersion,
    materializer.dependencies,
  );
  if (actual !== materializer.integrity)
    throw new Error(`materializer integrity mismatch for ${materializer.file}`);
}

export function denoPermissionFlags(
  permissions: MaterializerPermissionManifest,
  workingDirectory: string,
  requestResource?: string,
  activationArguments?: Readonly<Record<string, unknown>>,
): string[] {
  const usesRequestResource = permissionNames.some((name) =>
    permissions[name].includes(requestResourcePermission),
  );
  if (requestResource && usesRequestResource) {
    const canonicalResource = realpathSync(requestResource);
    const canonicalWorkingDirectory = realpathSync(workingDirectory);
    if (canonicalResource !== resolve(requestResource)) {
      throw new Error("approved request resource must be a canonical path");
    }
    if (!isWithin(canonicalResource, canonicalWorkingDirectory)) {
      throw new Error("materializer working directory is outside the approved request resource");
    }
  }
  return permissionNames.flatMap((name) =>
    permissions[name].flatMap((value) =>
      resolvedPermissions(value, workingDirectory, requestResource, activationArguments).map(
        (resolved) => `--allow-${name}=${resolved}`,
      ),
    ),
  );
}
