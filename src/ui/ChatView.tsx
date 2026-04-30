import React, { useReducer, useState, useRef, useEffect } from 'react';
import { reducer, initialState } from './store';
import { MessageBubble } from './MessageBubble';
import type { Provider, Message } from '../providers/types';
import type { ModelPreset } from '../settings/types';

interface Props {
  provider: Provider;
  preset: ModelPreset;
  buildContext: () => Promise<{ systemPrompt: string; pdfText: string | null }>;
}

export function ChatView({ provider, preset, buildContext }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, state.inProgress]);

  const onSend = async () => {
    if (!input.trim() || state.inProgress) return;
    const text = input;
    setInput('');
    dispatch({ type: 'user_send', content: text });

    const ctx = await buildContext();
    let messagesForApi: Message[] = [
      ...state.messages,
      { role: 'user', content: text },
    ];
    if (ctx.pdfText && state.messages.length === 0) {
      messagesForApi = [
        { role: 'user', content: `[Paper full text]\n${ctx.pdfText}` },
        { role: 'assistant', content: 'Got it. Ask me anything about this paper.' },
        ...messagesForApi,
      ];
    }

    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'assistant_start' });
    try {
      for await (const chunk of provider.stream(
        messagesForApi,
        ctx.systemPrompt,
        preset,
        controller.signal,
      )) {
        if (chunk.type === 'text_delta') {
          dispatch({ type: 'assistant_text', text: chunk.text });
        } else if (chunk.type === 'thinking_delta') {
          dispatch({ type: 'assistant_thinking', text: chunk.text });
        } else if (chunk.type === 'error') {
          dispatch({ type: 'assistant_error', message: chunk.message });
          return;
        }
      }
      dispatch({ type: 'assistant_done' });
    } finally {
      abortRef.current = null;
    }
  };

  const onStop = () => abortRef.current?.abort();

  return (
    <div className="chat-view">
      <div className="messages">
        {state.messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {state.inProgress && <MessageBubble message={state.inProgress} streaming />}
        {state.error && <div className="error">{state.error}</div>}
        <div ref={endRef} />
      </div>
      <div className="input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="问点什么... (Ctrl+Enter 发送)"
          rows={3}
        />
        {state.inProgress ? (
          <button onClick={onStop}>停止</button>
        ) : (
          <button onClick={onSend} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
