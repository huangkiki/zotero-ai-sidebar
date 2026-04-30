import React, { useEffect, useState } from 'react';
import { loadPresets, savePresets, zoteroPrefs } from '../settings/storage';
import {
  newPreset,
  DEFAULT_BASE_URLS,
  type ModelPreset,
  type ProviderKind,
} from '../settings/types';

interface Props {
  onDone: () => void;
}

export function PreferencesPane({ onDone }: Props) {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    setPresets(loadPresets(zoteroPrefs()));
  }, []);

  const persist = (next: ModelPreset[]) => {
    setPresets(next);
    savePresets(zoteroPrefs(), next);
  };

  const add = (kind: ProviderKind) => {
    const p = newPreset(kind);
    persist([...presets, p]);
    setEditingId(p.id);
  };

  const update = (id: string, patch: Partial<ModelPreset>) => {
    persist(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const remove = (id: string) => persist(presets.filter((p) => p.id !== id));

  return (
    <div className="prefs-pane" style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>模型预设</h3>
        <button onClick={onDone}>完成</button>
      </div>
      <div className="add-buttons" style={{ marginTop: 12 }}>
        <button onClick={() => add('anthropic')}>+ Anthropic</button>
        <button onClick={() => add('openai')}>+ OpenAI 兼容</button>
      </div>
      <div className="preset-list">
        {presets.map((p) => (
          <PresetRow
            key={p.id}
            preset={p}
            expanded={editingId === p.id}
            onToggle={() => setEditingId(editingId === p.id ? null : p.id)}
            onUpdate={(patch) => update(p.id, patch)}
            onRemove={() => remove(p.id)}
          />
        ))}
        {presets.length === 0 && <div className="empty">暂无预设。点击上方按钮添加。</div>}
      </div>
    </div>
  );
}

function PresetRow({
  preset,
  expanded,
  onToggle,
  onUpdate,
  onRemove,
}: {
  preset: ModelPreset;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<ModelPreset>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="preset-row">
      <div className="preset-summary" onClick={onToggle}>
        <span className="preset-label">{preset.label}</span>
        <span className="preset-provider">{preset.provider}</span>
        <span className="preset-model">{preset.model || '(no model)'}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          删除
        </button>
      </div>
      {expanded && (
        <div className="preset-edit">
          <Field label="名称">
            <input
              value={preset.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
            />
          </Field>
          <Field label="API Key">
            <input
              type="password"
              value={preset.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
          </Field>
          <Field label="Base URL">
            <input
              value={preset.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder={DEFAULT_BASE_URLS[preset.provider]}
            />
          </Field>
          <Field label="Model ID">
            <input
              value={preset.model}
              onChange={(e) => onUpdate({ model: e.target.value })}
              placeholder={preset.provider === 'anthropic' ? 'claude-opus-4-7-…' : 'gpt-5.2'}
            />
          </Field>
          <Field label="Max tokens">
            <input
              type="number"
              value={preset.maxTokens}
              onChange={(e) => onUpdate({ maxTokens: parseInt(e.target.value, 10) || 0 })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="prefs-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
