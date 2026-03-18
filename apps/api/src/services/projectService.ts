import fs from 'fs';
import path from 'path';
import type { ProjectRecord, ProjectFramework } from '@aiops/shared-types';
import { DATA_DIR, PROJECTS_FILE } from '../context.js';

export function readProjectRegistry(): ProjectRecord[] {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')) as ProjectRecord[];
  } catch {
    return [];
  }
}

export function writeProjectRegistry(projects: ProjectRecord[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || `project-${Date.now()}`;
}

export function toParserFramework(fw: ProjectFramework): 'vue2' | 'vue3' {
  if (fw === 'vue2') return 'vue2';
  return 'vue3';
}
