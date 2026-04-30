import React from 'react';
import type { ModelPreset } from '../settings/types';

interface Props {
  presets: ModelPreset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
}

export function PresetSwitcher({ presets, selectedId, onSelect, onOpenSettings }: Props) {
  if (presets.length === 0) {
    return (
      <div className="preset-empty">
        <span>未配置模型</span>
        <button onClick={onOpenSettings}>打开设置</button>
      </div>
    );
  }
  return (
    <div className="preset-switcher">
      <select value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.provider} · {p.model || 'no model'})
          </option>
        ))}
      </select>
      <button onClick={onOpenSettings} title="设置">
        ⚙
      </button>
    </div>
  );
}
