/**
 * 兼容层 — 内部委托 useProject()，让 Home/AnswerView/IndexManager 里
 * 「跟随当前仓库刷新」的逻辑无需关心项目模型细节。
 */
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
  const { currentProjectId, projects, loading, fetchProjects, switchProject } = useProject();

  return {
    currentRepo: currentProjectId,
    repos: projects.map(toRepoInfo),
    loading,
    fetchRepos: fetchProjects,
    switchRepo: switchProject,
  };
}
