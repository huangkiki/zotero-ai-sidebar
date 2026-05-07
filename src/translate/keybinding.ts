export interface Keybinding {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export function parseKeybinding(input: string): Keybinding | null {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key || ['Shift', 'Ctrl', 'Alt', 'Meta'].includes(key)) return null;
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return {
    key,
    shift: mods.has('shift'),
    ctrl: mods.has('ctrl') || mods.has('control'),
    alt: mods.has('alt') || mods.has('option'),
    meta: mods.has('meta') || mods.has('cmd') || mods.has('command'),
  };
}

export function formatKeybinding(kb: Keybinding): string {
  const parts: string[] = [];
  if (kb.ctrl) parts.push('Ctrl');
  if (kb.alt) parts.push('Alt');
  if (kb.shift) parts.push('Shift');
  if (kb.meta) parts.push('Meta');
  parts.push(kb.key);
  return parts.join('+');
}

export function matchesKeybinding(
  ev: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  kb: Keybinding,
): boolean {
  return ev.key === kb.key
    && ev.shiftKey === kb.shift
    && ev.ctrlKey === kb.ctrl
    && ev.altKey === kb.alt
    && ev.metaKey === kb.meta;
}
