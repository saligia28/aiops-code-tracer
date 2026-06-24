// ============================================================
// 问题分类与检索词提取
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================


import { tokenizeForRecall } from './textUtils.js';


export function isApiListQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return /(接口|api|后端)/i.test(q) && /(页面|模块|用了哪些|用了那些|有哪些|调用了哪些|调用了什么)/i.test(q);
}


export function extractPagePhrase(question: string): string | null {
  const cleaned = question.trim().replace(/[？?]/g, '');
  const m1 = cleaned.match(/(.+?)(?:页面|模块).*(?:接口|api|后端)/i);
  const phrase = (m1?.[1] ?? '').trim();
  if (!phrase) return null;
  return phrase.replace(/^(请问|帮我看下|帮我看看|想知道|想问下)/, '').trim();
}


export function extractLikelyScope(question: string): string | null {
  const cleaned = question.trim().replace(/[？?]/g, '');
  const patterns = [
    /(.+?)(?:页面|模块)/,
    /(.+?)里/,
    /(.+?)中/,
  ];
  for (const pattern of patterns) {
    const m = cleaned.match(pattern);
    const phrase = (m?.[1] ?? '').replace(/^(请问|帮我看下|帮我看看|想知道|想问下)/, '').trim();
    if (phrase.length >= 2) return phrase;
  }
  return null;
}


export function isPaginationQuestion(question: string): boolean {
  return /分页|page|pagesize|pagenum|currentpage|每页|页码/i.test(question);
}


export function isPageStructureQuestion(question: string): boolean {
  return /有几个.{0,4}(tab|模块|菜单|页签|标签页)|有哪些.{0,4}(tab|模块|菜单|页签|标签页)|有多少.{0,4}(tab|模块|菜单|页签|标签页)|页面结构|页面组成|包含.{0,4}(哪些|几个).{0,4}(tab|模块|页签)/i.test(question);
}


export function isUiConditionQuestion(question: string): boolean {
  return /什么时候展示|什么时候显示|什么条件|展示逻辑|显示逻辑|按钮|v-if|v-show|可见|隐藏|disabled|置灰|是否可点击/i.test(question);
}


export function isComponentFeatureQuestion(question: string): boolean {
  return /(组件|component|弹窗|对话框|table|表格|选择器|picker|上传|下拉|筛选|排序|校验|通用组件|复用组件|dialog|modal)/i.test(question);
}


export function isFlowQuestion(question: string): boolean {
  return /(怎么走|流程|链路|触发逻辑|触发后|做什么|处理逻辑|调用链)/i.test(question);
}


const QUESTION_TERM_HINTS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /按钮|展示|显示|可见|隐藏|v-if|v-show/i, terms: ['button', 'visible', 'show', 'hide', 'v-if', 'v-show', 'render', 'display'] },
  { pattern: /作废|废弃|取消/i, terms: ['作废', '废弃', '取消', 'discard', 'abolish', 'cancel'] },
  { pattern: /审核|审批|audit/i, terms: ['audit', 'status', '审核', '审批', 'state'] },
  { pattern: /分页|page|pager|pagination/i, terms: ['page', 'pagination', 'currentpage', 'pageno', 'pagesize', 'limit', 'offset', 'total'] },
  { pattern: /列表|表格|table|list/i, terms: ['list', 'table', 'columns', 'query', 'search'] },
  { pattern: /订单|order/i, terms: ['order', 'orders', 'sales', 'purchase'] },
  { pattern: /接口|api|请求|fetch|axios/i, terms: ['api', 'request', 'fetch', 'axios', 'get', 'post'] },
  { pattern: /点击|按钮|click/i, terms: ['click', 'handle', 'submit', 'confirm'] },
];


export function extractSearchTerms(question: string, extraTerms: string[] = []): string[] {
  const rawTokens = tokenizeForRecall(question);

  const expanded: string[] = [];
  for (const hint of QUESTION_TERM_HINTS) {
    if (hint.pattern.test(question)) {
      expanded.push(...hint.terms);
    }
  }

  const unique = Array.from(new Set([...rawTokens, ...expanded, ...extraTerms.map((item) => item.toLowerCase())]));
  return unique.slice(0, 36);
}


const QUESTION_STOP_TERMS = new Set([
  '什么', '怎么', '如何', '时候', '页面', '模块', '功能', '逻辑', '实现', '这个', '那个', '里面', '相关', '一下', '一下子',
  'please', 'about', 'with', 'what', 'when', 'where', 'which', 'that', 'this',
]);


export function extractQuestionCoreTerms(question: string): string[] {
  return tokenizeForRecall(question)
    .filter((term) => term.length >= 2 && !QUESTION_STOP_TERMS.has(term))
    .slice(0, 16);
}


export function extractQuestionComponentHints(question: string): string[] {
  const matches = question.match(/[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)*/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.toLowerCase()).filter((item) => item.length >= 3)));
}


export function extractButtonLabelKeywords(question: string): string[] {
  const labels = new Set<string>();
  const normalized = question.replace(/["""'`]/g, '');
  const m = normalized.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})按钮/);
  if (m?.[1]) labels.add(m[1]);

  const common = ['编辑', '查看', '删除', '作废', '导出', '提交', '保存', '审核', '冻结', '解冻', '核实', '取消'];
  for (const word of common) {
    if (normalized.includes(word)) labels.add(word);
  }
  return Array.from(labels);
}
