export type QuestionKind = 'single' | 'multi' | 'text';

export interface QuestionCardInput {
  id: string;
  kind: QuestionKind;
  question: string;
  options?: string[];
  placeholder?: string;
  actionScope?: string;
}

function formElement(input: QuestionCardInput, locale: CardLocale): object {
  if (input.kind === 'text') {
    return {
      tag: 'input',
      name: 'answer',
      placeholder: { tag: 'plain_text', content: input.placeholder ?? (locale === 'zh_cn' ? '请输入答案…' : 'Enter an answer…') },
    };
  }
  const options = (input.options ?? []).map((option, index) => ({
    text: { tag: 'plain_text', content: option },
    value: `option-${index}`,
  }));
  if (input.kind === 'multi') {
    return {
      tag: 'multi_select_static',
      name: 'answer',
      placeholder: { tag: 'plain_text', content: locale === 'zh_cn' ? '请选择（可多选）…' : 'Choose one or more…' },
      options,
    };
  }
  return {
    tag: 'select_static',
    name: 'answer',
    placeholder: { tag: 'plain_text', content: locale === 'zh_cn' ? '请选择…' : 'Choose…' },
    options,
  };
}

/**
 * Single choice, laid out as numbered buttons under the options themselves.
 *
 * The dropdown this replaces put every option behind a tap: on a phone the
 * card showed a question and an empty "Choose…" control, so the choice could
 * not be read and compared without opening it, and a long option was clipped
 * inside the control. Here the full text of each option is in the card body,
 * numbered, and the buttons are just `[1] [2] [3]` — short enough to sit on
 * one row whatever the options say.
 *
 * These buttons carry the choice in their own action value, so they submit on
 * press and need no form wrapper.
 */
function singleChoiceElements(input: QuestionCardInput, locale: CardLocale): object[] {
  const zh = locale === 'zh_cn';
  const options = input.options ?? [];
  const value = {
    cmd: 'question-submit',
    id: input.id,
    ...(input.actionScope ? { scope: input.actionScope } : {}),
  };
  return [
    {
      tag: 'markdown',
      content: options
        .map((option, index) => `**[${index + 1}]** ${option}`)
        .join('\n\n'),
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'default',
      columns: options.map((_option, index) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          type: index === 0 ? 'primary' : 'default',
          text: { tag: 'plain_text', content: `${index + 1}` },
          // The answer travels with the button, not through a form value.
          value: { ...value, choice: `option-${index}` },
        }],
      })),
    },
    {
      tag: 'markdown',
      content: zh
        ? `_按 1–${options.length} 选择，或直接回复本卡片补充说明。_`
        : `_Press 1–${options.length}, or reply to this card with a note._`,
    },
  ];
}

/**
 * Structured question card: single choice, multi choice, or free text.
 * The input/select and its submit button are wrapped in a `form` container —
 * schema 2.0 only returns the selected/filled value in the callback when the
 * interactive component lives inside a form with a submit-bound button.
 */
export function renderQuestionCard(input: QuestionCardInput): object {
  const body = (locale: CardLocale) => ({
      elements: [
        { tag: 'markdown', content: `❓ ${input.question}` },
        ...(input.kind === 'single' && (input.options?.length ?? 0) > 0
          ? singleChoiceElements(input, locale)
          : formBodyElements(input, locale)),
      ],
    });
  return localizedCard({
    zhCn: { summary: '问题', body: body('zh_cn') },
    enUs: { summary: 'Question', body: body('en_us') },
  });
}

/** Multi-choice and free text still need the form wrapper to return a value. */
function formBodyElements(input: QuestionCardInput, locale: CardLocale): object[] {
  return [
        {
          tag: 'markdown',
          content: locale === 'zh_cn'
            ? '💬 也可以直接回复本卡片作答；选项不合适时可输入补充说明。'
            : '💬 You can also reply directly to this card; add a free-form note if the options do not fit.',
        },
        {
          tag: 'form',
          name: `form-${input.id}`,
          elements: [
            formElement(input, locale),
            {
              tag: 'button',
              text: { tag: 'plain_text', content: locale === 'zh_cn' ? '提交' : 'Submit' },
              type: 'primary',
              value: {
                cmd: 'question-submit',
                id: input.id,
                ...(input.actionScope ? { scope: input.actionScope } : {}),
              },
              form_action_type: 'submit',
              name: `btn-submit-${input.id}`,
            },
          ],
        },
  ];
}

/**
 * Normalize a card action value into an answer for the question kind.
 * `answer` shapes: string (text / single select) or string[] (multi select).
 */
export function extractQuestionAnswer(
  kind: QuestionKind,
  value: unknown,
  options?: string[],
): string | string[] | undefined {
  const answer = value;
  if (kind === 'text') {
    return typeof answer === 'string' && answer.trim() ? answer.trim() : undefined;
  }
  const selected = Array.isArray(answer)
    ? answer.map((item) => String(item))
    : typeof answer === 'string' && answer
      ? [answer]
      : [];
  if (selected.length === 0) return undefined;
  const labels = options ?? [];
  const resolved = selected.map((item) => {
    const match = /^option-(\d+)$/.exec(item);
    if (match) {
      const index = Number(match[1]);
      return labels[index] ?? item;
    }
    return item;
  });
  return kind === 'single' ? resolved[0] : resolved;
}
import { localizedCard, type CardLocale } from './i18n.js';
