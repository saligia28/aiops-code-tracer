# 评测 / 检测通道（eval）

把「答得对不对、召回准不准」变成**可回归的数字**。这套架子刻意分层，从最便宜、最确定性的一层往上做。

## 分层地图

| 层 | 测什么 | 怎么判 | 成本 | 进 CI | 状态 |
|---|---|---|---|---|---|
| **L1 检索召回** | `findRelevantNodes` 能否命中该找的文件 | 确定性 · Recall@K / MRR | 极低 | ✅ | **已搭好（样板）** |
| **L2 引用准确率** | 答案里的 `file:line` 是否真实存在且匹配 | 确定性 · 读源码核对 | 低 | ✅ | 🚧 待你实现（`citation.ts`） |
| **L3 答案质量** | 忠实度 / 正确性 / 代码优先 | LLM-as-judge | 高 | 抽样 | ✅ 已落地（Step 4） |
| **L4 观测/检测** | 线上每次调用的链路/延迟/成本 | Langfuse 自托管 | — | — | ✅ 已落地（Step 5） |

**顺序原则**：先确定性、便宜、进 CI 的（L1/L2）；LLM-judge（L3）最后加——它慢、贵、有噪声。

## 目录

```
test/eval/
├── README.md               本文件（含 checklist）
├── types.ts                评测类型（RetrievalCase / CaseScore / ...）
├── metrics.ts              Recall@K / MRR 等纯函数——评测的「原理层」
├── harness.ts              加载图 → 跑召回 → 打分 → 聚合 的骨架
├── retrieval.eval.test.ts  L1 vitest 门禁（缺图自动 skip）
├── run.ts                  独立报表 + discover 标注辅助
├── citation.ts             L2 引用准确率（骨架 + TODO）
└── dataset/
    └── retrieval.jsonl      L1 数据集（每行一条用例）
```

## 现在就能跑

```bash
# 报表：跑数据集，打印 Recall@K / MRR
pnpm --filter @aiops/api eval

# 标注辅助：看某个问题真实召回了哪些文件（照抄正确的进数据集）
pnpm --filter @aiops/api eval -- discover "作废订单在哪里做的校验"

# CI 门禁：vitest（含 L1，缺图会 skip）
pnpm --filter @aiops/api test retrieval

# 换仓库 / 换 K
EVAL_REPO=quality EVAL_K=5 pnpm --filter @aiops/api eval
```

> 数据来自 `data/.aiops/<repo>/`（本地已有 `elink-pc` / `quality` / `main-java`）。该目录被 gitignore，所以 CI 上缺图时 L1 测试会自动 skip，不会拖垮 `pnpm test`。

---

## Checklist（一步一步实现）

### Step 1 · 跑通并读懂 L1（~30 min）
- [ ] `pnpm --filter @aiops/api eval` 能打印出报表（3 条种子用例）。
- [ ] 对 3 个你关心的问题各跑一次 `... eval -- discover "..."`，观察召回的文件。
- [ ] 打开 `metrics.ts`，确认你能**用一句话讲清** Recall@K 和 MRR 的定义。
- [ ] 打开 `harness.ts`，看懂「为什么必须先 `loadEvalGraph()`」（findRelevantNodes 依赖全局状态）。

### Step 2 · 把数据集做真 + 上棘轮门禁 ✅（2026-07-14 完成）
- [x] 18 条用例（9 业务域），gold 来自**独立证据**（router title↔component 映射 / grep 真实仓库），
      非检索结果反标——否则评测=系统给自己打分。变体约定：同一目标留 en+zh 两条。
- [x] 词法基线：**Recall@10=0.556 / MRR=0.426**（拐杖时代的 0.75 是虚高）。
- [x] 棘轮已设 0.5 / 0.38（略低于基线，留图重建抖动余量）。
- [ ] （可选练习）故意改坏一个召回参数，确认门禁变红。
- 附：`eval -- semantic` 曾揭示语义通道 ×14 加法权重在 18 条上**净收益为零**
  （4 翻正 vs 4 翻负）。三类病因分診并已修复（见 Step 2.5）。

### Step 2.5 · 语义融合调参 ✅（2026-07-14 完成，评测驱动调参的完整一课）
- [x] **全量重建语义索引**：1500 → 2141 文件（覆盖缺口修复，fabricCheck 等 gold 从"没被 embed"变可召回）。
- [x] **加法融合被证死路**：扫参 W=5/8/14 显示——降权救不回被挤压的词法命中
  （文件内容 TF-IDF 分数 <1，语义 boost 任何权重都碾过它），反而拖垮语义翻正。
  两通道分数刻度不可比 → 只有排名空间可比。
- [x] **换 RRF 融合**（`findRelevantNodesWithSemantic`）：`fused(file)=Σ 1/(K+rank)`，
  语义项 ×0.9（平票词法优先）；输出端**每文件 ≤3 节点限额**
  （RRF v1 实测教训：整文件倾倒会坑位垄断，把正确命中整体挤出输出）。
- [x] 最终：**Recall@10 0.556 → 0.778（+40%），8 翻正 / 0 翻负**，词法门禁不受影响（24 test 绿）。
- 旋钮（env 可覆盖，默认即调定值）：`SEM_TOPN=10` `SEM_RRF_K=20` `SEM_RRF_SEM_W=0.9` `SEM_NODES_PER_FILE=3`。
- **已 productionize**（C′）：`routes/ask.ts` 主召回改调 `findRelevantNodesWithSemantic`
  （其余调用点是英文标识符 scope 收窄，保持词法）；`loadGraph` 启动 load / 缺失后台建 /
  切项目清残留；`executeIndexBuild` 重建后强刷。E2E 已验证：起服务 POST /api/ask
  问"订单会议核价的列表页"，evidence 首条即 gold List.vue（该用例词法必 miss）。
- 剩余 backlog（真难语义 ③）：库存抽样 api / 检测要求配置页（中文线索太薄），
  订单路由 zh(rank14) / 面料检验作废(rank17) 在列表内但 @10 外——留给下一轮（如 profile 增强）。

### Step 3 · L2 引用准确率（你的杀手锏）—— 核心已落地 ✅（2026-07-14）
- [x] `citation.ts` 实现 `citationAccuracy(evidence, repoPath)`：三级判定
      fileExists → lineExists → matched（标识符 ±2 行容差），空 evidence 约定 accuracy=1（空真）。
- [x] `citation.eval.test.ts`：8 条 hermetic 单测（临时目录 fixture，CI 无条件可跑）。
- [x] **真实闭环**（`_probe_citation.ts`，需本地起服务）：真实问答 evidence 逐条核对。
      ★ 首战即抓到真 bug：核价问题引用准确率仅 25%，失败的全是图节点来源的证据，
      恒定偏移 21 行 = `<script>` 起始行 - 1 → **parser 的 Vue SFC script 行号偏移 bug**
      （extractor 拿块内行号，没映射回文件行号）。修复：`packages/parser` 的
      `vueSfcParser.ts` 带出 `scriptStartLine`，`typescript/index.ts` 统一重映射 loc。
      重建 elink-pc 图后：**25% → 92%**（剩 1 条是 pageAnchor 象征性行号，另账）。
      词法基线分毫未动（0.556/0.426，loc 不影响召回），32 test + 全仓 typecheck 绿。
- [ ] 抽出 `answer(question): Promise<AskResponse>`（从 `routes/ask.ts`），把探针升级为
      正式 citation 门禁：golden 问题集 + 「引用准确率 ≥ 阈值」进 CI（无 LLM 时 skip）。
- [ ] pageAnchor 证据的行号语义（指向 route 定义行 or 组件首行）另立小任务。

### Step 4 · L3 答案质量 / LLM-judge ✅（2026-07-14 完成）
- [x] rubric 三维：**忠实度**（论断是否被 evidence 支持）、**正确性**（对照 referenceAnswer）、
      **代码优先**（basis 枚举 code/doc/mixed/n-a，解析层映射回布尔）。实现在 `judge.ts`。
- [x] golden Q&A：`dataset/answers.jsonl` 5 条，`mustNotHallucinate` 特意埋"似是而非邻居"陷阱
      （stockOrder↔stockCheck、bandAnalysis↔BandPlaning）——确定性字符串判定，零成本。
- [x] `judgeAnswer()`：复用 `callChatCompletion`（温度 0.2 内置），强 JSON 约束 + 稳健解析。
- [x] 降噪：3 票取多数/中位分 + 磁盘缓存（data/.aiops/evalJudgeCache.json，PROMPT_VERSION 失效）。
- [x] 冲突用例 2 条（合成 fixture，判正反两方向），**经两轮评测驱动的 prompt 校准后 2/2 通过**：
      v1→v2 修「布尔极性翻转」（reason 说违反、结论却 true → 改事实性枚举）；
      v2→v3 修「mixed 语义过宽」（提及文档并指出过时被误判 mixed → 收紧为"结论摇摆才算"）。
- 运行：`pnpm --filter @aiops/api eval -- answers`（需本地服务 + LLM）；确定性部分 8 条单测进 CI。
- 首跑基线：必提 5/5 · 零幻觉 4/5（波段企划真踩 bandAnalysis 陷阱）· 正确 5/5 · 忠实 2/5 · 均分 7.6。
- ★ 忠实 2/5 的正确解读：结合 L2（那些 file:line 对源码核验 92-100% 真）——不是幻觉，
  是**答案引用了 evidence 清单之外的行** → 「答案与展示证据脱节」，产品改进点：
  evidence 应覆盖答案引用的位置（或答案只引用已展示证据）。已记 backlog。
- 已知局限：judge 与被评答案同源（同一 LLM 配置），系统性偏宽；升级方向=独立更强 judge 模型。

### Step 5 · L4 观测 / 检测 ✅（2026-07-14 完成，全环 E2E 验证）
- [x] 选型 **Langfuse 自托管**（开源，契合 Docker 叙事；未引入 LangChain）。
      `docker compose -f docker/langfuse-compose.yml up -d` 一键起（无头初始化，
      org/project/key 全从 env 预置），UI http://localhost:3050（dev@local.test / devpassword123）。
- [x] `src/services/traceService.ts` 封装 SDK，两条铁律：
      **未配置 = 完全 no-op**（缺 LANGFUSE_PUBLIC_KEY/SECRET_KEY 时 facade 全空转，主链路零开销）；
      **fail-open**（实测：坏 key + 死端口，问答照常 200，服务不崩）。
- [x] `routes/ask.ts` 埋点：trace(question/projectId/convId/repo) + `recall` span
      （candidates/ranked 数）+ `answer` generation（prompt/output 字符数）+
      finalizeResponse 漏斗统一收尾（快速路径也覆盖）+ catch 记错。
- [x] **线上采样 → judge 打分回写**：`LANGFUSE_JUDGE_SAMPLE`∈[0,1] 抽样，fire-and-forget
      调 L3 judge（1 票省成本，judge 已迁 `src/services/answerJudge.ts` 供生产复用），
      faithful / judge_score 作为 score 挂回 trace——Langfuse 里按 faithful=0 过滤即是告警面。
- [x] 全环 E2E 实测：真问答 → trace 落库（recall span 2.4s / answer generation 4.4s /
      latency 7.5s）→ 抽样 judge 回写 **faithful=1、judge_score=9**（带理由）。
- 配置见 `.env.example` LANGFUSE_* 段；停容器 `docker compose -f docker/langfuse-compose.yml down`。

---

## 已知坑（先知道，别踩）

- **中文问题 × 英文代码**：召回可能偏低（词法层对不上）。这不是 bug，正是评测要暴露的差距——
  值得记录成一条「待优化」，而不是把数据集迁就成全英文。
- **`currentRepoPath` 未指向真实源码**时，L2 引用核对拿不到文件；先确认它有效（`loadGraph`
  会从 `data/.aiops/projects.json` 回填）。
- **节点 id 太脆**：gold 用「文件」而非 `type:filePath:name`，改一行不至于全体漂移。
- **门禁阈值别一次设满**：留出抖动余量，宁可略低、稳定，再逐步棘轮上调。
