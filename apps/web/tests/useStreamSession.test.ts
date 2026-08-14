import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStreamSession,
  nextTempKey,
  beginStream,
  attachConversationId,
  endStream,
} from '@/hooks/useStreamSession';
import type { ConversationTurn } from '@/hooks/useConversation';

function makeTurns(): ConversationTurn[] {
  return [];
}

beforeEach(() => endStream());

describe('useStreamSession · 流会话单例', () => {
  it('begin 后可读,end 后清空', () => {
    beginStream({ key: 'c1', conversationId: 'c1', turns: makeTurns(), ctrl: new AbortController() });
    expect(getStreamSession()?.key).toBe('c1');
    endStream();
    expect(getStreamSession()).toBeNull();
  });

  it('nextTempKey 单调递增且带 pending: 前缀(不与真实会话 id 空间重叠)', () => {
    const a = nextTempKey();
    const b = nextTempKey();
    expect(a).toMatch(/^pending:\d+$/);
    expect(a).not.toBe(b);
  });

  it('attachConversationId:临时 key 重挂为真实 id,返回旧 key(调用方据此判断视图归属)', () => {
    const temp = nextTempKey();
    beginStream({ key: temp, conversationId: null, turns: makeTurns(), ctrl: new AbortController() });
    const prev = attachConversationId('conv-1');
    expect(prev).toBe(temp);
    expect(getStreamSession()?.key).toBe('conv-1');
    expect(getStreamSession()?.conversationId).toBe('conv-1');
  });

  it('attachConversationId:key 已是真实 id 时幂等', () => {
    beginStream({ key: 'conv-1', conversationId: 'conv-1', turns: makeTurns(), ctrl: new AbortController() });
    expect(attachConversationId('conv-1')).toBe('conv-1');
    expect(getStreamSession()?.key).toBe('conv-1');
  });

  it('attachConversationId:无活动流时返回 null 不抛错', () => {
    expect(attachConversationId('conv-x')).toBeNull();
  });

  it('turns 按引用持有:外部 push 对 session 可见(切回整组还原的前提)', () => {
    const turns = makeTurns();
    beginStream({ key: 'c1', conversationId: 'c1', turns, ctrl: new AbortController() });
    turns.push({ question: 'q', answer: '', renderedAnswer: '', followUp: [], loading: true, error: '', elapsed: 0 });
    expect(getStreamSession()?.turns.length).toBe(1);
  });

  it('重挂后 turns 仍是同一个数组引用(视图切回靠它整组还原)', () => {
    const turns = makeTurns();
    beginStream({ key: nextTempKey(), conversationId: null, turns, ctrl: new AbortController() });
    attachConversationId('conv-2');
    expect(getStreamSession()?.turns).toBe(turns);
  });
});
