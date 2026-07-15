/**
 * L2 引用核对 —— 实现已迁至 src/services/citationCheck.ts（P0-A 自校验进循环
 * 要在生产链路里跑，而 build 只打包 src/）。此壳保持 eval 侧 import 路径稳定。
 */
export * from '../../src/services/citationCheck.ts';
