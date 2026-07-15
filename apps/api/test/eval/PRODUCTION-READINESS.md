# L1~L4 生产就绪审计（2026-07-14）

## 修复状态总账（同日修复完毕）

**P0 全部修复 ✅**
- P0-1 ✅ `fixture-repo` + `retrieval.fixture.eval.test.ts`：随仓库提交的 8 文件小仓库，测试内存建图，
  **CI 永不 skip**（首跑 8/8 命中，阈值 0.85/0.7）。
- P0-2 ✅ `retrieval.semantic.eval.test.ts`：环境就绪（图+embedding+索引）自动跑，断言
  「语义 ≥ 词法（无净回归）」+「语义 Recall ≥ 0.7」；不就绪 skip/软过，embedding 挂时语义
  自动退化为词法故不误报。实测 12.6s 双绿。另加 `pnpm eval:nightly` 脚本。
- P0-3 ✅ `loadSemanticFileIndex` 校验 `model/dims`，不匹配拒载+告警+退词法。
- P0-4 ✅ 查询期 embed 独立短超时 `SEMANTIC_QUERY_TIMEOUT_MS`（默认 2.5s），超时退词法。
- P0-5 ✅ 构建互斥锁（同 repo 进行中跳过，消灭首建双触发）+ 完成守卫
  （`currentRepoName` 不符不写内存索引，消灭跨项目污染）。
- P0-6 ✅ 默认脱敏（question/答案只报长度），明文需显式 `LANGFUSE_LOG_PAYLOADS=1`；
  未设 BASE_URL（=Cloud 出网）时启动告警。
- P0-7 ✅ 抽样 judge 护栏：单并发 + `LANGFUSE_JUDGE_HOURLY_MAX`（默认 20/小时）；
  空 evidence 不判（避免噪声分）。

**P1 全部修复/落地 ✅**
- P1-8 ✅ `PARSER_VERSION`（@aiops/parser 导出）写进 meta.json；loadGraph 不匹配即告警建议重建。
- P1-9 ✅ L2 引用核对并入 `eval -- answers`（每用例+汇总引用准确率；repoPath 从项目注册表解析）；
  硬编码探针已删。answer() 抽取仍是后续增强（见 P2）。
- P1-10 ✅ llmService 捕获 token usage（OpenAI 兼容 `usage` / ollama `eval_count`），
  `getLastLlmCallMeta()` 供 trace 上报 model+tokens → Langfuse 成本页有数了。
- P1-11 ✅ `pnpm --filter @aiops/api eval:nightly`（semantic 对比 + answers 全套）；crontab 由部署环境挂。
- P1-12 ✅ judge 缓存原子写（tmp+rename）+ 500 条上限淘汰。
- P1-13 ✅ SIGTERM/SIGINT → `app.close()`（5s 兜底强退），docker stop 不再丢 trace。
- P1-14 ✅ agent 路由接入 trace（name='agent'，loop span + steps 数；error 上报）。
- P1-15 ✅ 起步：`retrieval.quality.jsonl` 3 条 Java 用例（gold=Controller Javadoc+@RequestMapping），
  首跑 3/3 命中；`eval` 按 EVAL_REPO 自动选数据集。扩充到 main-java 沿用同配方。

**P2 修复（第二批，同日）**：
- ✅ 探针硬编码（已删并入 answers）、✅ trace ERROR level 事件、✅ 根 README 同步。
- ✅ **pageAnchor 行号**：锚点证据改为文件级断言（line=1 + 纯中文 `页面：<title>`，不再声称
  routeName 在组件文件里）——实测引用准确率 **92% → 100%（12/12）**。
- ✅ **告警闭环**：抽样 judge 判 faithful=0 → 推现有 `alertService`（钉钉/飞书 ALERT_WEBHOOK，
  未配置自动 no-op），线上回归告警从"UI 过滤"升级为真推送。
- ✅ **独立 judge 模型**：`JUDGE_LLM_BASE_URL/JUDGE_LLM_MODEL`（OpenAI 兼容端点）让 judge 走
  独立后端；缓存 key 纳入 judge 后端标识（换模型不复用旧票）。实测 ollama gpt-oss:20b
  冲突裁决 2/2，且对劣质答案比同源 judge 更严（faithful=false、score=2）。
- ✅ eval 支持鉴权服务器：`EVAL_API_PASSWORD` 自动登录带 cookie（nightly 可打真实部署）。
- 仍为 backlog：数据集规模扩到 50+（标注工作，配方已备：router title↔component 抽取 +
  discover 校验）、暴力余弦的 ANN 规模上限（万级文件后再说）。

验证：全仓 typecheck 0 错；43 passed + 2 skipped（语义门禁无 embedding env 时按设计 skip）；
真实鉴权链路 E2E（401 拦截→登录→问答→trace/usage/scores 落库）通过。

---

## 原始审计（修复前快照，保留供回溯）

结论先行：**分层设计与工程纪律达标，作为"开发期评测工具"已可用且已产生真实价值**
（抓到 parser 行号 bug、驱动 RRF 融合、校准 judge prompt）。但按**生产上线**标准衡量，
存在 7 个 P0 阻断项——核心矛盾一句话：**门禁在 CI 空转，且门禁测的通道 ≠ 线上跑的通道**；
语义召回有 3 个真实缺陷；观测层缺隐私与成本护栏。以下逐条带证据。

分级：P0=上线阻断（错误结果/成本失控/数据外泄/主链路劣化）；P1=第一周内；P2=backlog。

---

## P0 · 上线阻断

### P0-1 CI 门禁空转（棘轮是假绿灯）
`data/.aiops` 被 gitignore → CI 上 `graphExists()` 恒 false → `retrieval.eval.test.ts`
的 `describe.skipIf` 让 L1 门禁**在 CI 永远 skip 且显示通过**。棘轮只在本机生效。
**修**：提交一个小型 fixture 仓库（十几个文件、覆盖 vue/ts/路由），CI 里现场建图，
门禁跑 fixture；真实仓库的门禁保留本机跑。

### P0-2 门禁通道漂移（测的不是线上跑的）
门禁走 `findRelevantNodes`（纯词法，`harness.ts:78`），而生产 `/api/ask` 主召回走
`findRelevantNodesWithSemantic`（RRF 融合）。**语义/融合任何回归都不会触发任何门禁**，
只有手动 `eval -- semantic` 能看见。
**修**：语义对比评测进发布前 checklist（或本机/自托管 runner 带 ollama 的第二道门禁）。

### P0-3 语义索引不校验 model/dims（静默垃圾）
`loadSemanticFileIndex` 直接 `setSemanticIndex(JSON.parse(...))`，不比对索引里的
`model/dims` 与当前 embedding 配置。索引是 bge-m3 建的；一旦生产切到 bailian，
查询向量 × 旧索引 = **相似度全是噪声，静默返回乱序结果**（不报错，最难发现的一类）。
**修**：load 时校验 `index.model === getEmbeddingModel() && dims 一致`，不符 → 不加载、
记 warn、退词法。

### P0-4 查询期 embed 共用 30s 超时（主链路劣化）
`embedTexts` 用 `EMBEDDING_TIMEOUT_MS`（默认 30000）。索引构建可以慢，但 **ask 内联
路径上的问题向量化最坏挂 30s** 才退词法。
**修**：查询期单独短超时（2~3s），超时立即退词法（评测已证词法是可用底线）。

### P0-5 语义索引构建竞态（双倍成本 + 跨项目污染）
两处（`indexService.ts:233-234` 与 `:349`）：
(a) **首建双触发**——`executeIndexBuild` 内部调用 `loadGraph`（索引缺失 → 触发 build #1），
    随后 `if (loaded) void buildSemanticFileIndex` 又触发 build #2 → 两个全量 embedding
    并发跑，**双倍 API 成本**，写文件 last-writer-wins。
(b) **切项目竞态**——后台构建完成后无条件 `setSemanticIndex(idx)`；构建期间用户切了项目，
    旧项目的向量会覆盖新项目的内存索引 → **跨项目污染**。
**修**：构建互斥锁（同 repo 进行中则跳过）；完成时校验 `currentRepoName === repoName` 再 set。

### P0-6 观测层隐私（源码语义明文上报）
trace 上报 `question` + `answerPreview(400字)` + evidence 计数；答案里含真实文件路径、
函数名、业务逻辑。自托管没问题；**一旦有人把 LANGFUSE_BASE_URL 留空（=Langfuse Cloud），
企业源码语义就出网了**。当前无脱敏开关、无出网提醒。
**修**：`LANGFUSE_LOG_PAYLOADS` 开关（默认只报长度/哈希，显式开启才报内容）；
BASE_URL 为空时启动 warn。

### P0-7 抽样 judge 无成本护栏
`LANGFUSE_JUDGE_SAMPLE=1` 误配 → **每个请求多烧一次 LLM**；fire-and-forget 无并发上限、
无 QPS/日预算限制，流量尖峰=成本尖峰+触发 provider 限流反噬主答案。
**修**：采样 judge 并发上限（如同时 1 个）+ 每小时/每日配额计数器，超限静默跳过。

---

## P1 · 第一周内

- **P1-8 无 parser/index 版本戳**：`meta.json` 只有 scanTime，没有 parserVersion。这次
  Vue 行号 bug 修复后靠人肉重建 elink-pc；未来 parser 修复不会强制旧图重建（quality 无
  .vue、main-java 走 Java 通道，未受此 bug 影响，但机制缺口是系统性的）。
  修：构建时写入 parserVersion，load 时不匹配 → 提示/触发重建。
- **P1-9 L2 真实引用门禁缺位**：`citationAccuracy` 只有 hermetic 单测进 CI；真实答案的
  引用核对靠 `_probe_citation.ts` 手动跑（还硬编码了 REPO_PATH 和端口）。
  修：抽出 `answer()` 后做 golden citation 门禁（准确率 ≥ 阈值）。
- **P1-10 token/cost 未上报**：`callChatCompletion` 只返回 string，usage 全丢 →
  Langfuse 的 generation 无 model/tokens/cost，成本观测形同虚设（这是观测层的核心指标之一）。
  修：llmService 回传 usage，trace facade 透传。
- **P1-11 L3 无自动化调度**：answers 评测手动跑，回归靠人想起来。修：nightly cron
  （服务器 + LLM 环境齐的机器）+ 结果落盘/落 Langfuse。
- **P1-12 judge 缓存并发不安全 + 无限增长**：整文件读改写、无锁；L4 线上采样与离线评测
  并发时可能丢票/写坏 JSON；文件只增不减。修：按 key 分文件或加简单写锁 + 大小上限。
- **P1-13 SIGTERM 不 flush**：`onClose` 只在 `app.close()` 触发；`docker stop`（SIGTERM）
  直接退进程，最后一批 trace（≤10s 窗口）丢失。修：signal handler → app.close()。
- **P1-14 观测覆盖局部**：只有 `/api/ask`；agent 路由（agentLoop 多轮 LLM）、
  analyzeQuestion/generateQuestionPlan、记忆抽取都不在 trace 里。4xx 参数错误也不进 trace。
- **P1-15 评测单仓库单语言**：18+5 条全是 elink-pc（Vue/中文）；main-java（Java）与
  quality 零覆盖；judge rubric 未在 Java 语境验证。

## P2 · Backlog

- 数据集统计效力：18 条（L1）/5 条（L3）对阈值波动敏感，扩到 50+ 才谈得上稳定棘轮。
- 同源 judge 偏宽（已在 README 声明）：换独立强模型做 judge。
- pageAnchor 证据行号语义（L2 audit 里剩的那条 ❌）。
- 暴力余弦的规模上限：2141 文件 ~ms 级；万级文件后需 ANN/量化（当前内存 ~17MB/仓库）。
- `_probe_citation.ts` 硬编码本机绝对路径/端口，不可移植。
- trace 错误只写 metadata.failed，未用 Langfuse 的 level=ERROR 事件，告警过滤不方便。
- 告警只是"UI 里按 faithful=0 过滤"，无 webhook/通知规则。
- 根 README 未同步 L1~L4 叙事（面试文档）。
- langfuse-compose 固定密钥仅限本地 dev（文件头已标注，生产必须换）。

---

## 已达生产水准的部分（公允记录）

- **no-op / fail-open 双铁律经过实测**：无 key 全链路零开销（40 test 无 key 全绿）；
  坏 key + 死端口问答照常。embedding 全链路同样有退化路径（未就绪→词法）。
- 分层"先确定性便宜、后 LLM 贵"的架构，与 RRF 排名融合（免疫分数刻度问题）。
- 缓存 + PROMPT_VERSION 失效机制；hermetic 单测不依赖本机数据。
- compose 无头初始化（LANGFUSE_INIT_*），起容器即用。
- 评测已闭环产生真实产出：parser 行号 bug（25%→92%）、融合过拟合（净零→+40%）、
  judge 极性翻转与 mixed 语义两轮校准。
