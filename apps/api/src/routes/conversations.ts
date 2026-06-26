import type { FastifyInstance } from 'fastify';
import { resolveActiveProjectId } from '../context.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  getConversationWithMessages,
  listConversations,
  renameConversation,
} from '../db/conversationStore.js';

// ============================================================
// 对话路由：会话列表 / 建会话 / 取消息恢复 / 重命名 / 删除
// currentProjectId 是可变绑定，import 后直接读其当前值。
// ============================================================

export function registerConversations(app: FastifyInstance): void {
  // 当前项目的会话列表（updated_at DESC）；无当前项目返回 []
  app.get('/api/conversations', async (_request, reply) => {
    try {
      return listConversations(resolveActiveProjectId());
    } catch (error) {
      return reply.code(500).send({
        error: 'CONVERSATION_LIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 在当前项目下建会话；无当前项目用 'default'
  app.post('/api/conversations', async (request, reply) => {
    try {
      const body = (request.body as { title?: string }) || {};
      return createConversation(resolveActiveProjectId(), body.title?.trim() || undefined);
    } catch (error) {
      return reply.code(500).send({
        error: 'CONVERSATION_CREATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 取会话 + 消息（刷新恢复）；无则 404
  app.get('/api/conversations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const conversation = getConversationWithMessages(id);
      if (!conversation) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      return conversation;
    } catch (error) {
      return reply.code(500).send({
        error: 'CONVERSATION_GET_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 重命名，返回最新 Conversation；无则 404
  app.patch('/api/conversations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = (request.body as { title?: string }) || {};
      if (!getConversation(id)) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      renameConversation(id, (body.title ?? '').trim());
      return getConversation(id);
    } catch (error) {
      return reply.code(500).send({
        error: 'CONVERSATION_RENAME_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 删除（级联删消息）
  app.delete('/api/conversations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      deleteConversation(id);
      return { ok: true };
    } catch (error) {
      return reply.code(500).send({
        error: 'CONVERSATION_DELETE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
