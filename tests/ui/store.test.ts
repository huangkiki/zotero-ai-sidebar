import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../../src/ui/store';

describe('chat reducer', () => {
  it('appends user message on user_send', () => {
    const s = reducer(initialState, { type: 'user_send', content: 'hi' });
    expect(s.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(s.error).toBeNull();
  });

  it('starts an in-progress assistant on assistant_start', () => {
    const s = reducer(initialState, { type: 'assistant_start' });
    expect(s.inProgress).toEqual({ role: 'assistant', content: '' });
  });

  it('appends streamed text to in-progress assistant', () => {
    let s = reducer(initialState, { type: 'assistant_start' });
    s = reducer(s, { type: 'assistant_text', text: 'Hel' });
    s = reducer(s, { type: 'assistant_text', text: 'lo' });
    expect(s.inProgress?.content).toBe('Hello');
  });

  it('finalizes on assistant_done', () => {
    let s = reducer(initialState, { type: 'assistant_start' });
    s = reducer(s, { type: 'assistant_text', text: 'ok' });
    s = reducer(s, { type: 'assistant_done' });
    expect(s.messages).toEqual([{ role: 'assistant', content: 'ok' }]);
    expect(s.inProgress).toBeNull();
  });

  it('clears in-progress on assistant_error and records message', () => {
    let s = reducer(initialState, { type: 'assistant_start' });
    s = reducer(s, { type: 'assistant_error', message: 'boom' });
    expect(s.inProgress).toBeNull();
    expect(s.error).toBe('boom');
  });
});
