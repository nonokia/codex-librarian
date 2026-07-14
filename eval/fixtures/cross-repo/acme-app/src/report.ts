import { overdue as isOverdue, type Task } from '@acme/core';

/** Locally aliased import: the call site says `isOverdue`, the package says `overdue`. */
export function overdueTitles(tasks: Task[], now: number): string[] {
  return tasks.filter((t) => isOverdue(t, now)).map((t) => t.title);
}
