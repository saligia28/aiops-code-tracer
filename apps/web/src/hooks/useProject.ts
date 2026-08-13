/**
 * 项目（仓库）列表与当前项目。
 *
 * 状态放在模块级 store 里：顶部选择器、首页、问答页拿到的是同一份，
 * 任何一处切换项目，其它页面立刻跟随（迁移前是模块级的 Vue ref，语义一致）。
 */
import { createStore, useStore } from '@/lib/store';
import http from '@/lib/http';

export type ProjectFramework =
  | 'vue2' | 'vue3'
  | 'react' | 'nextjs'
  | 'angular' | 'svelte'
  | 'typescript' | 'javascript'
  | 'java' | 'python' | 'go'
  | 'other';

export interface ProjectRecord {
  id: string;
  name: string;
  framework: ProjectFramework;
  repoPath: string;
  gitUrl: string;
  scanPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInfo extends ProjectRecord {
  hasGraph: boolean;
  totalNodes?: number;
  totalEdges?: number;
  lastBuildTime?: string;
}

// 框架选项与中文标签：项目下拉（TopProjectSelector）与新建表单（ProjectCreateDialog）共用，
// 集中在此避免两处重复定义。
export const FRAMEWORK_OPTIONS: { value: ProjectFramework; label: string }[] = [
  { value: 'vue3', label: 'Vue 3' },
  { value: 'vue2', label: 'Vue 2' },
  { value: 'react', label: 'React' },
  { value: 'nextjs', label: 'Next.js' },
  { value: 'angular', label: 'Angular' },
  { value: 'svelte', label: 'Svelte' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'other', label: '其他' },
];

export function frameworkLabel(fw: string): string {
  return FRAMEWORK_OPTIONS.find((o) => o.value === fw)?.label ?? fw;
}

const STORAGE_KEY = 'aiops-current-project';

const currentProjectIdStore = createStore<string>(localStorage.getItem(STORAGE_KEY) ?? '');
const projectsStore = createStore<ProjectInfo[]>([]);
const loadingStore = createStore(false);

function persist(id: string) {
  currentProjectIdStore.set(id);
  if (id) {
    localStorage.setItem(STORAGE_KEY, id);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function fetchProjects() {
  loadingStore.set(true);
  try {
    const res = await http.get<{ currentProjectId: string | null; projects: ProjectInfo[] }>(
      '/api/projects',
    );
    projectsStore.set(res.data.projects);

    const saved = localStorage.getItem(STORAGE_KEY);
    const apiCurrent = res.data.currentProjectId;
    const ids = res.data.projects.map((p) => p.id);

    if (saved && ids.includes(saved)) {
      if (saved !== apiCurrent) {
        await http.post(`/api/projects/${saved}/switch`, {});
      }
      persist(saved);
    } else if (apiCurrent && ids.includes(apiCurrent)) {
      persist(apiCurrent);
    } else {
      persist('');
    }
  } finally {
    loadingStore.set(false);
  }
}

async function switchProject(id: string) {
  loadingStore.set(true);
  try {
    await http.post(`/api/projects/${id}/switch`, {});
    persist(id);
  } finally {
    loadingStore.set(false);
  }
}

async function createProject(data: {
  name: string;
  framework: ProjectFramework;
  repoPath: string;
  gitUrl?: string;
  scanPaths?: string[];
}) {
  const res = await http.post<ProjectRecord>('/api/projects', data);
  await fetchProjects();
  return res.data;
}

async function deleteProject(id: string, deleteData = false) {
  await http.delete(`/api/projects/${id}`, { params: deleteData ? { deleteData: 'true' } : {} });
  if (currentProjectIdStore.get() === id) {
    persist('');
  }
  await fetchProjects();
}

async function buildProject(id: string) {
  return http.post(`/api/projects/${id}/build`, {});
}

export function useProject() {
  const currentProjectId = useStore(currentProjectIdStore);
  const projects = useStore(projectsStore);
  const loading = useStore(loadingStore);

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null;

  return {
    currentProjectId,
    currentProjectName: currentProject?.name ?? '',
    currentProject,
    projects,
    loading,
    fetchProjects,
    switchProject,
    createProject,
    deleteProject,
    buildProject,
  };
}
