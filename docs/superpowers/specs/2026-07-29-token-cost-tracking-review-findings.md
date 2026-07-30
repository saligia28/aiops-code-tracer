# Token 成本追踪 · 交付评审问题清单

> 日期：2026-07-29
> 评审对象：`feat/token-cost-tracking` 分支（`0d17ba9`…`abcb813`，共 9 个提交，+4300/-124）
> 对照基准：[设计文档](./2026-07-29-token-cost-tracking-design.md)（下文 §N 均指其小节）
> 验证状态：6 个新测试套件 82 用例全绿；API 全套件 325 通过 / 3 跳过，无回归
> 状态标记：每项修复后请把 `[ ]` 勾掉并附提交号

## 总体结论

完成度约 85–90%，**核心记账链路未发现严重 bug**。"并发不串账、失败不伪装零成本、
exactly-once 终态、events 可复算"四条硬纪律贯彻一致。缺口集中在外围：
eval runner 离线 judge 未接入、`REFLECT_JUDGE` 反思裁决漏记、MCP/补丁页展示缺失。

分阶段：

| 阶段 | 完成度 | 备注 |
|---|---|---|
| 1 契约与计价 | ✅ 100% | §16.1 测试矩阵全覆盖 |
| 2 存储地基 | ✅ 100% | 含 `busy_timeout=5000`（§11.3.1） |
| 3 全链路采集 | ⚠️ ~90% | 缺 P1 / P2 两个采集口 |
| 4 API 与 UI | ⚠️ ~85% | 缺补丁页面板 / MCP 摘要 / 恢复重轮询 / Web 单测 |
| 5 活体验收 | ⚠️ 部分 | §21.5 已自我标注未做项，但漏了 P1/P2 |

---

## P1（中高）eval runner 直连 judge 完全未接入成本追踪

- [ ] 状态：未修复

**现象**：`apps/api/test/eval/run.ts:244`、`:287`、`:394` 三处直接调用
`judgeAnswer(...)`，均未传 usage context，也从未创建 `pipeline='eval'` 的 tracker。

**后果**：

- `LlmPipeline` 的 `'eval'` 与 `LlmUsageStage` 的 `'eval.judge'`
  （`packages/shared-types/src/index.ts:465`、`:512`）是**永不被写入的死枚举值**；
- 每轮评测的三票 judge（评测中最贵的开销之一）整体不记账，`parent_turn_id` 关联不存在；
- 阶段 3 完成门槛（"Eval Judge 所有生成式 LLM 调用均有归属"）与验收 §18.15/§18.17 未达成；
- §11.3.1 为"第二写进程"铺的 `busy_timeout` 地基铺了但没人用；
- 提交 `9d5eaaa` 声称 trace 抽样 judge 是"最后一个未记账的 LLM 入口"，与事实不符。

**注意**：`source='eval'` 的分组（ask/agent 请求打标）**已经做了**（`run.ts:167`、`:317`），
§21.4 验收里的 eval turn 就是它。缺的只是 runner 自己发起的 judge 投票。

**修复要点**（按 §11.3 / §11.3.1）：

1. runner 里为每条 case 的 judge 投票创建无 conversation 的
   `createUsageTracker({ pipeline: 'eval', source: 'eval' })`，stage 用 `eval.judge`；
2. `askServer` / `askAgent` 解析响应中的 `turnId`，作为 `parentTurnId` 传入；
3. eval 侧写失败按既有降级路径（degraded tracker），runner 结束时打印
   「本次评测有 N 次 usage 未持久化」，不允许静默（§11.3.1 第 3 条）；
4. 补测试：「API server 持写锁期间 eval 进程写入 → 成功或明确降级并计数」（§16.4 末条）。

**验收**：跑一轮 eval 后，`llm_usage_turns` 出现 `pipeline='eval'` 行且
`parent_turn_id` 指向对应 ask/agent turn；缓存命中的票 0 event（§11.3 既有语义）。

**建议**：独立分支单独做（涉及第二写进程测试，工作量不小）。

---

## P2（中）`REFLECT_JUDGE=1` 时反思裁决漏记账

- [x] 状态：已修复（455bc56，fix/usage-review-p2-p3；agent 侧 finalizeAnswer 拆
  reflectionUsage/retryUsage 两个上下文，回归见 test/reflectionUsage.test.ts）

**现象**：`apps/api/src/services/ask/reflection.ts:113` 调 `judgeAnswer(..., 1)` 不传
usage，而 `judgeAnswer` 有可选 usage 参数（`apps/api/src/services/answerJudge.ts:302`）。
`reflectOnAnswer` 自身也不接收 usage context，两个调用方都传不进来：

- ask 路由：`apps/api/src/routes/ask.ts:639` 附近；
- agent：`apps/api/src/agent/agentLoop.ts:282`。

**后果**：开启 `REFLECT_JUDGE=1` 后每次回答多一次真实 LLM 调用（可能走独立
`JUDGE_LLM_*` 模型），静默不入账；`ask.reflection` / `agent.reflection` 是死枚举。
默认关闭所以当前不出血，但一开就漏、且漏得不显眼——正是设计明令禁止的失败方式。

**修复要点**：`reflectOnAnswer` 增加可选 `usage?: LlmUsageContext` 入参，透传给
L2 的 `judgeAnswer`；ask 侧传 `usageCtx('ask.reflection')`，agent 侧传
`usageCtx('agent.reflection')`。改动量约 5 行 + 单测。

**验收**：`REFLECT_JUDGE=1` 下一次回答的 turn 中出现 `ask.reflection`（或
`agent.reflection`）event，独立 judge 模型时记录其真实 provider/model（§11.3）。

---

## P3（中低）流式调用 HTTP 层失败不记 event

- [x] 状态：已修复（455bc56，fix/usage-review-p2-p3；回归见 usageAdapter.test.ts
  「HTTP 层直接失败」用例）

**现象**：`apps/api/src/services/llmService.ts:436` `callChatCompletionStream` 里
`!resp.ok || !resp.body` 直接 `return null`，没有 `reportUsage`。

**后果**：流式请求收到 4xx/5xx 时，这次真实供应商请求消失于账目——`callCount`
少计、"流式失败率"看不到 HTTP 类失败。与两处既有口径不一致：

- 非流式 `callApiCompatibleChatCompletion` 的 HTTP 错误**记** `error` event（`:275`）；
- `llmWithTools.ts:110` 的注释即"先记账再抛：这次调用真的发生过"。

**修复要点**：`!resp.ok` 分支补一条
`reportUsage({ transportStatus: 'error', deliveryMode: 'stream', errorKind: httpErrorKind(resp.status), ... })`
再 return null。补 adapter 单测（流式 500 → 1 条 error event）。

---

## P4（低）内网模式无 API key 时 fallback stage 误标

- [ ] 状态：未修复

**现象**：`callChatCompletionStream` 在 intranet 且无 API 兜底时**未发任何请求**就
返回 null（`llmService.ts:406`）。但两处 fallback stage 推导只看"是否 SSE"：

- `apps/api/src/services/ask/answer.ts:563` 的 `triedStream = Boolean(streamOpts?.onDelta)`；
- `apps/api/src/routes/ask.ts:610` 的 `usageCtx(sse ? 'ask.answer_complex_fallback' : ...)`。

**后果**：纯内网无 key 的配置下，所有 SSE 回答被标成 `*_fallback`，污染 §11.1
极力保护的"流式失败率"指标。仅影响该配置（当前部署不受影响）。

**修复要点**：让 `callChatCompletionStream` 能区分"没尝试"（返回 null 前未发请求）
与"尝试失败"——例如返回值加判别（`null` vs `{ attempted: false }`），或按 §11.1 原案
把"上一次流式尝试是否失败"的状态放到 adapter/tracker 侧。修 P3 时一并处理最顺。

---

## P5（低）MCP 侧两处缺失

- [ ] 状态：未修复

1. **patch 来源误标**：`apps/mcp/src/tools/proposePatch.ts:33` 请求体不带
   `source: 'mcp'`，服务端 `apps/api/src/routes/proposePatch.ts` 按 `'web'` 兜底 →
   MCP 发起的 patch turn 全部记成 web，违反 §11.5"Web/MCP 分别标 source"。
   修复：请求体加一个字段即可。
2. **紧凑成本摘要未渲染**：§4.5 要求"MCP 返回中附加紧凑成本摘要"。API 响应已带
   `turnId`/`tokenUsageSummary`，但 `apps/mcp/src/format.ts` 与各工具均不渲染。
   修复：`formatProposal`（及可选地 ask 类工具输出）末尾追加一行
   `成本：N tokens · ¥X（partial 时标注）`。

---

## P6（低）Web 侧缺失

- [ ] 状态：未修复

1. **补丁页无成本面板**：`ProposePatch.vue` / `useProposePatch.ts` 零改动，
   `/api/propose-patch` 响应里的 `tokenUsageSummary` 被丢弃（§13.1、阶段 4 交付项
   "补丁提案结果成本摘要"）。修复：patch 结果区挂同一 `TokenUsagePanel`，
   数据直接来自响应，不写 conversation meta（§13.1 原案）。
2. **恢复后不重新轮询**：§12.4 要求"从历史会话恢复到 unsettled summary 时重新轮询"。
   现状 `startPolling` 只在 SSE done 帧触发（`apps/web/src/views/AnswerView.vue:567`
   的 `captureUsage`），刷新后 pending 的摘要一直显示"结算中"，直到手动展开
   （展开走 `loadUsageDetail` 单次刷新，算部分缓解）。修复：`messagesToTurns` 恢复
   summary 后，对 `settled=false` 的 turn 调 `startPolling`。
3. **Web 单测缺失**：§16.6 列的用例一个都没有（提交只声称 typecheck+build）。
   最低限度补 `useTokenUsage`（轮询去重/30s 上限/失败不覆盖）与
   `TokenUsagePanel`（正成本不显示 ¥0、partial 文案、混合模型隐藏命中率）。

---

## P7（低）agent 路由缺 finally 兜底

- [ ] 状态：未修复

**现象**：ask 路由用 `finally` 保证 `finish()` 全出口覆盖
（`apps/api/src/routes/ask.ts:731`）；agent 路由（`apps/api/src/routes/agent.ts`）没有。
`agentLoop` 的异常被 catch，但 catch 之后到 `usageTracker.finish(...)`（`:210`）之间
（`trace.end`、`registerBackground`、SSE write）若抛异常，turn 停在 collecting，
直到下次重启恢复才收口。

**后果**：违背 §6.2"路由的 try/catch/finally 必须保证没有出口遗留
`executionStatus=running + settlementStatus=collecting`"。概率低（中间步骤多为
fail-open），但属于设计明文要求。

**修复要点**：终态编排段包 `try/finally`，finally 里
`usageTracker.finish(abortCtl.signal.aborted ? 'aborted' : 'failed')`（幂等，正常路径 no-op）。

---

## P8（低）非 SSE 请求中途断连时终态误标

- [ ] 状态：未修复

**现象**：非 SSE + 客户端断连时，LLM 调用被 abort 后走规则 fallback 答案 →
`finalizeResponse` 照常执行 → `finish('completed')` 先落定（幂等使 `finally` 的
`'aborted'` 失效），且 trace judge 采样仍可能在 abort 后登记并启动
（`apps/api/src/routes/ask.ts:233-257`），违背 §6.2"abort 后不再登记或启动新的回答后任务"。

**后果**：账目本身不错（已发生调用照常入账），只是 executionStatus 语义偏差 +
abort 后多花一次 judge 钱。边缘场景（非 SSE 主要是 MCP 消费端）。

**修复要点**：`finalizeResponse` 开头检查 `abortCtl.signal.aborted`——已中止则跳过
judge 登记，`finish('aborted')`。

---

## P9（外观）明细表格与 §13.3 有出入

- [ ] 状态：未修复

`apps/web/src/components/TokenUsagePanel.vue:36-83`：表头 5 列
（阶段/次数/输入/输出/成本）与调用行内容错位（"次数"列下渲染的是状态徽标），
且缺"耗时"列——`latencyMs` 数据在 event 里，只是没展示。§13.3 的明细表定义为
`阶段|模型|输入 hit/miss|输出|reasoning|耗时|成本|状态`。顺手修即可。

---

## 非缺陷观察（不需要修，但要知道）

1. **§11.4 的 `prepareHistoryWindow` 惰性任务重构没做**：保留了 `buildHistoryWindow`
   内部"登记后立即启动"（`apps/api/src/services/ask/historyCompactor.ts:333`）。
   设计担心的竞态（先结算后登记）实际已避免——登记先于启动、更先于 finish。
   功能安全，属对设计条文的合理简化；本文档即为此偏离的书面记录。
   同类：ask 路由的 memory 抽取在 finish 前就启动（agent 路由则严格按 §6.3 顺序）——
   同样 register-before-finish，安全。
2. **计价精度边缘**：自定义价格低于 ¥0.0005/M 时
   `cnyPerMillionToNanoPerToken` 的 `Math.round` 静默取整为 0 nano/token
   （`apps/api/src/services/usage/pricingCatalog.ts:51`），极便宜的自定义模型会显示
   ¥0 而无告警。内置 DeepSeek 价不受影响。若要修：配置解析时对"非零价被舍成 0"告警。
3. **watchdog 与第二写进程的窄竞态**：`settleTimedOutTurns`
   （`apps/api/src/db/usageStore.ts:433`）先 SELECT 后逐行事务结算，事务内不复查
   `settlement_status='pending'`。单进程内同步执行无竞态；只有 P1 落地（eval 成为
   第二写进程）后才可能出现"job 刚结算完又被计入 timed_out"。做 P1 时在
   `settleInTx` 前补一次状态复查即可。
4. **设计文档头部表述**：§21.5 的"未做"清单缺 P1/P2 两项，且文档头
   "阶段 1–5 落地"会掩盖缺口——已在设计文档 §21.5 补充指向本清单。

## 建议的修复顺序

1. **P2 + P3（+顺手 P4）**：小改动、堵真实漏账，可合一个分支；
2. **P1**：独立分支单独做（第二写进程 + 测试，工作量最大）；
3. **P5 + P6**：展示层收尾，合一个小分支；
4. **P7 + P8 + P9**:健壮性与外观，可搭任一分支的车。
