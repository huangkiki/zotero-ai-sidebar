import { describe, it, expect } from 'vitest';
import { buildContext, type ContextSource } from '../../src/context/builder';

const fakeSource: ContextSource = {
  async getItem(id) {
    if (id !== 1) return null;
    return {
      title: 'Attention Is All You Need',
      authors: ['Vaswani', 'Shazeer'],
      year: 2017,
      tags: ['transformer'],
      abstract: 'We propose a new architecture.',
    };
  },
  async getFullText(_id) {
    return 'A'.repeat(10_000);
  },
};

describe('buildContext', () => {
  it('returns base prompt only when no item id', async () => {
    const ctx = await buildContext(fakeSource, null, 100);
    expect(ctx.systemPrompt).toMatch(/research assistant/);
    expect(ctx.pdfText).toBeNull();
  });

  it('returns base prompt only when item not found', async () => {
    const ctx = await buildContext(fakeSource, 999, 100);
    expect(ctx.systemPrompt).toMatch(/research assistant/);
    expect(ctx.pdfText).toBeNull();
  });

  it('includes metadata block in system prompt when item present', async () => {
    const ctx = await buildContext(fakeSource, 1, 1000);
    expect(ctx.systemPrompt).toContain('Title: Attention Is All You Need');
    expect(ctx.systemPrompt).toContain('Authors: Vaswani, Shazeer');
    expect(ctx.systemPrompt).toContain('Year: 2017');
    expect(ctx.systemPrompt).toContain('Tags: transformer');
    expect(ctx.systemPrompt).toContain('Abstract: We propose a new architecture.');
  });

  it('truncates pdf text to ~4 chars per token budget', async () => {
    const ctx = await buildContext(fakeSource, 1, 100);
    expect(ctx.pdfText?.length).toBe(400);
  });
});
