import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDiffSend } from '../src/cli/send-diff.js';
import { parseDiffFlag, diffUsageError } from '../src/services/send-policy.js';

const patch = '--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-old\n+new\n';

describe('core --diff policy', () => {
  it('parses absent, separate and equals values like other send flags', () => {
    expect(parseDiffFlag(['hello'])).toEqual({ requested: false });
    expect(parseDiffFlag(['--diff', '/tmp/有 空格.diff'])).toEqual({ requested: true, path: '/tmp/有 空格.diff' });
    expect(parseDiffFlag(['--diff=/tmp/a.diff'])).toEqual({ requested: true, path: '/tmp/a.diff' });
  });

  it.each([['--diff'], ['--diff='], ['--diff', '--no-mention'], ['--diff', '-'], ['--diff', '/dev/stdin'], ['--diff=x', '--diff=y']].map(args => ({ args })))('rejects missing/ambiguous paths $args', ({ args }) => {
    expect(parseDiffFlag(args)).toMatchObject({ requested: true, error: expect.any(String) });
  });

  it('rejects incompatible display modes without changing ordinary send', () => {
    const defaults = { requested: true, customCardRequested: false, mediaRequested: false, voice: false, slash: false };
    expect(diffUsageError(defaults)).toBeNull();
    for (const option of ['customCardRequested', 'mediaRequested', 'voice', 'slash']) {
      expect(diffUsageError({ ...defaults, [option]: true })).toEqual(expect.any(String));
    }
    expect(diffUsageError({ ...defaults, requested: false, mediaRequested: true })).toBeNull();
  });
});

describe('diff payload preparation', () => {
  it('preserves routing/final/mention args and moves summary into the card', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-diff-'));
    try {
      const path = join(directory, 'change.diff');
      writeFileSync(path, patch);
      const result = await prepareDiffSend(['--diff', path, '--response-kind', 'final', '--mention', 'ou_x:User', '--quote', 'om_x', '--attention=help', 'first\\n\\nsecond']);
      expect(result.args.slice(0, -2)).toEqual(['--response-kind', 'final', '--mention', 'ou_x:User', '--quote', 'om_x', '--attention=help']);
      expect(result.args.at(-2)).toBe('--card-json');
      const card = JSON.parse(result.args.at(-1)!);
      expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: 'first\n\nsecond' });
      expect(result.rendered.stats).toEqual({ files: 1, added: 1, removed: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps content-file precedence and supports an explicit stdin summary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-diff-'));
    try {
      const path = join(directory, 'change.diff');
      const summary = join(directory, 'summary.md');
      writeFileSync(path, patch);
      writeFileSync(summary, 'file summary\n');
      const file = await prepareDiffSend([`--diff=${path}`, '--content-file', summary, 'ignored'], async () => { throw new Error('must not read stdin'); });
      expect(file.rendered.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'file summary\n' });
      expect(file.args).not.toContain('--content-file');
      const piped = await prepareDiffSend(['--diff', path, '--no-mention'], async () => 'stdin\nsummary');
      expect(piped.rendered.card.body.elements[0]).toEqual({ tag: 'markdown', content: 'stdin\nsummary' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects invalid UTF-8, unsupported inputs and incomplete hunks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-diff-'));
    try {
      const path = join(directory, 'change.diff');
      writeFileSync(path, Buffer.from([0xff]));
      await expect(prepareDiffSend(['--diff', path], async () => { throw new Error('must not wait for stdin'); })).rejects.not.toThrow('must not wait for stdin');
      writeFileSync(path, patch);
      for (const flag of ['--card-file=x', '--card-json={}', '--files=x', '--voice', '--slash']) {
        await expect(prepareDiffSend(['--diff', path, flag])).rejects.toThrow();
      }
      writeFileSync(path, '--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n+b\n');
      await expect(prepareDiffSend(['--diff', path])).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
