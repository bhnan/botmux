import { readFileSync, statSync } from 'node:fs';
import { buildDiffCard, parseUnifiedDiff, MAX_INPUT_BYTES, type DiffCardResult } from '../im/lark/diff-card.js';
import { parseDiffFlag, diffUsageError } from '../services/send-policy.js';
import { normalizePositionalSendContent } from '../services/send-content.js';

const BOOLEAN_FLAGS = new Set([
  '--dry-run', '--card', '--text', '--top-level', '--no-quote', '--mention-back',
  '--no-mention', '--anyway', '--voice', '--attention', '--urgent', '--slash',
  '--remote-runner-outbound', '--schedule-remove-self',
]);

function flagName(value: string): string {
  return value.split('=', 1)[0]!;
}

function readUtf8(path: string, maxBytes: number): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`文件类型或大小不符合 diff 输入要求：${path}`);
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new Error(`diff 输入超过大小上限：${path}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Prepare display content only. Routing, identity, callbacks, final, and
 * replay remain entirely inside the ordinary send --card-json path. */
export async function prepareDiffSend(
  args: string[],
  readStdin: () => Promise<string> = async () => '',
): Promise<{ args: string[]; rendered: DiffCardResult }> {
  const flag = parseDiffFlag(args);
  if (flag.error) throw new Error(flag.error);
  if (!flag.requested || !flag.path) throw new Error('--diff 需要 unified diff 文件路径。');
  const names = args.map(flagName);
  const usage = diffUsageError({
    requested: true,
    customCardRequested: names.some(name => ['--card-file', '--card-json'].includes(name)),
    mediaRequested: names.some(name => ['--image', '--images', '--file', '--files', '--video', '--videos', '--video-cover', '--video-covers'].includes(name)),
    voice: names.includes('--voice'), slash: names.includes('--slash'),
  });
  if (usage) throw new Error(usage);
  // Reject invalid input before waiting on an optional stdin summary.
  const files = parseUnifiedDiff(readUtf8(flag.path, MAX_INPUT_BYTES));
  const forwarded: string[] = [];
  const body: string[] = [];
  let contentFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = flagName(arg);
    if (name === '--diff') {
      if (!arg.includes('=')) i++;
    } else if (name === '--content-file') {
      contentFile = arg.includes('=') ? arg.slice('--content-file='.length) : args[++i];
      if (!contentFile) throw new Error('--content-file 需要路径参数。');
    } else if (arg.startsWith('--')) {
      forwarded.push(arg);
      if (!arg.includes('=') && !BOOLEAN_FLAGS.has(name) && i + 1 < args.length) forwarded.push(args[++i]!);
    } else body.push(arg);
  }
  const summary = contentFile
    ? readUtf8(contentFile, 4_000)
    : body.length ? normalizePositionalSendContent(body.join(' ')) : await readStdin();
  const rendered = buildDiffCard(files, { summary });
  return { args: [...forwarded, '--card-json', JSON.stringify(rendered.card)], rendered };
}
