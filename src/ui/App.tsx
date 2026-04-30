import React, { useEffect, useState, useCallback } from 'react';
import { ChatView } from './ChatView';
import { PresetSwitcher } from './PresetSwitcher';
import { ContextCard } from './ContextCard';
import { PreferencesPane } from './PreferencesPane';
import { loadPresets, zoteroPrefs } from '../settings/storage';
import { getProvider } from '../providers/factory';
import { buildContext, type ItemMetadata } from '../context/builder';
import { zoteroContextSource } from '../context/zotero-source';
import type { ModelPreset } from '../settings/types';

interface Props {
  itemID: number | null;
}

export function App({ itemID }: Props) {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [item, setItem] = useState<ItemMetadata | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);

  const reloadPresets = useCallback(() => {
    const p = loadPresets(zoteroPrefs());
    setPresets(p);
    if (p.length && !selectedId) setSelectedId(p[0].id);
    if (selectedId && !p.find((x) => x.id === selectedId)) {
      setSelectedId(p[0]?.id ?? null);
    }
  }, [selectedId]);

  useEffect(() => {
    reloadPresets();
  }, []);

  useEffect(() => {
    if (itemID == null) {
      setItem(null);
      return;
    }
    zoteroContextSource.getItem(itemID).then(setItem).catch(() => setItem(null));
  }, [itemID]);

  const preset = presets.find((p) => p.id === selectedId) ?? null;
  const provider = preset ? getProvider(preset) : null;

  const buildCtx = useCallback(async () => {
    return buildContext(zoteroContextSource, itemID, 100_000);
  }, [itemID]);

  if (showPrefs) {
    return (
      <div className="zai-app">
        <PreferencesPane
          onDone={() => {
            setShowPrefs(false);
            reloadPresets();
          }}
        />
      </div>
    );
  }

  return (
    <div className="zai-app" key={itemID ?? 'no-item'}>
      <PresetSwitcher
        presets={presets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenSettings={() => setShowPrefs(true)}
      />
      <ContextCard item={item} />
      {provider && preset ? (
        <ChatView provider={provider} preset={preset} buildContext={buildCtx} />
      ) : (
        <div className="empty-state">先到设置里添加一个模型预设。</div>
      )}
    </div>
  );
}
