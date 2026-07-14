import { MemStore, createTask, overdue, type Task } from '@acme/core';
import { randomUUID } from 'node:crypto';

const store = new MemStore();

export function addTask(title: string, dueAt: number): Task {
  const task = createTask(randomUUID(), title, dueAt);
  store.add(task.id, task.title, task.dueAt);
  return task;
}

export function overdueCount(tasks: Task[], now: number): number {
  return tasks.filter((t) => overdue(t, now)).length;
}
