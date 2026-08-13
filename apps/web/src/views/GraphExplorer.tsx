import { useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ElEmpty, ElInput, ElSelect } from '@/components/el';
import './GraphExplorer.css';

const NODE_TYPE_OPTIONS = [
  { label: '函数', value: 'function' },
  { label: '组件', value: 'component' },
  { label: 'API', value: 'apiCall' },
  { label: '文件', value: 'file' },
];

export default function GraphExplorer() {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('');
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // TODO: 集成 AntV G6 图谱渲染
  return (
    <div className="graph-explorer">
      <PageHeader index="02" kicker="GRAPH" title="图谱浏览器" backTo="/" />

      <div className="toolbar">
        <ElInput
          modelValue={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索符号..."
          style={{ width: 300 }}
        />
        <ElSelect
          modelValue={filterType}
          onChange={setFilterType}
          options={NODE_TYPE_OPTIONS}
          placeholder="节点类型"
          clearable
          style={{ width: 160, marginLeft: 12 }}
        />
      </div>

      <div className="graph-canvas" ref={canvasRef}>
        <ElEmpty description="图谱可视化加载中... (AntV G6)" />
      </div>
    </div>
  );
}
