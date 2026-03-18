import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import type { ProjectRecord, ProjectFramework } from '@aiops/shared-types';
import {
  DATA_DIR,
  graphStore,
  currentProjectId,
  currentRepoName,
  indexTaskState,
  setCurrentProjectId,
  setGraphStore,
  setCurrentRepoName,
} from '../context.js';
import { readProjectRegistry, writeProjectRegistry, slugify, toParserFramework } from '../services/projectService.js';
import { loadGraph, executeIndexBuild, buildRepoConfig } from '../services/indexService.js';

export function registerProjects(app: FastifyInstance): void {
  app.get('/api/projects', async () => {
    const projects = readProjectRegistry();
    const result = projects.map((p) => {
      const repoDir = path.join(DATA_DIR, p.id);
      const graphPath = path.join(repoDir, 'graph.json');
      const metaPath = path.join(repoDir, 'meta.json');
      const hasGraph = fs.existsSync(graphPath);
      let totalNodes: number | undefined;
      let totalEdges: number | undefined;
      let lastBuildTime: string | undefined;
      if (hasGraph && fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          totalNodes = meta.totalNodes;
          totalEdges = meta.totalEdges;
          lastBuildTime = meta.finishedAt ?? meta.lastBuildTime;
        } catch { /* ignore */ }
      }
      return { ...p, hasGraph, totalNodes, totalEdges, lastBuildTime };
    });
    return { currentProjectId, projects: result };
  });

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body as {
      name?: string;
      framework?: ProjectFramework;
      repoPath?: string;
      gitUrl?: string;
      scanPaths?: string[];
    }) || {};

    if (!body.name?.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '项目名称不能为空' });
    }
    if (!body.repoPath?.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '本地仓库路径不能为空' });
    }

    const projects = readProjectRegistry();
    const id = slugify(body.name);
    if (projects.some((p) => p.id === id)) {
      return reply.code(409).send({ error: 'DUPLICATE_ID', message: `项目 ID "${id}" 已存在` });
    }

    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id,
      name: body.name.trim(),
      framework: body.framework ?? 'vue3',
      repoPath: path.resolve(body.repoPath.trim()),
      gitUrl: body.gitUrl?.trim() ?? '',
      scanPaths: body.scanPaths && body.scanPaths.length > 0
        ? body.scanPaths.map((s) => s.trim()).filter(Boolean)
        : ['src'],
      createdAt: now,
      updatedAt: now,
    };

    projects.push(record);
    writeProjectRegistry(projects);

    fs.mkdirSync(path.join(DATA_DIR, id), { recursive: true });

    return reply.code(201).send(record);
  });

  app.put('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as Partial<Pick<ProjectRecord, 'name' | 'framework' | 'repoPath' | 'gitUrl' | 'scanPaths'>>) || {};

    const projects = readProjectRegistry();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
    }

    const project = projects[idx];
    if (body.name !== undefined) project.name = body.name.trim();
    if (body.framework !== undefined) project.framework = body.framework;
    if (body.repoPath !== undefined) project.repoPath = path.resolve(body.repoPath.trim());
    if (body.gitUrl !== undefined) project.gitUrl = body.gitUrl.trim();
    if (body.scanPaths !== undefined) project.scanPaths = body.scanPaths.map((s) => s.trim()).filter(Boolean);
    project.updatedAt = new Date().toISOString();

    projects[idx] = project;
    writeProjectRegistry(projects);
    return project;
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { deleteData?: string };
    const projects = readProjectRegistry();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
    }

    projects.splice(idx, 1);
    writeProjectRegistry(projects);

    if (query.deleteData === 'true') {
      const dataDir = path.join(DATA_DIR, id);
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }

    if (currentProjectId === id) {
      setCurrentProjectId(null);
      setGraphStore(null);
      setCurrentRepoName(null);
    }

    return { message: `项目 ${id} 已删除` };
  });

  app.get('/api/projects/:id/relations', async (request, reply) => {
    const { id } = request.params as { id: string };
    const projects = readProjectRegistry();
    const target = projects.find((p) => p.id === id);
    if (!target) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
    }

    const risks: string[] = [];

    if (currentProjectId === id) {
      risks.push('该项目是当前活跃项目，删除后将取消选中');
    }

    const graphPath = path.join(DATA_DIR, id, 'graph.json');
    if (fs.existsSync(graphPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id, 'meta.json'), 'utf-8'));
        risks.push(`该项目已构建图谱（${meta.totalNodes ?? 0} 个节点），删除数据后不可恢复`);
      } catch {
        risks.push('该项目已构建图谱，删除数据后不可恢复');
      }
    }

    if (target.repoPath) {
      const siblings = projects.filter(
        (p) => p.id !== id && p.repoPath && p.repoPath === target.repoPath,
      );
      if (siblings.length > 0) {
        const names = siblings.map((p) => p.name).join('、');
        risks.push(`与项目「${names}」共享同一仓库路径 (${target.repoPath})`);
      }
    }

    if (target.repoPath) {
      const overlapping = projects.filter((p) => {
        if (p.id === id || !p.repoPath) return false;
        const a = path.resolve(target.repoPath);
        const b = path.resolve(p.repoPath);
        return a !== b && (b.startsWith(a + '/') || a.startsWith(b + '/'));
      });
      if (overlapping.length > 0) {
        const names = overlapping.map((p) => p.name).join('、');
        risks.push(`仓库路径与项目「${names}」存在嵌套关系`);
      }
    }

    return { id, risks };
  });

  app.post('/api/projects/:id/switch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const projects = readProjectRegistry();
    const project = projects.find((p) => p.id === id);
    if (!project) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
    }

    setCurrentProjectId(id);
    const ok = loadGraph(id, app.log);
    return {
      message: ok ? `已切换到项目 ${project.name}` : `已切换到项目 ${project.name}（图谱未构建）`,
      projectId: id,
      projectName: project.name,
      graphLoaded: ok,
      totalNodes: graphStore?.nodeCount ?? 0,
      totalEdges: graphStore?.edgeCount ?? 0,
    };
  });

  app.post('/api/projects/:id/build', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (indexTaskState.status === 'building') {
      return reply.code(409).send({
        error: 'INDEX_BUILD_RUNNING',
        message: '已有索引任务在运行中',
        status: indexTaskState,
      });
    }

    const projects = readProjectRegistry();
    const project = projects.find((p) => p.id === id);
    if (!project) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
    }

    if (!fs.existsSync(project.repoPath)) {
      return reply.code(400).send({ error: 'REPO_PATH_INVALID', message: `仓库路径不存在: ${project.repoPath}` });
    }

    const config = buildRepoConfig(project.repoPath, project.id, project.scanPaths, {
      framework: toParserFramework(project.framework),
    }, app.log);
    void executeIndexBuild({
      repoPath: config.repoPath,
      repoName: project.id,
      scanPaths: config.scanPaths,
      mode: 'full',
    }, app.log);

    setCurrentProjectId(id);

    return {
      message: '索引构建任务已提交',
      status: 'building',
      projectId: id,
      projectName: project.name,
    };
  });
}
