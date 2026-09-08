import { describe, expect, it } from 'vitest';
import {
  extractQuestionAnswer,
  renderQuestionCard,
} from '../../src/card/question-card.js';

describe('question cards', () => {
  it('renders text, single and multi variants', () => {
    // Single choice is buttons, not a form: its options must be readable in
    // the card body without opening a dropdown.
    for (const kind of ['text', 'multi'] as const) {
      const card = renderQuestionCard({
        id: 'q-1',
        kind,
        question: 'Pick one',
        options: ['a', 'b'],
      }) as {
        body: {
          elements: Array<{ tag: string; elements?: unknown[]; actions?: unknown[] }>;
        };
      };
      expect(card.body.elements.length).toBeGreaterThan(0);
      expect(card.body.elements.some((element) => element.tag === 'action')).toBe(false);
      const form = card.body.elements.find((element) => element.tag === 'form');
      expect(form?.elements).toBeDefined();
    }
  });

  it('lays single choice out as body text plus short numbered buttons', () => {
    // A dropdown showed an empty "Choose…" control: the options could not be
    // read or compared without opening it, and long ones were clipped inside.
    const card = renderQuestionCard({
      id: 'q-ab',
      kind: 'single',
      question: 'A or B?',
      options: ['keep the desktop behaviour', 'never ask on Feishu'],
      actionScope: 'chat:member:u1',
    }) as { body: { elements: Array<{ tag: string; content?: string; columns?: unknown[] }> } };
    const content = JSON.stringify(card);

    // Full option text in the body, numbered to match the buttons.
    expect(content).toContain('**[1]** keep the desktop behaviour');
    expect(content).toContain('**[2]** never ask on Feishu');
    // The buttons say only the number, so the row fits however long the
    // options are, and each carries its own answer.
    expect(content).toContain('"content":"1"');
    expect(content).toContain('"choice":"option-0"');
    expect(content).toContain('"choice":"option-1"');
    expect(content).toContain('"scope":"chat:member:u1"');
    // No form: the button submits by itself.
    expect(card.body.elements.some((element) => element.tag === 'form')).toBe(false);
  });

  it('wraps the input and submit button in a form for schema 2.0', () => {
    const card = renderQuestionCard({
      id: 'q-2',
      kind: 'text',
      question: 'Why?',
      actionScope: 'chat:member:u1',
    });
    const content = JSON.stringify(card);
    expect(content).toContain('"tag":"form"');
    expect(content).toContain('"form_action_type":"submit"');
    expect(content).toContain('"cmd":"question-submit","id":"q-2"');
    expect(content).toContain('"scope":"chat:member:u1"');
    expect(content).not.toContain('"tag":"action"');
  });

  it('tells users that replying to the card accepts free-form answers', () => {
    const card = renderQuestionCard({
      id: 'q-reply',
      kind: 'single',
      question: 'Choose',
      options: ['A', 'B'],
    });
    const content = JSON.stringify(card);
    expect(content).toContain('直接回复本卡片');
    expect(content).toContain('补充说明');
  });

  it('extracts single-choice answers back to labels', () => {
    expect(extractQuestionAnswer('single', 'option-1', ['red', 'blue'])).toBe('blue');
    expect(extractQuestionAnswer('multi', ['option-0', 'option-1'], ['red', 'blue'])).toEqual([
      'red',
      'blue',
    ]);
    expect(extractQuestionAnswer('text', '  hello  ')).toBe('hello');
    expect(extractQuestionAnswer('text', '   ')).toBeUndefined();
    expect(extractQuestionAnswer('single', undefined, ['red'])).toBeUndefined();
  });
});
