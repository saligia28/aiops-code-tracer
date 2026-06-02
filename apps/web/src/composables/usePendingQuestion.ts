let pendingQuestion = '';

export function setPendingQuestion(question: string): void {
  pendingQuestion = question.trim();
}

export function consumePendingQuestion(): string {
  const question = pendingQuestion;
  pendingQuestion = '';
  return question;
}
