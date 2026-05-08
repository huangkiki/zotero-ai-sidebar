import { describe, expect, it } from 'vitest';
import { normalizeTranslateSettings } from '../../src/translate/settings';


describe('translate settings', () => {
  it('uses GPT reasoning-compatible translate thinking values', () => {
    expect(normalizeTranslateSettings({ thinking: 'xhigh' }).thinking).toBe('xhigh');
    expect(normalizeTranslateSettings({ thinking: 'minimal' }).thinking).toBe('low');
    expect(normalizeTranslateSettings({ thinking: 'none' }).thinking).toBe('low');
  });

  it('normalizes translate trigger mode', () => {
    expect(normalizeTranslateSettings({ triggerMode: 'double' }).triggerMode).toBe('double');
    expect(normalizeTranslateSettings({ triggerMode: 'single' }).triggerMode).toBe('single');
    expect(normalizeTranslateSettings({ triggerMode: 'drag' }).triggerMode).toBe('single');
  });

  it('normalizes translate overlay size', () => {
    expect(normalizeTranslateSettings({ overlaySize: 'adaptive' }).overlaySize).toBe('adaptive');
    expect(normalizeTranslateSettings({ overlaySize: 'compact' }).overlaySize).toBe('compact');
    expect(normalizeTranslateSettings({ overlaySize: 'full' }).overlaySize).toBe('compact');
  });
});
