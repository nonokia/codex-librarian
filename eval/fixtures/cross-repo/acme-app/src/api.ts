import { addTask, overdueCount } from './service.ts';
import type { Task } from '@acme/core';

export function handleCreate(body: { title: string; dueAt: number }): Task {
  return addTask(body.title, body.dueAt);
}

export function handleOverdue(tasks: Task[], now: number): { overdue: number } {
  return { overdue: overdueCount(tasks, now) };
}
