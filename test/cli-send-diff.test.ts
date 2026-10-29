import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const patch = '--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-old\n+new\n';
const captured = (stdout: unknown) => String(stdout).split('\n')
  .filter(line => line.startsWith('CAPTURE_REPLY='))
  .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));

describe('send --diff CLI', () => {
  it('dry-run uses the real request budget without session or transport', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-dry-'));
    try {
      const path = join(root, 'change.diff');
      writeFileSync(path, patch);
      const result = spawnSyncTsScript(cli, ['send', '--diff', path, '--dry-run', 'summary'], {
        env: { PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'missing.json') },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const output = JSON.parse(String(result.stdout));
      expect(output.dryRun).toBe(true);
      expect(output.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(output.card)));
      expect(output.fits).toBe(true);
      expect(output.diff.stats).toEqual({ files: 1, added: 1, removed: 1 });
      expect(output.card.body.elements.some((element: { tag: string }) => element.tag === 'collapsible_panel')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { cliId: 'codex', scope: 'thread' },
    { cliId: 'claude-code', scope: 'chat' },
  ])('uses ordinary final/mention/replay for $cliId/$scope', ({ cliId, scope }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-send-'));
    const dataDir = join(root, 'data');
    const appId = 'cli_diff_test';
    const sessionId = 'sid_diff_test';
    const turnId = 'om_diff_turn';
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'test-secret', cliId, replyCardMode: 'unified',
        brandLabel: 'Example assistant', feedback: { enabled: false },
      }]));
      seedPersistedSessionRows(dataDir, appId, { [sessionId]: {
        sessionId, status: 'active', cliId, cliSessionId: 'native_diff', larkAppId: appId,
        chatId: 'oc_test', rootMessageId: 'om_root', scope, chatType: 'group', workingDir: root,
        ownerOpenId: 'ou_requester', lastCallerOpenId: 'ou_requester',
        replyTargets: { [turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester', participants: [{ openId: 'ou_requester', isBot: false }] } },
        turnReplyContexts: { [turnId]: { replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: false } },
      } });
      const path = join(root, 'change.diff');
      writeFileSync(path, patch);
      const run = () => spawnSyncTsScript(fixture, ['send', '--diff', path, '--response-kind', 'final', '--mention-back', '已修改'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId, BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: appId },
        encoding: 'utf8', timeout: 30_000,
      });
      const first = run();
      expect(first.status, String(first.stderr)).toBe(0);
      const requests = captured(first.stdout);
      expect(requests).toHaveLength(1);
      const card = JSON.parse(requests[0].body.content);
      expect(card.body.elements.some((element: { tag: string }) => element.tag === 'collapsible_panel')).toBe(true);
      expect(requests[0].body.content.match(/"element_id":"botmux_reply_footer"/g)).toHaveLength(1);
      expect((requests[0].body.content.match(/<at id=ou_requester>/g) ?? [])).toHaveLength(1);
      const replay = run();
      expect(replay.status, String(replay.stderr)).toBe(0);
      expect(captured(replay.stdout)).toHaveLength(0);
      expect(String(replay.stdout)).toContain('"replayed":true');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
