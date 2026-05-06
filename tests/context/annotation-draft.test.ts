import { describe, expect, it } from 'vitest';
import { parseAnnotationSuggestion } from '../../src/context/annotation-draft';

describe('parseAnnotationSuggestion', () => {
  it('returns null comment when no header is present', () => {
    const result = parseAnnotationSuggestion('解释一下这段话即可。');
    expect(result.comment).toBeNull();
    expect(result.body).toBe('解释一下这段话即可。');
  });

  it('extracts bullet list comment and strips it from body', () => {
    const content = [
      '这段话强调了 X 的重要性。',
      '',
      '建议注释：',
      '- 第一条要点',
      '- 第二条要点',
      '- 第三条要点',
    ].join('\n');
    const { body, comment } = parseAnnotationSuggestion(content);
    expect(comment).toBe('- 第一条要点\n- 第二条要点\n- 第三条要点');
    expect(body).toBe('这段话强调了 X 的重要性。');
  });

  it('extracts single-line inline comment after Chinese colon', () => {
    const content = '解释正文。\n\n建议注释：这一句概括了全文论点。';
    const { body, comment } = parseAnnotationSuggestion(content);
    expect(comment).toBe('这一句概括了全文论点。');
    expect(body).toBe('解释正文。');
  });

  it('accepts ASCII colon variant', () => {
    const content = '解释。\n建议注释:  仅一句话';
    expect(parseAnnotationSuggestion(content).comment).toBe('仅一句话');
  });

  it('extracts bullets when header has trailing whitespace and bullets are mixed', () => {
    const content = [
      'Body.',
      '',
      '建议注释：   ',
      '  - 要点 A',
      '   • 要点 B',
    ].join('\n');
    expect(parseAnnotationSuggestion(content).comment).toBe('- 要点 A\n- 要点 B');
  });

  it('extracts optional annotation color without saving it into comment', () => {
    const content = [
      '解释正文。',
      '',
      '建议注释：',
      '- 这句话定义了核心任务。',
      '建议颜色：#2EA8E5',
    ].join('\n');
    const { body, comment, color } = parseAnnotationSuggestion(content);
    expect(body).toBe('解释正文。');
    expect(comment).toBe('- 这句话定义了核心任务。');
    expect(color).toBe('#2ea8e5');
  });

  it('takes only the last header occurrence', () => {
    const content = [
      '第一段提到"建议注释"这个词组，但不是真正的标记。',
      '',
      '建议注释：',
      '- 真正的要点',
    ].join('\n');
    expect(parseAnnotationSuggestion(content).comment).toBe('- 真正的要点');
  });

  it('returns null when block body is empty', () => {
    const content = '解释正文。\n\n建议注释：\n   \n';
    const { comment } = parseAnnotationSuggestion(content);
    expect(comment).toBeNull();
  });
});
