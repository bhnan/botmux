import { vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const deny = vi.hoisted(() => (): never => { throw new Error('Offline topic tests forbid network and child processes'); });
// Bun keeps named builtin exports separately from the default object; syncBuiltinESMExports
// is not enough there. Replace the module exports as well, before importing any subject.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});
// Replace transports, not just credentials. Even an accidental loopback call cannot hit the live fleet.
vi.stubGlobal('fetch', deny);
vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(deny);
vi.spyOn(tls, 'connect').mockImplementation(deny);
for (const transport of [http, https]) {
  vi.spyOn(transport, 'request').mockImplementation(deny);
  vi.spyOn(transport, 'get').mockImplementation(deny);
}
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  vi.spyOn(childProcess, method).mockImplementation(deny);
}
vi.spyOn(childProcess.ChildProcess.prototype, 'spawn').mockImplementation(deny);
syncBuiltinESMExports();
