export interface DiffRow {
  kind: string;
  text: string;
}

export interface DiffFile {
  path: string;
  oldPath: string;
  newPath: string;
  rows: DiffRow[];
  notes: string[];
  added: number;
  removed: number;
  header: boolean;
  binary: boolean;
}

export interface DiffCard {
  schema: '2.0';
  body: { elements: Record<string, unknown>[] };
}

export interface DiffCardResult {
  card: DiffCard;
  bytes: number;
  stats: { files: number; added: number; removed: number };
  preview: { files: number; rows: number; truncated: boolean; omittedFiles: number };
}

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const CARD_BUDGET = 18_000;

function fail(line: number, detail: string): never {
  throw new Error(`diff 第 ${line} 行：${detail}`);
}

function decodePath(raw: string): string {
  if (!raw.startsWith('"')) return raw.split('\t')[0];
  const bytes: number[] = [];
  const escapes: Record<string, number> = {n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34};
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '"') return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(bytes));
    if (raw[i] === '\\') {
      const char = raw[++i];
      if (/[0-7]/.test(char ?? '')) {
        const octal = raw.slice(i).match(/^[0-7]{1,3}/)![0];
        const value = parseInt(octal, 8);
        if (value > 255) throw new Error('Git 路径的八进制转义无效');
        bytes.push(value);
        i += octal.length - 1;
      } else if (Object.hasOwn(escapes, char)) bytes.push(escapes[char]);
      else throw new Error('Git 路径的转义无效');
    } else {
      const point = raw.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    }
  }
  throw new Error('Git 路径引号未闭合');
}

function pathLabel(raw: string): string {
  const decoded = decodePath(raw);
  return decoded === '/dev/null' ? decoded : decoded.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(input: string): DiffFile[] {
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new Error('diff 输入超过 2MiB');
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let pendingOld: string | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;

  const createFile = (): DiffFile => {
    const next: DiffFile = {path: '文件', oldPath: '', newPath: '', rows: [], notes: [], added: 0, removed: 0, header: false, binary: false};
    files.push(next);
    return next;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (pendingOld !== undefined) {
      if (!file) fail(i + 1, '文件头缺少旧路径');
      if (!line.startsWith('+++ ')) fail(i + 1, '缺少 +++ 文件头');
      file.oldPath = pathLabel(pendingOld);
      file.newPath = pathLabel(line.slice(4));
      file.path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
      file.header = true;
      if (file.oldPath === '/dev/null') file.notes.push('新增文件');
      if (file.newPath === '/dev/null') file.notes.push('删除文件');
      pendingOld = undefined;
      continue;
    }
    if (line === '\\ No newline at end of file') {
      if (!file?.rows.length || file.rows.at(-1)!.kind === '@') fail(i + 1, '换行标记缺少对应内容行');
      file.rows.push({kind: '\\', text: line});
      continue;
    }
    if (oldRemaining || newRemaining) {
      if (!file) fail(i + 1, 'hunk 缺少文件');
      const kind = line[0];
      if (!['+', '-', ' '].includes(kind)) fail(i + 1, 'hunk 内容行缺少 +、- 或空格前缀');
      if (kind !== '+' && oldRemaining-- <= 0) fail(i + 1, '旧版本行数超出 hunk 声明');
      if (kind !== '-' && newRemaining-- <= 0) fail(i + 1, '新版本行数超出 hunk 声明');
      file.rows.push({kind, text: line.slice(1)});
      if (kind === '+') file.added++;
      if (kind === '-') file.removed++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      file = createFile();
      const match = line.match(/^diff --git ("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/);
      if (match) file.path = pathLabel(match[2]);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!file || file.header || file.rows.length) file = createFile();
      pendingOld = line.slice(4);
      continue;
    }
    if (line.startsWith('@@')) {
      if (!file?.header) fail(i + 1, 'hunk 缺少文件头');
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
      if (!match) fail(i + 1, 'hunk 头格式无效');
      const values = [match[1], match[2] ?? '1', match[3], match[4] ?? '1'].map(Number);
      if (!values.every(Number.isSafeInteger)) fail(i + 1, 'hunk 数字超出范围');
      oldRemaining = values[1];
      newRemaining = values[3];
      file.rows.push({kind: '@', text: line});
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      if (!file) fail(i + 1, '重命名元数据缺少文件');
      file.oldPath = decodePath(line.replace(/^(rename|copy) from /, ''));
      file.notes.push(`原路径：${file.oldPath}`);
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      if (!file) fail(i + 1, '重命名元数据缺少文件');
      file.path = file.newPath = decodePath(line.replace(/^(rename|copy) to /, ''));
      file.notes.push(line.startsWith('rename') ? '重命名文件' : '复制文件');
      continue;
    }
    if (/^(Binary files |GIT binary patch)/.test(line)) {
      if (!file) fail(i + 1, '二进制标记缺少文件');
      file.binary = true;
      file.notes.push('二进制变更，无法显示文本 diff');
      continue;
    }
    if (file?.binary) continue;
    if (/^(new file mode|deleted file mode|old mode|new mode) /.test(line)) {
      if (!file) fail(i + 1, '模式元数据缺少文件');
      file.notes.push(line);
      continue;
    }
    if (line === '' || line.startsWith('diff ') || /^index |^(dis)?similarity index /.test(line)) continue;
    fail(i + 1, '不支持的 unified diff 内容');
  }
  if (pendingOld !== undefined || oldRemaining || newRemaining) fail(lines.length, '文件头或 hunk 不完整');
  if (!files.length && input.trim()) throw new Error('输入没有 unified diff 文件头');
  return files;
}

export function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/\\/g, '\\\\').replace(/([*_`\[\]~<>])/g, '\\$1');
}

function displayPath(value: string): string {
  const controls: Record<string, string> = {'\r': '\\r', '\n': '\\n', '\t': '\\t', '\0': '\\0'};
  return value.replace(/[\r\n\t\0]/g, char => controls[char]!);
}

function renderRow(row: DiffRow): string {
  const color = row.kind === '+' ? 'green' : row.kind === '-' ? 'red' : 'grey';
  const prefix = ['+', '-'].includes(row.kind) ? row.kind : row.kind === ' ' ? '·' : '';
  let content = escapeMarkdown(row.text);
  const indent = content.match(/^[ \t]*/)![0].replace(/\t/g, '    ');
  content = '&nbsp;'.repeat(indent.length) + content.slice(content.match(/^[ \t]*/)![0].length);
  return `<font color='${color}'>${prefix}${content}</font>`;
}

export function buildDiffCard(files: DiffFile[], {summary = '', maxLines = 60}: { summary?: string; maxLines?: number } = {}): DiffCardResult {
  if (Buffer.byteLength(summary, 'utf8') > 4_000) throw new Error('摘要超过 4000 UTF-8 字节');
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 200) throw new Error('max-lines 需要为 1–200');
  const stats = {files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0)};
  let count = Math.min(files.length, 20);
  let limit = maxLines;
  function assemble(): DiffCardResult {
    const elements: Record<string, unknown>[] = [];
    if (summary) elements.push({tag: 'markdown', content: summary});
    elements.push({tag: 'markdown', content: files.length ? `共 ${stats.files} 个文件，+${stats.added} / -${stats.removed}。完整内容请查看原始 diff 文件。` : '未检测到内容差异。'});
    let truncated = count < files.length;
    let shownRows = 0;
    for (const f of files.slice(0, count)) {
      const shown = f.rows.slice(0, limit);
      shownRows += shown.length;
      const lines = [...f.notes.map(note => `<font color='grey'>${escapeMarkdown(displayPath(note))}</font>`), ...shown.map(renderRow)];
      if (shown.length < f.rows.length) {
        truncated = true;
        lines.push(`<font color='grey'>预览已截断：展示 ${shown.length}/${f.rows.length} 行，完整内容请查看原始 diff 文件。</font>`);
      }
      if (!lines.length) lines.push("<font color='grey'>无文本内容变化。</font>");
      elements.push({
        tag: 'collapsible_panel', expanded: false,
        header: {
          title: {tag: 'markdown', content: `**${escapeMarkdown(displayPath(f.path))}** <font color='green'>+${f.added}</font> <font color='red'>-${f.removed}</font>`},
          icon: {tag: 'standard_icon', token: 'down-small-ccm_outlined'},
          icon_position: 'right', icon_expanded_angle: -180,
        },
        border: {color: 'grey', corner_radius: '5px'}, padding: '8px 8px 8px 8px',
        elements: [{tag: 'markdown', content: lines.join('\n')}],
      });
    }
    if (count < files.length) elements.push({tag: 'markdown', content: `另外 ${files.length - count} 个文件未展开预览，完整内容请查看原始 diff 文件。`});
    const card: DiffCard = {schema: '2.0', body: {elements}};
    return {card, bytes: Buffer.byteLength(JSON.stringify(card), 'utf8'), stats, preview: {files: count, rows: shownRows, truncated, omittedFiles: files.length - count}};
  }
  let result = assemble();
  while (result.bytes > CARD_BUDGET && (limit > 1 || count > 0)) {
    if (limit > 1) limit = Math.max(1, Math.floor(limit / 2));
    else count = Math.floor(count / 2);
    result = assemble();
  }
  if (result.bytes > CARD_BUDGET) throw new Error('卡片摘要超过预览预算');
  return result;
}
