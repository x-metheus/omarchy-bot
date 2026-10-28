import "node:net";

declare module "node:net" {
  // Bun wraps an already-connected socket-fd without a path or TCP port.
  function createConnection(options: { fd: number }): Socket;
}
