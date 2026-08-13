/**
 * 本轮成本面板（设计文档 §13.2）。只负责渲染，数据获取在 useTokenUsage。
 *
 * 三条显示纪律（都是"别骗用户"）：
 *   - 正成本永不显示 ¥0（小于展示精度时显示 <¥0.000001）；
 *   - 有未知/缺失时显示"部分成本"，不能当完整总价；
 *   - 混合模型时隐藏总缓存命中率（Ollama 没有缓存，混着算出来的数没有意义）。
 */
import { Fragment, useMemo, useState } from 'react';
import {
  formatNanoCny,
  formatNanoCnyPrecise,
  formatTokens,
  formatCacheHitRate,
  formatLatency,
  formatCostText,
  formatCallCountText,
  canShowCacheHitRate,
  PARTIAL_REASON_TEXT,
  type TokenUsageEvent,
  type TurnUsageSummary,
} from '@/hooks/useTokenUsage';
import './TokenUsagePanel.css';

export interface TokenUsagePanelProps {
  summary: TurnUsageSummary;
  events?: TokenUsageEvent[];
  loading?: boolean;
  onExpand?: () => void;
}

interface StageGroup {
  stage: string;
  count: number;
  hit: number;
  miss: number;
  output: number;
  latency: number;
  cost: number;
  events: TokenUsageEvent[];
}

function statusText(e: TokenUsageEvent): string {
  if (e.transportStatus === 'success') return e.usageSource === 'estimated' ? '估算' : '成功';
  if (e.transportStatus === 'aborted') return '已中止';
  return e.errorKind === 'stream_incomplete' ? '流式未完成' : '失败';
}

function statusClass(e: TokenUsageEvent): string {
  if (e.transportStatus === 'success') return e.usageSource === 'estimated' ? 'st-warn' : 'st-ok';
  return 'st-err';
}

export function TokenUsagePanel({ summary, events, loading, onExpand }: TokenUsagePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [openStages, setOpenStages] = useState<Set<string>>(new Set());
  const list = events ?? [];

  const showHitRate = summary.cacheHitRate !== undefined && canShowCacheHitRate(events);
  // 文案规则抽到 useTokenUsage 成纯函数（可单测：¥0 纪律 / partial 文案 / dropped 分开说）
  const callCountText = formatCallCountText(summary);
  const costText = formatCostText(summary);

  const stageGroups = useMemo<StageGroup[]>(() => {
    const map = new Map<string, StageGroup>();
    for (const e of list) {
      const g =
        map.get(e.stage) ??
        { stage: e.stage, count: 0, hit: 0, miss: 0, output: 0, latency: 0, cost: 0, events: [] };
      g.count += 1;
      g.hit += e.tokens.cacheHitTokens ?? 0;
      g.miss += e.tokens.cacheMissTokens ?? 0;
      g.output += e.tokens.completionTokens ?? 0;
      g.latency += e.latencyMs ?? 0;
      g.cost += e.totalCostNanoCny ?? 0;
      g.events.push(e);
      map.set(e.stage, g);
    }
    return [...map.values()];
  }, [list]);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) onExpand?.();
  }

  function toggleStage(stage: string) {
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  return (
    <div className="token-usage">
      {/* 摘要行：点击展开明细 */}
      <button className="usage-summary" type="button" onClick={toggle}>
        <span className="usage-metric">{formatTokens(summary.totalTokens)} tokens</span>
        {showHitRate && <span className="usage-sep">·</span>}
        {showHitRate && (
          <span className="usage-metric">缓存 {formatCacheHitRate(summary.cacheHitRate!)}</span>
        )}
        <span className="usage-sep">·</span>
        <span className="usage-metric">{callCountText}</span>
        <span className="usage-sep">·</span>
        <span className={`usage-cost${summary.partial ? ' is-partial' : ''}`}>{costText}</span>

        {!summary.settled && (
          <span className="usage-settling">
            <span className="settling-dot" />
            成本结算中
          </span>
        )}
        {summary.partial && (
          <span className="usage-warn" title="成本不完整，展开查看原因">
            ⚠
          </span>
        )}
        <span className="usage-caret">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="usage-detail">
          {/* 不完整原因：不能只给一个感叹号让用户猜 */}
          {summary.partial && (
            <ul className="usage-reasons">
              {summary.partialReasons.map((reason) => (
                <li key={reason}>{PARTIAL_REASON_TEXT[reason] || reason}</li>
              ))}
              {summary.lateDroppedEvents > 0 && (
                <li>另有 {summary.lateDroppedEvents} 次调用在结算后才返回，未计入本轮成本</li>
              )}
            </ul>
          )}

          {loading && !list.length ? (
            <p className="usage-loading">加载明细…</p>
          ) : !list.length ? (
            <p className="usage-loading">本轮追踪未持久化，刷新后不可恢复</p>
          ) : (
            /* 先按阶段聚合：一轮 agent 可能有几十次调用，直接铺开没法看。
               列对齐 §13.3（评审 P9）：状态有自己的列，不再挤在"次数"下面；耗时来自 event.latencyMs */
            <table className="usage-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>次数</th>
                  <th className="num">输入 hit/miss</th>
                  <th className="num">输出</th>
                  <th className="num">耗时</th>
                  <th className="num">成本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {stageGroups.map((group) => (
                  <Fragment key={group.stage}>
                    <tr className="stage-row" onClick={() => toggleStage(group.stage)}>
                      <td>
                        <span className="stage-caret">{openStages.has(group.stage) ? '▾' : '▸'}</span>
                        {group.stage}
                      </td>
                      <td>{group.count}</td>
                      <td className="num">
                        {group.hit} / {group.miss}
                      </td>
                      <td className="num">{group.output}</td>
                      <td className="num" title="该阶段各次调用耗时之和（并行调用会大于墙钟时间）">
                        {formatLatency(group.latency)}
                      </td>
                      <td className="num">{formatNanoCny(group.cost)}</td>
                      <td />
                    </tr>
                    {(openStages.has(group.stage) ? group.events : []).map((e) => (
                      <tr key={e.id} className="call-row">
                        <td className="call-model">
                          #{e.stageCallIndex} {e.model}
                          {e.pricing?.matchKind === 'official_alias' && (
                            <span className="badge" title="按官方旧模型名映射计价">
                              兼容别名计价
                            </span>
                          )}
                          {e.deliveryMode === 'stream' && (
                            <span className="badge badge-plain">流式</span>
                          )}
                          {e.stage.endsWith('_fallback') && (
                            <span
                              className="badge badge-plain"
                              title="流式失败后整包重试——这是真实的第二次调用，不是重复记录"
                            >
                              流式失败后重试
                            </span>
                          )}
                        </td>
                        <td />
                        <td className="num">
                          {e.tokens.cacheHitTokens ?? '—'} / {e.tokens.cacheMissTokens ?? '—'}
                        </td>
                        <td className="num">
                          {e.tokens.completionTokens ?? '—'}
                          {Boolean(e.tokens.reasoningTokens) && (
                            <span className="reasoning" title="reasoning 是 output 的子集，不重复计费">
                              (含推理 {e.tokens.reasoningTokens})
                            </span>
                          )}
                        </td>
                        <td className="num">{formatLatency(e.latencyMs)}</td>
                        <td
                          className="num"
                          title={
                            e.totalCostNanoCny ? formatNanoCnyPrecise(e.totalCostNanoCny) : '单价未配置'
                          }
                        >
                          {e.totalCostNanoCny === undefined
                            ? '单价未配置'
                            : formatNanoCnyPrecise(e.totalCostNanoCny)}
                        </td>
                        <td>
                          <span className={statusClass(e)}>{statusText(e)}</span>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
