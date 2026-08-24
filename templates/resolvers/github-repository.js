const { localTarget, requestArguments } = await Bun.stdin.json();
const command = requestArguments.command;

if (typeof command !== "string") {
  process.exit(1);
}

if (!/^\s*gh\b/.test(command)) {
  console.log(localTarget);
  process.exit(0);
}

const repositoryPattern =
  /(?:^|\s)--repo(?:=|\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=\s|$)/;
const repository = command.match(repositoryPattern)?.[1];

if (!repository) {
  process.exit(1);
}

console.log(`github:repository:${repository.toLowerCase()}`);
