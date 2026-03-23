import fs from 'fs';
import path from 'path';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import type { GraphStore } from '@aiops/graph-core';
import type { AgentToolDef } from '@aiops/shared-types';

const execFile = promisify(execFileCb);

// ============================================================
// 工具定义（OpenAI function calling 格式）
// ============================================================

export const toolDefinitions: AgentToolDef[] = [
  {
    name: 'search_code',
    description: '在目标仓库中搜索代码内容（正则或关键词）。返回匹配的文件路径和行内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索关键词或正则表达式' },
        glob: { type: 'string', description: '可选的文件过滤 glob，如 "*.vue" 或 "src/**/*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: '读取目标仓库中指定文件的内容。可指定起始行和行数来读取文件片段。设置 lineCount 为 0 可读取全文。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '相对于仓库根目录的文件路径' },
        startLine: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
        lineCount: { type: 'number', description: '读取行数，默认 200。设为 0 读取全文' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'search_in_file',
    description: '在指定文件中搜索关键词或正则，返回所有匹配行及其前后上下文。适合已知文件路径、需要定位具体逻辑的场景。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '相对于仓库根目录的文件路径' },
        pattern: { type: 'string', description: '搜索关键词或正则表达式' },
        contextLines: { type: 'number', description: '每个匹配点前后展示的行数，默认 5' },
      },
      required: ['filePath', 'pattern'],
    },
  },
  {
    name: 'list_files',
    description: '列出目标仓库中匹配 glob 模式的文件列表。',
    parameters: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'glob 模式，如 "src/**/*.vue" 或 "*.ts"' },
      },
      required: ['glob'],
    },
  },
  {
    name: 'find_symbol',
    description: '在代码知识图谱中搜索符号（函数、变量、组件等）。返回符号的类型、文件位置和关联信息。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '符号名称（支持模糊匹配）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'batch_find_symbols',
    description: '批量搜索多个符号（函数、变量、组件等）。一次查多个符号比逐个调 find_symbol 更高效。',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '符号名称列表（每个支持模糊匹配）',
        },
      },
      required: ['names'],
    },
  },
  {
    name: 'trace_calls',
    description: '追踪符号的调用链路。可选正向追踪（该符号调用了什么）或反向追踪（谁调用了该符号）。',
    parameters: {
      type: 'object',
      properties: {
        symbolId: { type: 'string', description: '图谱节点 ID，格式: "type:filePath:name"' },
        direction: { type: 'string', enum: ['forward', 'backward'], description: '追踪方向：forward=正向，backward=反向' },
        depth: { type: 'number', description: '追踪深度，默认 3' },
      },
      required: ['symbolId', 'direction'],
    },
  },
  {
    name: 'list_directory',
    description: '列出目标仓库中指定目录的结构（文件和子目录）。',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: '相对于仓库根目录的目录路径，默认为根目录' },
        depth: { type: 'number', description: '递归深度，默认 2' },
      },
    },
  },
];

/** 生成 OpenAI function calling 格式的 tools 数组 */
export function getOpenAITools(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return toolDefinitions.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ============================================================
// 工具执行
// ============================================================

const MAX_RESULT_CHARS = 3000;

function truncate(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... (已截断，共 ${text.length} 字符)`;
}

/** 执行指定工具 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  graphStore: GraphStore | null,
  repoPath: string,
): Promise<string> {
  try {
    switch (toolName) {
      case 'search_code':
        return await toolSearchCode(repoPath, args.pattern as string, args.glob as string | undefined);
      case 'read_file':
        return toolReadFile(repoPath, args.filePath as string, args.startLine as number | undefined, args.lineCount as number | undefined);
      case 'search_in_file':
        return toolSearchInFile(repoPath, args.filePath as string, args.pattern as string, args.contextLines as number | undefined);
      case 'list_files':
        return await toolListFiles(repoPath, args.glob as string);
      case 'find_symbol':
        return toolFindSymbol(graphStore, args.name as string);
      case 'batch_find_symbols':
        return toolBatchFindSymbols(graphStore, args.names as string[]);
      case 'trace_calls':
        return toolTraceCalls(graphStore, args.symbolId as string, args.direction as string, args.depth as number | undefined);
      case 'list_directory':
        return toolListDirectory(repoPath, args.dirPath as string | undefined, args.depth as number | undefined);
      default:
        return `未知工具: ${toolName}`;
    }
  } catch (err) {
    return `工具执行出错: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- search_code ----
async function toolSearchCode(repoPath: string, pattern: string, glob?: string): Promise<string> {
  if (!repoPath || !pattern) return '缺少参数: pattern';

  // 优先使用 ripgrep（rg），性能更好且默认忽略 .gitignore 文件
  const useRg = hasCommand('rg');

  if (useRg) {
    const args = [
      '--no-heading', '-n', '--max-count', '30',
      '--max-filesize', '1M',
    ];
    if (glob) args.push('--glob', glob);
    args.push(pattern, '.');
    try {
      const { stdout } = await execFile('rg', args, {
        cwd: repoPath,
        timeout: 15000,
        maxBuffer: 1024 * 512,
        encoding: 'utf-8',
      });
      if (!stdout.trim()) return '未找到匹配内容';
      return truncate(stdout.trim());
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      if (execErr.code === 1) return '未找到匹配内容';
      if (execErr.stdout && typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
        return truncate(execErr.stdout.trim());
      }
      // rg 失败则降级到 grep
    }
  }

  // 降级：使用 grep -E（扩展正则，支持 | 等运算符）
  const args = [
    '-r', '-E', '-n',
    '--include', glob || '*',
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=dist',
    '--exclude-dir=.nuxt',
    '--exclude-dir=.next',
    '-m', '30',
    pattern, '.',
  ];
  try {
    const { stdout } = await execFile('grep', args, {
      cwd: repoPath,
      timeout: 15000,
      maxBuffer: 1024 * 512,
      encoding: 'utf-8',
    });
    if (!stdout.trim()) return '未找到匹配内容';
    return truncate(stdout.trim());
  } catch (err: unknown) {
    const execErr = err as { code?: number; stdout?: string; message?: string };
    // grep 返回 1 表示无匹配
    if (execErr.code === 1) return '未找到匹配内容';
    if (execErr.stdout && typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
      return truncate(execErr.stdout.trim());
    }
    return `搜索执行失败: ${execErr.message?.slice(0, 100) ?? '未知错误'}`;
  }
}

/** 检测系统中是否存在某命令 */
let _commandCache: Record<string, boolean> = {};
function hasCommand(cmd: string): boolean {
  if (cmd in _commandCache) return _commandCache[cmd];
  try {
    execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 3000 });
    _commandCache[cmd] = true;
    return true;
  } catch {
    _commandCache[cmd] = false;
    return false;
  }
}

// ---- read_file ----
function toolReadFile(repoPath: string, filePath: string, startLine?: number, lineCount?: number): string {
  if (!repoPath || !filePath) return '缺少参数: filePath';

  const fullPath = path.resolve(repoPath, filePath);
  // 安全检查：不允许读取仓库目录之外的文件
  if (!fullPath.startsWith(path.resolve(repoPath))) return '路径不合法：超出仓库范围';

  if (!fs.existsSync(fullPath)) return `文件不存在: ${filePath}`;

  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(0, (startLine ?? 1) - 1);
  // lineCount 为 0 → 读全文；未传 → 默认 200
  const count = lineCount === 0 ? lines.length : (lineCount ?? 200);
  const slice = lines.slice(start, start + count);
  const header = `[${filePath}] 共 ${lines.length} 行，显示 ${start + 1}-${start + slice.length}:\n`;
  const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
  return truncate(header + numbered);
}

// ---- search_in_file ----
function toolSearchInFile(repoPath: string, filePath: string, pattern: string, contextLines?: number): string {
  if (!repoPath || !filePath) return '缺少参数: filePath';
  if (!pattern) return '缺少参数: pattern';

  const fullPath = path.resolve(repoPath, filePath);
  if (!fullPath.startsWith(path.resolve(repoPath))) return '路径不合法：超出仓库范围';
  if (!fs.existsSync(fullPath)) return `文件不存在: ${filePath}`;

  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const ctx = Math.min(contextLines ?? 5, 15);

  // 编译正则，失败则降级为字面匹配
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  // 收集匹配行号
  const matchLineNos: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) matchLineNos.push(i);
  }

  if (matchLineNos.length === 0) return `在 ${filePath} 中未找到匹配: ${pattern}`;

  // 合并相邻匹配的上下文区间，避免重复输出
  const regions: Array<{ start: number; end: number }> = [];
  for (const lineNo of matchLineNos) {
    const regionStart = Math.max(0, lineNo - ctx);
    const regionEnd = Math.min(lines.length - 1, lineNo + ctx);
    const last = regions[regions.length - 1];
    if (last && regionStart <= last.end + 1) {
      // 与上一个区间相邻或重叠，合并
      last.end = Math.max(last.end, regionEnd);
    } else {
      regions.push({ start: regionStart, end: regionEnd });
    }
  }

  // 构建输出
  const output: string[] = [];
  output.push(`[${filePath}] 共 ${lines.length} 行，匹配 ${matchLineNos.length} 处：`);

  for (const region of regions.slice(0, 10)) {
    if (output.length > 1) output.push('---');
    for (let i = region.start; i <= region.end; i++) {
      const marker = regex.test(lines[i]) ? '>' : ' ';
      output.push(`${marker} ${i + 1}: ${lines[i]}`);
    }
  }

  if (regions.length > 10) {
    output.push(`\n... 还有 ${regions.length - 10} 个匹配区域未显示`);
  }

  return truncate(output.join('\n'));
}

// ---- list_files ----
async function toolListFiles(repoPath: string, glob: string): Promise<string> {
  if (!repoPath || !glob) return '缺少参数: glob';

  // 使用 find 命令简单实现 glob 匹配
  try {
    const { stdout } = await execFile('find', ['.', '-path', `./${glob}`, '-type', 'f'], {
      cwd: repoPath,
      timeout: 10000,
      maxBuffer: 1024 * 128,
      encoding: 'utf-8',
    });
    const files = stdout.trim().split('\n').filter(Boolean).slice(0, 50);
    if (files.length === 0) return '未找到匹配文件';
    return truncate(files.join('\n'));
  } catch {
    // 降级：递归列出后过滤
    try {
      const { stdout } = await execFile('find', ['.', '-type', 'f', '-name', path.basename(glob)], {
        cwd: repoPath,
        timeout: 10000,
        maxBuffer: 1024 * 128,
        encoding: 'utf-8',
      });
      const files = stdout.trim().split('\n').filter(Boolean).slice(0, 50);
      if (files.length === 0) return '未找到匹配文件';
      return truncate(files.join('\n'));
    } catch {
      return '文件列表查询失败';
    }
  }
}

// ---- find_symbol ----
function toolFindSymbol(graphStore: GraphStore | null, name: string): string {
  if (!graphStore) return '图谱未加载';
  if (!name) return '缺少参数: name';

  const nodes = graphStore.searchByName(name).slice(0, 15);
  if (nodes.length === 0) return `未找到符号: ${name}`;

  const lines = nodes.map(
    (n) => `[${n.type}] ${n.name}  📄 ${n.filePath}:${n.loc}  (ID: ${n.id})`,
  );
  return truncate(lines.join('\n'));
}

// ---- batch_find_symbols ----
function toolBatchFindSymbols(graphStore: GraphStore | null, names: string[]): string {
  if (!graphStore) return '图谱未加载';
  if (!names || names.length === 0) return '缺少参数: names';

  const sections: string[] = [];
  for (const name of names.slice(0, 10)) {
    const nodes = graphStore.searchByName(name).slice(0, 10);
    if (nodes.length === 0) {
      sections.push(`### ${name}\n未找到符号`);
    } else {
      const lines = nodes.map(
        (n) => `[${n.type}] ${n.name}  📄 ${n.filePath}:${n.loc}  (ID: ${n.id})`,
      );
      sections.push(`### ${name}\n${lines.join('\n')}`);
    }
  }
  return truncate(sections.join('\n\n'));
}

// ---- trace_calls ----
function toolTraceCalls(
  graphStore: GraphStore | null,
  symbolId: string,
  direction: string,
  depth?: number,
): string {
  if (!graphStore) return '图谱未加载';
  if (!symbolId) return '缺少参数: symbolId';

  const d = depth ?? 3;
  const result =
    direction === 'forward'
      ? graphStore.traceForward(symbolId, d)
      : graphStore.traceBackward(symbolId, d);

  if (result.nodes.length === 0) return `未找到节点: ${symbolId}`;

  const lines: string[] = [];
  lines.push(`${direction === 'forward' ? '正向' : '反向'}追踪 ${symbolId}（深度 ${d}）：`);
  lines.push(`节点 (${result.nodes.length}):`);
  for (const n of result.nodes.slice(0, 20)) {
    lines.push(`  [${n.type}] ${n.name} — ${n.filePath}:${n.loc}`);
  }
  lines.push(`边 (${result.edges.length}):`);
  for (const e of result.edges.slice(0, 20)) {
    lines.push(`  ${e.from} --${e.type}--> ${e.to}`);
  }
  return truncate(lines.join('\n'));
}

// ---- list_directory ----
function toolListDirectory(repoPath: string, dirPath?: string, depth?: number): string {
  if (!repoPath) return '仓库路径未配置';

  const targetDir = path.resolve(repoPath, dirPath || '.');
  if (!targetDir.startsWith(path.resolve(repoPath))) return '路径不合法：超出仓库范围';
  if (!fs.existsSync(targetDir)) return `目录不存在: ${dirPath || '.'}`;

  const maxDepth = Math.min(depth ?? 2, 4);
  const lines: string[] = [];

  function walk(dir: string, prefix: string, currentDepth: number) {
    if (currentDepth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 排除常见非业务目录
    const filtered = entries
      .filter((e) => !['node_modules', '.git', 'dist', '.nuxt', '.next', '.aiops'].includes(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of filtered.slice(0, 40)) {
      const icon = entry.isDirectory() ? '📁' : '📄';
      lines.push(`${prefix}${icon} ${entry.name}`);
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix + '  ', currentDepth + 1);
      }
    }
  }

  walk(targetDir, '', 0);
  if (lines.length === 0) return '目录为空';
  return truncate(lines.join('\n'));
}
