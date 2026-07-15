/**
 * 评测通道 · 类型定义
 *
 * 评测的坐标系刻意与 findRelevantNodes 保持一致：
 *  - 召回返回 GraphNode[]，每个 node 有 filePath（相对路径）。
 *  - gold label 以「文件」为最小单位——这是人工标注最省力、也最稳的粒度
 *    （节点 id = "type:filePath:name" 太脆，改一行就漂移）。
 */
import type { GraphNode } from '@aiops/shared-types';

/** 一条检索评测用例。 */
export interface RetrievalCase {
  /** 稳定的用例 id，用于报表定位与回归对比。 */
  id: string;
  /** 用户问题（自然语言）。 */
  question: string;
  /**
   * 期望被召回的文件（相对路径，与 GraphNode.filePath 同坐标系）。
   * 命中「任一」即算 hit；Recall@K 统计「覆盖了多少比例」。
   */
  expectedFiles: string[];
  /** 可选：更严格的按 nodeId 标注（type:filePath:name）。当前判分以文件为准，这里先占位。 */
  expectedNodeIds?: string[];
  /** 可选：备注/出处，方便复盘为什么这么标。 */
  note?: string;
}

/** 单条用例跑完后的原始产出（未打分）。 */
export interface RetrievalOutcome {
  case: RetrievalCase;
  /** findRelevantNodes 返回的节点（已按分数降序）。 */
  retrieved: GraphNode[];
  /** 去重保序后的召回文件序列（按文件判分用）。 */
  retrievedFiles: string[];
}

/** 单条用例的打分结果。 */
export interface CaseScore {
  id: string;
  question: string;
  /** 前 K 是否命中至少一个期望文件。 */
  hit: boolean;
  /** 第一个命中的名次（1-based）；未命中为 null。 */
  rank: number | null;
  /** 期望文件被前 K 覆盖的比例。 */
  recallAtK: number;
  /** 1/rank；未命中为 0。单条 RR 求平均即 MRR。 */
  reciprocalRank: number;
}

/** 全量聚合报告。 */
export interface AggregateReport {
  total: number;
  k: number;
  /** 宏平均 Recall@K。 */
  recallAtK: number;
  /** Mean Reciprocal Rank。 */
  mrr: number;
  /** 至少命中一个的用例占比。 */
  hitRate: number;
  scores: CaseScore[];
}
