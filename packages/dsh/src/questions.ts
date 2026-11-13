import type { Question, QuestionAnswer } from './dsh-types.js';

export class UserQuestionError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'UserQuestionError'; }
}
export function formatQuestions(questions: Question[], userId?: string): string {
  const mention = userId && /^[a-f\d]{24}$/i.test(userId) ? `<mention userId="${userId}" /> ` : '';
  return mention + questions.map((q, index) => [
    `**Q${index + 1}. ${q.header ? `${q.header}: ` : ''}${q.question}**`, q.detail,
    ...(q.options ?? []).map((option, number) => `${number + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
    q.multiSelect ? 'Reply with option numbers (e.g. 1,2), labels, or your own answer.' : 'Reply with an option number, label, or your own answer.',
  ].filter(Boolean).join('\n')).join('\n\n') + (questions.length > 1 ? '\n\nAnswer each question on a new line, or use Q1=…, Q2=… on separate lines.' : '');
}
/** Every question must be answered; ambiguous batches stay pending instead of silently dropping a question. */
export function parseQuestionReply(questions: Question[], text: string): QuestionAnswer | undefined {
  const trimmed = text.trim();
  if (!trimmed || questions.length === 0) return undefined;
  const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
  const named = new Map<number, string>();
  for (const line of lines) {
    const match = /^Q(\d+)\s*=\s*(.+)$/i.exec(line.trim());
    if (match) named.set(Number(match[1]) - 1, match[2]!);
  }
  const replies = named.size ? questions.map((_, index) => named.get(index))
    : questions.length === 1 ? [trimmed] : lines;
  if (replies.length !== questions.length || replies.some(value => !value?.trim())) return undefined;
  const answers: QuestionAnswer['answers'] = [];
  for (const [index, question] of questions.entries()) {
    const reply = replies[index]!.trim();
    const options = question.options ?? [];
    const exact = options.find(option => option.label.toLocaleLowerCase() === reply.toLocaleLowerCase());
    if (exact) { answers.push({ id: question.id, selected: [exact.label] }); continue; }
    const tokens = question.multiSelect ? reply.split(/[,，]/).map(token => token.trim()) : [reply];
    const selected: string[] = [];
    const custom: string[] = [];
    for (const token of tokens) {
      const number = /^\d+$/.test(token) ? Number(token) : undefined;
      const option = number === undefined ? options.find(item => item.label.toLocaleLowerCase() === token.toLocaleLowerCase()) : options[number - 1];
      if (option) { if (!selected.includes(option.label)) selected.push(option.label); }
      else custom.push(token);
    }
    answers.push({ id: question.id, selected, ...(custom.length ? { custom: custom.join(', ') } : {}) });
  }
  return { answers };
}
