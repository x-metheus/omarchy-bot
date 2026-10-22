'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

let lease;
try {
  if (Number(process.versions.node.split('.')[0]) < 24 || typeof process.execve !== 'function') {
    throw new Error('Managed MCP packages require Node 24 or newer with process.execve');
  }
  const manifest = path.resolve(process.argv[2]);
  const root = path.dirname(manifest);
  if (fs.realpathSync(root) !== root || fs.lstatSync(manifest).isSymbolicLink()) throw new Error('Unsafe managed MCP installation');
  const leases = path.join(root, 'leases');
  fs.mkdirSync(leases, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(leases) !== leases) throw new Error('Unsafe managed MCP lease directory');
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(startTime)) throw new Error('Cannot establish managed MCP process identity');
  lease = path.join(leases, `${process.pid}-${randomUUID()}.json`);
  // Establish the lease BEFORE selecting a version. A collector seeing an
  // unselected live lease retains every version until selection completes.
  fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, startTime, directory: null }), { flag: 'wx', mode: 0o600 });
  const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (record.retired || !record.current || !/^[0-9a-f-]{36}$/.test(record.current.directory)) throw new Error('Managed MCP package is no longer available');
  const directory = path.join(root, 'versions', record.current.directory);
  if (fs.realpathSync(directory) !== directory) throw new Error('Unsafe managed MCP version directory');
  const entry = fs.realpathSync(path.resolve(directory, record.current.entry));
  const relative = path.relative(directory, entry);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) throw new Error('Unsafe managed MCP executable');
  fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, startTime, directory: record.current.directory }), { mode: 0o600 });
  // POSIX replacement retains PID/start-time and stdio. There is no extra MCP
  // proxy, child supervisor, copied protocol stream, or idle wrapper process.
  // The collector removes the lease only when that exact process has exited.
  process.execve(process.execPath, [process.execPath, entry, ...process.argv.slice(3)], process.env);
} catch (error) {
  if (lease) { try { fs.unlinkSync(lease); } catch {} }
  process.stderr.write(`Managed MCP package could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
