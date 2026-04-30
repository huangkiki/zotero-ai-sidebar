import type { Message } from '../providers/types';

export interface InProgress {
  role: 'assistant';
  content: string;
  thinking?: string;
}

export interface ChatState {
  messages: Message[];
  inProgress: InProgress | null;
  error: string | null;
}

export type ChatAction =
  | { type: 'user_send'; content: string }
  | { type: 'assistant_start' }
  | { type: 'assistant_text'; text: string }
  | { type: 'assistant_thinking'; text: string }
  | { type: 'assistant_done' }
  | { type: 'assistant_error'; message: string }
  | { type: 'reset' };

export const initialState: ChatState = {
  messages: [],
  inProgress: null,
  error: null,
};

export function reducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'user_send':
      return {
        ...s,
        messages: [...s.messages, { role: 'user', content: a.content }],
        error: null,
      };
    case 'assistant_start':
      return { ...s, inProgress: { role: 'assistant', content: '' } };
    case 'assistant_text':
      if (!s.inProgress) return s;
      return { ...s, inProgress: { ...s.inProgress, content: s.inProgress.content + a.text } };
    case 'assistant_thinking':
      if (!s.inProgress) return s;
      return {
        ...s,
        inProgress: { ...s.inProgress, thinking: (s.inProgress.thinking ?? '') + a.text },
      };
    case 'assistant_done':
      if (!s.inProgress) return s;
      return {
        ...s,
        messages: [...s.messages, { role: 'assistant', content: s.inProgress.content }],
        inProgress: null,
      };
    case 'assistant_error':
      return { ...s, inProgress: null, error: a.message };
    case 'reset':
      return initialState;
  }
}
