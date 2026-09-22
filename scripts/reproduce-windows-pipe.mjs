import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
if (process.platform !== "win32")
  throw new Error("Windows-only named-pipe reproduction");
const endpoint = `\\\\.\\pipe\\swarm-pipe-repro-${randomUUID()}`;
const sockets = [];
const server = createServer((socket) => {
  sockets.push(socket);
  socket.on("data", (data) => socket.write(data));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(endpoint, resolve);
});
const clients = [];
try {
  for (let index = 0; index < 2; index++) {
    const socket = createConnection(endpoint);
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const echo = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`client ${index} received no echo`)),
        1500,
      );
      socket.once("data", (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
      socket.write(`client-${index}`);
    });
    console.log(
      JSON.stringify({
        runtime: process.versions.bun
          ? `bun ${process.versions.bun}`
          : `node ${process.versions.node}`,
        index,
        echo,
      }),
    );
  }
  if (process.argv.includes("--duplicate")) {
    const duplicate = createServer();
    const error = await new Promise((resolve) => {
      duplicate.once("error", resolve);
      duplicate.listen(endpoint, () =>
        resolve(new Error("Unexpected duplicate bind success")),
      );
    });
    console.log(JSON.stringify({ duplicateBind: error.code ?? error.message }));
    if (duplicate.listening)
      await new Promise((resolve) => duplicate.close(resolve));
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  for (const socket of [...clients, ...sockets]) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
