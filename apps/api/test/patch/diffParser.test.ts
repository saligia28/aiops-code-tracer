/**
 * 统一 diff 解析 + v1 策略（P2-G0）。纯确定性，无 git。
 * 重点：正确识别操作类型（改/增/删/改名/二进制），处理 "--- foo" 内容行伪装陷阱，
 * 策略层挡越界文件与超限。
 */
import { describe, it, expect } from 'vitest';
import {
  parseUnifiedDiff,
  enforceModifyOnlyPolicy,
  type DiffPolicyLimits,
} from '../../src/services/patch/diffParser.js';

const modifyDiff = [
  'diff --git a/src/api/orderVoid.ts b/src/api/orderVoid.ts',
  '--- a/src/api/orderVoid.ts',
  '+++ b/src/api/orderVoid.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('解析普通修改段：路径 / op=modify / hunk 数', () => {
    const p = parseUnifiedDiff(modifyDiff);
    expect(p.files).toHaveLength(1);
    expect(p.files[0].op).toBe('modify');
    expect(p.files[0].isBinary).toBe(false);
    expect(p.files[0].oldPath).toBe('src/api/orderVoid.ts');
    expect(p.files[0].newPath).toBe('src/api/orderVoid.ts');
    expect(p.files[0].hunks).toHaveLength(1);
    expect(p.files[0].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
  });

  it('多 hunk 计数正确', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -10,1 +10,1 @@',
      '-b',
      '+B',
    ].join('\n');
    expect(parseUnifiedDiff(diff).files[0].hunks).toHaveLength(2);
  });

  it('识别新增文件（new file mode → op=add）', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
    ].join('\n');
    const f = parseUnifiedDiff(diff).files[0];
    expect(f.op).toBe('add');
    expect(f.oldPath).toBeNull();
    expect(f.newPath).toBe('new.ts');
  });

  it('识别删除文件（deleted file mode → op=delete）', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect(parseUnifiedDiff(diff).files[0].op).toBe('delete');
  });

  it('识别改名（rename from/to → op=rename）', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    expect(parseUnifiedDiff(diff).files[0].op).toBe('rename');
  });

  it('识别二进制（Binary files → isBinary）', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index abc..def 100644',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    expect(parseUnifiedDiff(diff).files[0].isBinary).toBe(true);
  });

  it('陷阱：hunk 正文里被删的 "-- foo" 行（diff 中呈 "--- foo"）不得被误当文件头', () => {
    const diff = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      ' title',
      '--- foo', // 内容行 "-- foo" 被删除；naive 前缀判断会误认为文件头
      '+-- bar',
      ' end',
    ].join('\n');
    const p = parseUnifiedDiff(diff);
    expect(p.files).toHaveLength(1);
    expect(p.files[0].newPath).toBe('doc.md'); // 未被 "foo" 污染
  });

  it('多文件段分割正确', () => {
    const diff = modifyDiff + [
      'diff --git a/src/api/priceCheck.ts b/src/api/priceCheck.ts',
      '--- a/src/api/priceCheck.ts',
      '+++ b/src/api/priceCheck.ts',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseUnifiedDiff(diff).files).toHaveLength(2);
  });
});

describe('enforceModifyOnlyPolicy', () => {
  const allowed = ['src/api/orderVoid.ts'];

  it('合法修改段通过（返回 null）', () => {
    const p = parseUnifiedDiff(modifyDiff);
    expect(enforceModifyOnlyPolicy(modifyDiff, p, allowed)).toBeNull();
  });

  it('空 diff → DIFF_EMPTY', () => {
    expect(enforceModifyOnlyPolicy('', parseUnifiedDiff(''), allowed)?.code).toBe('DIFF_EMPTY');
  });

  it('新增文件 → DISALLOWED_OP', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hi',
    ].join('\n');
    expect(enforceModifyOnlyPolicy(diff, parseUnifiedDiff(diff), ['new.ts'])?.code).toBe('DISALLOWED_OP');
  });

  it('二进制 → DISALLOWED_OP', () => {
    const diff = ['diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ'].join('\n');
    expect(enforceModifyOnlyPolicy(diff, parseUnifiedDiff(diff), ['i.png'])?.code).toBe('DISALLOWED_OP');
  });

  it('触碰未声明文件 → UNLISTED_FILE', () => {
    const p = parseUnifiedDiff(modifyDiff);
    expect(enforceModifyOnlyPolicy(modifyDiff, p, ['src/api/other.ts'])?.code).toBe('UNLISTED_FILE');
  });

  it('文件数超限 → TOO_MANY_FILES', () => {
    const twoFiles = modifyDiff + ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    const limits: DiffPolicyLimits = { maxFiles: 1, maxHunks: 40, maxBytes: 64 * 1024 };
    expect(enforceModifyOnlyPolicy(twoFiles, parseUnifiedDiff(twoFiles), ['src/api/orderVoid.ts', 'x.ts'], limits)?.code).toBe('TOO_MANY_FILES');
  });

  it('hunk 数超限 → TOO_MANY_HUNKS', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+A', '@@ -5,1 +5,1 @@', '-b', '+B'].join('\n');
    const limits: DiffPolicyLimits = { maxFiles: 10, maxHunks: 1, maxBytes: 64 * 1024 };
    expect(enforceModifyOnlyPolicy(diff, parseUnifiedDiff(diff), ['x.ts'], limits)?.code).toBe('TOO_MANY_HUNKS');
  });

  it('字节超限 → DIFF_TOO_LARGE', () => {
    const limits: DiffPolicyLimits = { maxFiles: 10, maxHunks: 40, maxBytes: 10 };
    expect(enforceModifyOnlyPolicy(modifyDiff, parseUnifiedDiff(modifyDiff), allowed, limits)?.code).toBe('DIFF_TOO_LARGE');
  });
});
