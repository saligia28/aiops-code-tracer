import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AnalyzerError } from './client.js';
import { allTools } from './tools/index.js';

// NOTE: stdio is the JSON-RPC channel — never console.log to stdout. Logs go to stderr.

const server = new McpServer({ name: 'aiops-code-analyzer', version: '0.1.0' });

for (const tool of allTools) {
  server.registerTool(
    tool.name,
    tool.config as Parameters<typeof server.registerTool>[1],
    (async (args: Record<string, unknown>) => {
      try {
        return await tool.handler(args ?? {});
      } catch (err) {
        const msg = err instanceof AnalyzerError ? err.message : `内部错误：${(err as Error).message}`;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }) as Parameters<typeof server.registerTool>[2],
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[aiops-mcp] connected via stdio; tools:', allTools.map((t) => t.name).join(', '));
