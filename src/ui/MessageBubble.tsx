import React from 'react';
import type { Message } from '../providers/types';
import type { InProgress } from './store';

interface Props {
  message: Message | InProgress;
  streaming?: boolean;
}

export function MessageBubble({ message, streaming = false }: Props) {
  const role = message.role;
  return (
    <div className={`bubble bubble-${role}${streaming ? ' bubble-streaming' : ''}`}>
      <div className="bubble-role">{role === 'user' ? 'You' : 'AI'}</div>
      <div className="bubble-body">{message.content}</div>
    </div>
  );
}
