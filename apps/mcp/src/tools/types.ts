import type { ZodRawShape } from 'zod';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDescriptor {
  name: string;
  config: { title?: string; description: string; inputSchema: ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}
