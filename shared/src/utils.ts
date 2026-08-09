export function nowIso(): string {
  return new Date().toISOString();
}

export function createTaskId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(16).slice(2, 10);
  return `task-${timestamp}-${random}`;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function truncateText(text: string, maxLength = 2000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[truncated]`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
