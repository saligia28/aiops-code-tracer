/**
 * 路径安全（P2-G0）：写侧目标必须是仓库内相对路径。
 * 挡绝对路径 / .. 穿越 / 归一化后逃逸 / symlink 逃逸；正常嵌套路径归一化通过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRepoRelativePath } from '../../src/services/patch/pathSafety.js';

let repo: string;
let outside: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-path-repo-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-path-out-'));
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/api/orderVoid.ts'), 'x');
  // 仓库内一个指向外部真实目录的软链——用于验证 realpath 逃逸判定
  fs.symlinkSync(outside, path.join(repo, 'link'));
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('checkRepoRelativePath', () => {
  it('正常嵌套相对路径通过并归一化为 POSIX', () => {
    const r = checkRepoRelativePath(repo, 'src/api/orderVoid.ts');
    expect(r.ok).toBe(true);
    expect(r.relPath).toBe('src/api/orderVoid.ts');
    expect(r.absPath).toBe(path.join(repo, 'src/api/orderVoid.ts'));
  });

  it('./ 前缀被剥掉', () => {
    const r = checkRepoRelativePath(repo, './src/api/orderVoid.ts');
    expect(r.ok).toBe(true);
    expect(r.relPath).toBe('src/api/orderVoid.ts');
  });

  it('反斜杠归一化为 POSIX', () => {
    const r = checkRepoRelativePath(repo, 'src\\api\\orderVoid.ts');
    expect(r.ok).toBe(true);
    expect(r.relPath).toBe('src/api/orderVoid.ts');
  });

  it('拒绝绝对路径', () => {
    const r = checkRepoRelativePath(repo, '/etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('绝对路径');
  });

  it('拒绝 .. 穿越', () => {
    const r = checkRepoRelativePath(repo, '../evil.ts');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('穿越');
  });

  it('拒绝归一化后仍逃逸（a/../../x）', () => {
    const r = checkRepoRelativePath(repo, 'a/../../x.ts');
    expect(r.ok).toBe(false);
  });

  it('拒绝经软链逃逸出仓库（link → 外部目录）', () => {
    const r = checkRepoRelativePath(repo, 'link/payload.ts');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('软链');
  });

  it('空路径 / 空仓库路径被拒', () => {
    expect(checkRepoRelativePath(repo, '').ok).toBe(false);
    expect(checkRepoRelativePath('', 'a.ts').ok).toBe(false);
  });
});
