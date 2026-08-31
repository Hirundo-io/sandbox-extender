export function runFixtureGit(root: string, arguments_: readonly string[]) {
  const environment = {
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
  };
  return Bun.spawnSync({ cmd: ["git", "-C", root, ...arguments_], env: environment });
}
