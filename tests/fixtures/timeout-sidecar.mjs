import { appendFileSync } from "node:fs";

if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, `${process.pid}\n`);

const server = Bun.serve({
  port: 0,
  fetch() {
    return Response.json(
      { error: "upstream request timed out", timeout: true },
      { status: 504, headers: { "x-transport-error": "1" } },
    );
  },
});
console.log(`READY ${server.port}`);
