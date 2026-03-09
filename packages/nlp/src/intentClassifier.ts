import type { IntentType, IntentResult, QuestionAnalysis } from '@aiops/shared-types';

/**
 * 意图分类器 — 根据用户问题识别查询意图
 * 支持 LLM 驱动 + 关键词规则降级
 */

const INTENT_RULES: { intent: IntentType; keywords: string[] }[] = [
  { intent: 'UI_CONDITION', keywords: ['什么时候展示', '什么时候显示', '什么条件', '是否显示', 'v-if', 'v-show'] },
  { intent: 'CLICK_FLOW', keywords: ['点击后', '点击做了什么', '点击触发', '按钮点击', '事件处理'] },
  { intent: 'DATA_SOURCE', keywords: ['数据从哪', '数据来源', '哪里获取', '接口获取', '从哪来'] },
  { intent: 'API_USAGE', keywords: ['接口在哪', '接口调用', '哪里调的', 'API', '请求'] },
  { intent: 'STATE_FLOW', keywords: ['状态什么时候', '状态变化', '什么时候变', '怎么更新'] },
  { intent: 'COMPONENT_RELATION', keywords: ['组件在哪', '哪里用到', '引用了', '依赖'] },
  { intent: 'PAGE_STRUCTURE', keywords: ['页面结构', '有哪些组件', '组成', '模块有哪些', '有几个tab', '有哪些tab', '有多少tab', '有几个模块', '有哪些模块', '有几个菜单', '有哪些菜单'] },
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

const VALID_INTENTS: IntentType[] = [
  'UI_CONDITION', 'CLICK_FLOW', 'DATA_SOURCE', 'API_USAGE',
  'STATE_FLOW', 'COMPONENT_RELATION', 'PAGE_STRUCTURE', 'ERROR_TRACE', 'GENERAL',
];

/**
 * LLM 驱动的问题分析：意图分类 + 实体提取 + 搜索关键词生成
 * 失败时降级为关键词规则
 */
export async function analyzeQuestion(
  question: string,
  llmCall: (messages: Array<{ role: string; content: string }>) => Promise<string | null>
): Promise<QuestionAnalysis> {
  const fallbackResult = classifyIntent(question);
  const fallback: QuestionAnalysis = {
    intent: fallbackResult.intent,
    confidence: fallbackResult.confidence,
    entities: {},
    searchKeywords: extractKeywordsFromQuestion(question),
  };

  if (fallback.intent !== 'GENERAL' && fallback.confidence >= 0.7) {
    return fallback;
  }

  try {
    const prompt = `分析以下代码相关问题，提取意图和实体。直接输出JSON，不要解释。

意图枚举(选一个最匹配的):
- UI_CONDITION: 问UI展示条件、按钮显示/隐藏规则
- CLICK_FLOW: 问点击按钮后的触发流程
- DATA_SOURCE: 问数据从哪里来
- API_USAGE: 问接口调用、用了哪些接口
- STATE_FLOW: 问状态变化流程
- COMPONENT_RELATION: 问组件关系、哪里引用了组件
- PAGE_STRUCTURE: 问页面结构、组成
- ERROR_TRACE: 问错误/异常链路
- GENERAL: 以上都不匹配

输出格式:
{
  "intent": "枚举值",
  "confidence": 0.0-1.0,
  "entities": {
    "pageName": "页面中文名(如有)",
    "buttonName": "按钮名(如有)",
    "functionName": "函数名(如有)",
    "componentName": "组件名(如有)",
    "apiEndpoint": "接口路径(如有)"
  },
  "searchKeywords": ["关键词1", "关键词2", ...]
}

问题: ${question}`;

    const result = await llmCall([{ role: 'user', content: prompt }]);
    if (!result) return fallback;

    const json = parseJsonSafe(result);
    if (!json) return fallback;

    const intent = VALID_INTENTS.includes(json.intent as IntentType)
      ? (json.intent as IntentType)
      : fallback.intent;
    const confidence = typeof json.confidence === 'number'
      ? Math.min(1, Math.max(0, json.confidence))
      : 0.8;

    const entities: QuestionAnalysis['entities'] = {};
    if (json.entities && typeof json.entities === 'object') {
      const e = json.entities as Record<string, unknown>;
      if (typeof e.pageName === 'string' && e.pageName.trim()) entities.pageName = e.pageName.trim();
      if (typeof e.buttonName === 'string' && e.buttonName.trim()) entities.buttonName = e.buttonName.trim();
      if (typeof e.functionName === 'string' && e.functionName.trim()) entities.functionName = e.functionName.trim();
      if (typeof e.componentName === 'string' && e.componentName.trim()) entities.componentName = e.componentName.trim();
      if (typeof e.apiEndpoint === 'string' && e.apiEndpoint.trim()) entities.apiEndpoint = e.apiEndpoint.trim();
    }

    const llmKeywords = Array.isArray(json.searchKeywords)
      ? json.searchKeywords.filter((k: unknown): k is string => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim())
      : [];
    const searchKeywords = Array.from(new Set([
      ...llmKeywords,
      ...fallback.searchKeywords,
    ])).slice(0, 20);

    // 如果规则分类和 LLM 分类一致，或规则分类是 GENERAL，用 LLM 结果
    const finalIntent = fallback.intent !== 'GENERAL' && fallback.intent !== intent
      ? fallback.intent  // 规则有强信号时优先
      : intent;

    return {
      intent: finalIntent,
      confidence: Math.max(confidence, fallback.confidence),
      entities,
      searchKeywords,
    };
  } catch {
    return fallback;
  }
}

function extractKeywordsFromQuestion(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
