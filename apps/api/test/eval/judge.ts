/**
 * L3 judge —— 实现已迁至 src/services/answerJudge.ts（生产 L4 线上抽样打分要复用，
 * 而 build 只打包 src/）。此壳保持 eval 侧 import 路径稳定。
 */
export * from '../../src/services/answerJudge.ts';
