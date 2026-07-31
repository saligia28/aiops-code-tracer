/**
 * §9.6 金额对账（手动脚本，花真钱）：隔离时间窗内「本地记账金额」 vs 「DeepSeek 余额变化」。
 *
 * 动机：价格快照/本地复算只能证明"目录内部自洽"，证明不了目录抄对了官方价、
 * 也证明不了 alias 映射（deepseek-chat → v4-flash）没有指错模型——官方文档不公布映射，
 * 若实际按 v4-pro 计费（未命中 ¥3/M vs ¥1/M），本地所有金额会一致地错 3 倍且自查不出来。
 * 余额差是唯一的外部真值。
 *
 * 用法（记账进临时库，不碰真实 app.db；输出上限压到 100 防长回答干扰）：
 *   AIOPS_DB_PATH=/tmp/reconcile-$(date +%s).db LLM_MAX_TOKENS=100 \
 *     pnpm exec tsx test/eval/_reconcile_balance.ts
 *
 * 纪律：
 *   - 窗口内不要跑 dev 栈 / eval / 任何用同一 key 的东西——余额差会被污染；
 *   - 每个 prompt 内容含时间戳+序号，跨请求绝无缓存命中前缀，未命中价可被干净验证；
 *   - 余额接口只有小数点后 2 位（¥0.01 粒度），所以默认 12 次 × ~10k tokens ≈ ¥0.12，
 *     偏差分辨率约 ±8%；RECONCILE_REQUESTS 可调。
 */
import { LLM_API_KEY } from '../../src/context.ts';
import { callChatCompletion } from '../../src/services/llmService.ts';
import { createUsageTracker } from '../../src/services/usage/usageTracker.ts';
import { getTurnEvents } from '../../src/db/usageStore.ts';

const REQUESTS = Math.max(1, Number(process.env.RECONCILE_REQUESTS ?? 12));
const PROMPT_LINES = 400; // ~1.8 万字符 ≈ 每请求 1 万 token 上下的独特正文

if (!LLM_API_KEY) {
  console.error('LLM_API_KEY 未配置（.env），无法对账。');
  process.exit(1);
}
if (!process.env.AIOPS_DB_PATH) {
  console.error('必须设 AIOPS_DB_PATH 指向临时库——对账流量不该混进真实 app.db 的统计。');
  process.exit(1);
}

async function balance(): Promise<{ nano: number; raw: string }> {
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${LLM_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`balance HTTP ${resp.status}`);
  const json = (await resp.json()) as { balance_infos?: Array<{ currency: string; total_balance: string }> };
  const cny = json.balance_infos?.find((b) => b.currency === 'CNY');
  if (!cny) throw new Error(`余额响应里没有 CNY 条目：${JSON.stringify(json).slice(0, 200)}`);
  return { nano: Math.round(parseFloat(cny.total_balance) * 1e9), raw: cny.total_balance };
}

// 余额监听模式（对账后半程）：DeepSeek 计费入账有延迟（实测 >2 分钟），
// RECONCILE_WAIT_BASELINE=<对账窗口起点余额> 时只轮询余额直到它偏离基线（或 90 分钟放弃）。
if (process.env.RECONCILE_WAIT_BASELINE) {
  const baseline = process.env.RECONCILE_WAIT_BASELINE;
  console.log(`监听余额直到偏离基线 ¥${baseline}（每 60s 一次，上限 90 分钟）…`);
  for (let i = 0; i < 90; i++) {
    const b = await balance();
    const stamp = new Date().toISOString().slice(11, 19);
    if (b.raw !== baseline) {
      console.log(`[${stamp}] 余额已变：¥${baseline} → ¥${b.raw}（差 ¥${(parseFloat(baseline) - parseFloat(b.raw)).toFixed(2)}）`);
      process.exit(0);
    }
    if (i % 5 === 0) console.log(`[${stamp}] 仍为 ¥${b.raw}，继续等…`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.log('90 分钟内余额未变化，放弃监听——请稍后手动复查或对照控制台账单。');
  process.exit(1);
}

/** 独特长正文：行行带 stamp，杜绝与历史请求形成公共前缀（否则命中价会稀释未命中价的验证力）。 */
function buildPrompt(i: number): string {
  const stamp = `${Date.now()}-${process.pid}-${i}`;
  const lines = [`对账材料 ${stamp}：通读下列清单后只回答两个字：收到。不要总结，不要解释。`];
  for (let l = 0; l < PROMPT_LINES; l++) {
    lines.push(
      `第${l}行 校验片段 ${stamp}-${l}：库存同步任务在批次${(l * 7919) % 100000}中记录了${(l * 104729) % 9973}条变更，状态码${(l * 31) % 997}，耗时${(l * 613) % 10000}毫秒。`,
    );
  }
  return lines.join('\n');
}

const fmt = (nano: number) => `¥${(nano / 1e9).toFixed(6)}`;

const before = await balance();
console.log(`窗口开始余额：¥${before.raw}（接口精度：小数点后 ${(before.raw.split('.')[1] ?? '').length} 位）`);
console.log(`发起 ${REQUESTS} 次独特长 prompt 请求（输出上限 ${process.env.LLM_MAX_TOKENS ?? '默认'}）…\n`);

const tracker = createUsageTracker({ projectId: 'reconcile-9-6', pipeline: 'ask', source: 'eval' });
let failed = 0;
for (let i = 0; i < REQUESTS; i++) {
  const out = await callChatCompletion(
    [{ role: 'user', content: buildPrompt(i) }],
    undefined,
    { tracker, stage: 'ask.answer_simple' },
  );
  if (!out) failed++;
  process.stdout.write(`  #${String(i + 1).padStart(2)}/${REQUESTS} ${out ? 'ok' : '❌ 失败'}\n`);
}
const summary = tracker.finish('completed');
const events = getTurnEvents(tracker.turnId);

// 结算稳定化：余额出现变化且连续两次读数相同才收口（计费入账可能有延迟）
let after = await balance();
for (let i = 0; i < 8; i++) {
  if (after.nano !== before.nano) {
    await new Promise((r) => setTimeout(r, 15_000));
    const again = await balance();
    if (again.nano === after.nano) break;
    after = again;
  } else {
    await new Promise((r) => setTimeout(r, 15_000));
    after = await balance();
  }
}

const recorded = summary.knownCostNanoCny;
const delta = before.nano - after.nano;
const dirty = events.filter((e) => e.transportStatus !== 'success' || e.usageSource !== 'provider');

console.log('\n================ §9.6 对账报告 ================');
console.log(`请求：${REQUESTS} 次（失败 ${failed}）  模型：${events[0]?.model ?? '-'}（计价 ${events[0]?.pricing?.matchKind ?? '-'} → ${events[0]?.canonicalModel ?? '-'}）`);
console.log(`Token：命中 ${summary.cacheHitTokens} / 未命中 ${summary.cacheMissTokens} / 输出 ${summary.completionTokens}（reasoning ${summary.reasoningTokens}）`);
console.log(`本地记账：${fmt(recorded)}（${recorded} nano，usageSource 全 provider：${dirty.length === 0 ? '是' : `否——${dirty.length} 条异常`}）`);
console.log(`余额变化：¥${before.raw} → ¥${after.raw}  差 ${fmt(delta)}（粒度 ¥0.01 级）`);
if (delta <= 0) {
  console.log('⚠️ 余额未减少——计费未入账（延迟超过等待窗口）或窗口被其他流量污染，本次对账不可判定。');
} else {
  const diffPct = ((recorded - delta) / delta) * 100;
  console.log(`偏差：本地相对余额差 ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%（余额粒度贡献最多 ±${((0.005e9 / delta) * 100).toFixed(1)}%）`);
  console.log(Math.abs(diffPct) <= 15
    ? '✅ 量级一致：目录价与 alias 映射与真实扣费吻合（在余额粒度分辨率内）。'
    : '❌ 量级不一致：按 §9.6 暂停把本地金额当完整账单，优先检查 base URL / alias / 价格版本 / 漏接调用。');
}
console.log('===============================================');
