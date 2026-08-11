/**
 * useProject.fetchProjects 的选中策略：
 * 1. 本地记忆有效 → 沿用（必要时同步后端）；
 * 2. 后端有当前项目 → 跟随；
 * 3. 两者皆无但列表非空 → 默认选中第一个项目（本需求新增的兜底）；
 * 4. 列表为空 → 置空，并由 initialized 标记「确实没有项目」供 Home 禁用提问。
 *
 * 模块顶层就读 localStorage，node 环境必须先 stubGlobal 再动态 import；
 * 每个用例 resetModules 拿全新的单例状态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/http', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

import http from '@/lib/http';

const mockGet = vi.mocked(http.get);
const mockPost = vi.mocked(http.post);

function project(id: string) {
  return {
    id,
    name: id,
    framework: 'vue3',
    repoPath: `/repos/${id}`,
    gitUrl: '',
    scanPaths: [],
    createdAt: '',
    updatedAt: '',
    hasGraph: false,
  };
}

async function loadUseProject() {
  vi.resetModules();
  const mod = await import('@/composables/useProject');
  return mod.useProject();
}

beforeEach(() => {
  store.clear();
  mockGet.mockReset();
  mockPost.mockReset();
  mockPost.mockResolvedValue({ data: {} } as never);
});

describe('fetchProjects 选中策略', () => {
  it('无本地记忆且后端无当前项目时，默认选中第一个项目并同步后端', async () => {
    mockGet.mockResolvedValue({
      data: { currentProjectId: null, projects: [project('p1'), project('p2')] },
    } as never);

    const { fetchProjects, currentProjectId, initialized } = await loadUseProject();
    await fetchProjects();

    expect(mockPost).toHaveBeenCalledWith('/api/projects/p1/switch', {});
    expect(currentProjectId.value).toBe('p1');
    expect(initialized.value).toBe(true);
  });

  it('本地记忆有效时沿用本地记忆，不落到第一个项目', async () => {
    store.set('aiops-current-project', 'p2');
    mockGet.mockResolvedValue({
      data: { currentProjectId: 'p2', projects: [project('p1'), project('p2')] },
    } as never);

    const { fetchProjects, currentProjectId } = await loadUseProject();
    await fetchProjects();

    expect(mockPost).not.toHaveBeenCalled();
    expect(currentProjectId.value).toBe('p2');
  });

  it('本地记忆已失效（项目被删）时回落到第一个项目', async () => {
    store.set('aiops-current-project', 'ghost');
    mockGet.mockResolvedValue({
      data: { currentProjectId: null, projects: [project('p1')] },
    } as never);

    const { fetchProjects, currentProjectId } = await loadUseProject();
    await fetchProjects();

    expect(mockPost).toHaveBeenCalledWith('/api/projects/p1/switch', {});
    expect(currentProjectId.value).toBe('p1');
  });

  it('项目列表为空时置空选中，initialized 置真供 Home 判定「暂无项目」', async () => {
    mockGet.mockResolvedValue({
      data: { currentProjectId: null, projects: [] },
    } as never);

    const { fetchProjects, currentProjectId, initialized } = await loadUseProject();

    expect(initialized.value).toBe(false);
    await fetchProjects();

    expect(mockPost).not.toHaveBeenCalled();
    expect(currentProjectId.value).toBe('');
    expect(initialized.value).toBe(true);
  });
});
