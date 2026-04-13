import { ref, computed } from 'vue';
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

const STORAGE_KEY = 'aiops-current-project';

const currentProjectId = ref<string>(localStorage.getItem(STORAGE_KEY) ?? '');
const projects = ref<ProjectInfo[]>([]);
const loading = ref(false);

const currentProject = computed(() =>
  projects.value.find((p) => p.id === currentProjectId.value) ?? null,
);
const currentProjectName = computed(() => currentProject.value?.name ?? '');

function persist(id: string) {
  currentProjectId.value = id;
  if (id) {
    localStorage.setItem(STORAGE_KEY, id);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function fetchProjects() {
  loading.value = true;
  try {
    const res = await http.get<{ currentProjectId: string | null; projects: ProjectInfo[] }>(
      '/api/projects',
    );
    projects.value = res.data.projects;

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
    loading.value = false;
  }
}

async function switchProject(id: string) {
  loading.value = true;
  try {
    await http.post(`/api/projects/${id}/switch`, {});
    persist(id);
  } finally {
    loading.value = false;
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
  if (currentProjectId.value === id) {
    persist('');
  }
  await fetchProjects();
}

async function buildProject(id: string) {
  return http.post(`/api/projects/${id}/build`, {});
}

export function useProject() {
  return {
    currentProjectId,
    currentProjectName,
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
