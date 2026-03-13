/**
 * 兼容层 — 内部委托 useProject()，让 Home/AnswerView/IndexManager 的
 * watch(currentRepo) 逻辑无需改动即可跟随项目切换。
 */
import { computed } from 'vue';
import { useProject } from './useProject';
import type { ProjectInfo } from './useProject';

export interface RepoInfo {
  repoName: string;
  hasGraph: boolean;
  totalFiles?: number;
  totalNodes?: number;
  totalEdges?: number;
  lastBuildTime?: string;
}

function toRepoInfo(p: ProjectInfo): RepoInfo {
  return {
    repoName: p.id,
    hasGraph: p.hasGraph,
    totalNodes: p.totalNodes,
    totalEdges: p.totalEdges,
    lastBuildTime: p.lastBuildTime,
  };
}

export function useCurrentRepo() {
  const {
    currentProjectId,
    projects,
    loading,
    fetchProjects,
    switchProject,
  } = useProject();

  const currentRepo = computed({
    get: () => currentProjectId.value,
    set: (v: string) => { currentProjectId.value = v; },
  });

  const repos = computed<RepoInfo[]>(() => projects.value.map(toRepoInfo));

  async function fetchRepos() {
    await fetchProjects();
  }

  async function switchRepo(name: string) {
    await switchProject(name);
  }

  return { currentRepo, repos, loading, fetchRepos, switchRepo };
}
