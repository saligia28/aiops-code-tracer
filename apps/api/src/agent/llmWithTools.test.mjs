import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatCompletionRequestBody } from './llmWithTools.ts';

test('buildChatCompletionRequestBody sanitizes risky escape sequences in message content', () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: String.raw`regex \xFF and unicode \u12 and safe \\x` },
  ];

  const body = buildChatCompletionRequestBody(messages, [], {
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTokens: 1024,
  });

  assert.deepEqual(body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: String.raw`regex \\xFF and unicode \\u12 and safe \\x` },
  ]);
});
