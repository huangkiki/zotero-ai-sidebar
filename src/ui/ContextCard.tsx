import React from 'react';
import type { ItemMetadata } from '../context/builder';

interface Props {
  item: ItemMetadata | null;
}

export function ContextCard({ item }: Props) {
  if (!item) {
    return <div className="ctx-card ctx-empty">未选中条目，纯聊天模式</div>;
  }
  return (
    <div className="ctx-card">
      <div className="ctx-title">{item.title}</div>
      <div className="ctx-meta">
        {item.authors.slice(0, 3).join(', ')}
        {item.authors.length > 3 ? ' et al.' : ''}
        {item.year ? ` · ${item.year}` : ''}
      </div>
    </div>
  );
}
