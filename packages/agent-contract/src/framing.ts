export function stderr(msg: string): void {
  process.stderr.write(`[worker] ${msg}\n`);
}
