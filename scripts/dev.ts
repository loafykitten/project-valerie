export {};

const children = [
  Bun.spawn(["bun", "--watch", "apps/server/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "--cwd", "apps/dashboard", "dev"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const code = await Promise.race(children.map((child) => child.exited));
stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = code;
