/**
 * 模型选择器面板里的两个下拉。单独成文件是为了让 antd Select（连带
 * rc-select / rc-virtual-list / rc-trigger）从首屏包里挪出去 —— 面板默认收起，
 * 展开时才下载。
 */
import { Select } from 'antd';

interface LlmOption {
  value: string;
  label: string;
}

export interface ModelSelectRowProps {
  mode: 'api' | 'intranet';
  model: string;
  availableModes: LlmOption[];
  modelOptions: LlmOption[];
  modelSearch: string;
  onModelSearch: (value: string) => void;
  disabled: boolean;
  onModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  popupClass: string;
}

export default function ModelSelectRow({
  mode,
  model,
  availableModes,
  modelOptions,
  modelSearch,
  onModelSearch,
  disabled,
  onModeChange,
  onModelChange,
  popupClass,
}: ModelSelectRowProps) {
  return (
    <div className="toolbar-row">
      <Select
        value={mode}
        options={availableModes}
        size="small"
        className="toolbar-select"
        classNames={{ popup: { root: popupClass } }}
        disabled={disabled}
        onChange={onModeChange}
      />
      <Select
        value={model}
        options={modelOptions}
        size="small"
        className="toolbar-select toolbar-model"
        // 允许填写候选之外的模型名：输入时临时插一条同名选项供选中。
        showSearch
        searchValue={modelSearch}
        onSearch={onModelSearch}
        filterOption={(input, option) =>
          String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
        }
        classNames={{ popup: { root: popupClass } }}
        disabled={disabled}
        onChange={onModelChange}
      />
    </div>
  );
}
