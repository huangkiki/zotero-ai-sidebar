import { describe, it, expect } from 'vitest';
import { parseKeybinding, formatKeybinding, matchesKeybinding } from '../../src/translate/keybinding';

describe('keybinding', () => {
  it('parses Shift+Enter', () => {
    expect(parseKeybinding('Shift+Enter')).toEqual({ key: 'Enter', shift: true, ctrl: false, alt: false, meta: false });
  });

  it('formats round-trip', () => {
    expect(formatKeybinding(parseKeybinding('Ctrl+Shift+ArrowDown')!)).toBe('Ctrl+Shift+ArrowDown');
  });

  it('matches a KeyboardEvent', () => {
    const ev = { key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent;
    expect(matchesKeybinding(ev, parseKeybinding('Shift+Enter')!)).toBe(true);
    expect(matchesKeybinding(ev, parseKeybinding('Enter')!)).toBe(false);
  });

  it('rejects empty/garbage', () => {
    expect(parseKeybinding('')).toBeNull();
    expect(parseKeybinding('+++')).toBeNull();
  });

  it('accepts Control/Option/Cmd aliases', () => {
    expect(parseKeybinding('Control+Option+Cmd+K')).toEqual({
      key: 'K', shift: false, ctrl: true, alt: true, meta: true,
    });
  });
});
