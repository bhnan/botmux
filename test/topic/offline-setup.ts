import { vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const deny = (): never => { throw new Error('Offline topic tests forbid network and child processes'); };
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
syncBuiltinESMExports();
