import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, buildDiffCard, escapeMarkdown, CARD_BUDGET } from '../src/im/lark/diff-card.js';

const BASIC = '--- a/docs/stress_test.md\n+++ b/docs/stress_test.md\n@@ -1,3 +1,3 @@\n #文档\n-old_value\n+new_value\n \n';
const panel = (card: any) => card.body.elements.find(e => e.tag === 'collapsible_panel');

test('统一 diff 的真实计数、路径、上下文和空行', () => {
  const files = parseUnifiedDiff(BASIC);
  assert.equal(files[0].path, 'docs/stress_test.md');
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  const output = buildDiffCard(files);
  assert.match(panel(output.card).header.title.content, /stress\\_test/);
  assert.match(panel(output.card).elements[0].content, /color='green'>\+new\\_value/);
  assert.match(panel(output.card).elements[0].content, /color='grey'>·<\/font>/);
  assert.equal(panel(output.card).expanded, false);
});

test('像文件头一样的新增/删除内容仍算真实内容行', () => {
  const files = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n----old\n++++new\n');
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].rows[2].text, '+++new');
});

test('转义 font 字面文本、反斜杠、Markdown 和实体，保留缩进', () => {
  assert.equal(escapeMarkdown('*a* _b_ [c] `d` <font> &nbsp; \\'), '\\*a\\* \\_b\\_ \\[c\\] \\`d\\` \\<font\\> &amp;nbsp; \\\\');
  const files = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-\told\n+    <font color="red"> _x_ &nbsp; \\\n');
  const content = panel(buildDiffCard(files).card).elements[0].content;
  assert.match(content, /\+&nbsp;&nbsp;&nbsp;&nbsp;\\<font/);
  assert.match(content, /-(&nbsp;){4}old/);
  assert.ok(!content.includes('<font color="red">'));
});

test('Git 八进制 UTF-8 quoted 路径可读，时间戳不混入路径', () => {
  const encoded = [...Buffer.from('文档/说明.md')].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('');
  const files = parseUnifiedDiff(`--- "a/${encoded}"\n+++ "b/${encoded}"\n@@ -1 +1 @@\n-a\n+b\n`);
  assert.equal(files[0].path, '文档/说明.md');
  const timestamp = parseUnifiedDiff('--- old file.md\t2026-01-01\n+++ new file.md\t2026-01-02\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(timestamp[0].path, 'new file.md');
});

test('新增、删除、多文件与多个 hunk 的计数', () => {
  const input = '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+one\n+two\n--- a/old.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n--- a/third.md\n+++ b/third.md\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n';
  const output = buildDiffCard(parseUnifiedDiff(input));
  assert.deepEqual(output.stats, {files: 3, added: 4, removed: 3});
  assert.match(output.card.body.elements[1].elements[0].content, /新增文件/);
});

test('No newline 标记、CRLF、rename、mode 和 binary 元数据', () => {
  const newline = parseUnifiedDiff('--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n\\ No newline at end of file\r\n+b\r\n\\ No newline at end of file\r\n');
  assert.equal(newline[0].rows.filter(row => row.kind === '\\').length, 2);
  const rename = parseUnifiedDiff('diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\nold mode 100644\nnew mode 100755\n');
  assert.equal(rename[0].path, 'new.md');
  assert.equal(rename[0].notes.length, 4);
  const binary = parseUnifiedDiff('diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n');
  assert.match(panel(buildDiffCard(binary).card).elements[0].content, /二进制/);
});

test('截断长 Unicode 预览，保留真实计数和 hunk 定位', () => {
  const input = '--- /dev/null\n+++ b/large.md\n@@ -0,0 +1,100 @@\n' + Array.from({length: 100}, (_, i) => '+' + i + '中'.repeat(1_000)).join('\n') + '\n';
  const output = buildDiffCard(parseUnifiedDiff(input));
  assert.equal(output.stats.added, 100);
  assert.equal(output.preview.truncated, true);
  assert.ok(output.bytes <= CARD_BUDGET);
  assert.match(panel(output.card).elements[0].content, /@@ -0,0 \+1,100 @@/);
  assert.match(panel(output.card).header.title.content, /\+100/);
  assert.deepEqual(JSON.parse(JSON.stringify(output.card)), output.card);
});

test('过多文件/过长路径也受整卡预算约束', () => {
  const input = Array.from({length: 40}, (_, i) => `--- a/${i}\n+++ b/${i}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
  const output = buildDiffCard(parseUnifiedDiff(input));
  assert.equal(output.stats.files, 40);
  assert.ok(output.preview.omittedFiles >= 20);
  const giant = parseUnifiedDiff(`--- a/x\n+++ b/${'x'.repeat(30_000)}\n@@ -1 +1 @@\n-a\n+b\n`);
  assert.ok(buildDiffCard(giant).bytes <= CARD_BUDGET);
});

test('无差异、非法 diff、hunk 不完整和参数边界', () => {
  assert.equal(buildDiffCard(parseUnifiedDiff('')).stats.files, 0);
  for (const input of ['not a diff', '--- a/x\n@@ -1 +1 @@\n-a\n+b\n', '--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n+b\n', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+extra\n']) assert.throws(() => parseUnifiedDiff(input));
  assert.throws(() => parseUnifiedDiff('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() => buildDiffCard([], {maxLines: 0}));
  assert.throws(() => buildDiffCard([], {summary: '中'.repeat(1_400)}));
});
