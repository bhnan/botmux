import { expect, it } from 'vitest';
import { request } from 'node:https';
import { connect } from 'node:net';
import { execSync } from 'node:child_process';

it('fails closed before any transport or child-process side effect', () => {
  expect(() => fetch('https://example.invalid')).toThrow('Offline');
  expect(() => request('https://example.invalid')).toThrow('Offline');
  expect(() => connect(7891, '127.0.0.1')).toThrow('Offline');
  expect(() => execSync('echo must-not-run')).toThrow('Offline');
});
