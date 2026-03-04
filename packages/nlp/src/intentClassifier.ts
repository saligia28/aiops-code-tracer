import type { IntentType, IntentResult } from '@aiops/shared-types';

/**
 * 意图分类器 — 根据用户问题识别查询意图
 * MVP 阶段使用关键词规则 + LLM 兜底
 */

const INTENT_RULES: { intent: IntentType; keywords: string[] }[] = [
  { intent: 'UI_CONDITION', keywords: ['什么时候展示', '什么时候显示', '什么条件', '是否显示', 'v-if', 'v-show'] },
  { intent: 'CLICK_FLOW', keywords: ['点击后', '点击做了什么', '点击触发', '按钮点击', '事件处理'] },
  { intent: 'DATA_SOURCE', keywords: ['数据从哪', '数据来源', '哪里获取', '接口获取', '从哪来'] },
  { intent: 'API_USAGE', keywords: ['接口在哪', '接口调用', '哪里调的', 'API', '请求'] },
  { intent: 'STATE_FLOW', keywords: ['状态什么时候', '状态变化', '什么时候变', '怎么更新'] },
  { intent: 'COMPONENT_RELATION', keywords: ['组件在哪', '哪里用到', '引用了', '依赖'] },
  { intent: 'PAGE_STRUCTURE', keywords: ['页面结构', '有哪些组件', '组成', '模块有哪些'] },
  { intent: 'ERROR_TRACE', keywords: ['报错', '错误', '异常', 'error', '出错'] },
];

export function classifyIntent(question: string): IntentResult {
  const lowerQ = question.toLowerCase();

  for (const rule of INTENT_RULES) {
    for (const keyword of rule.keywords) {
      if (lowerQ.includes(keyword)) {
        return {
          intent: rule.intent,
          entities: {},
          confidence: 0.7,
        };
      }
    }
  }

  return {
    intent: 'GENERAL',
    entities: {},
    confidence: 0.5,
  };
}
