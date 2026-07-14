import { createTask, overdue, type Task } from './task.ts';

export class MemStore {
  private tasks = new Map<string, Task>();

  add(id: string, title: string, dueAt: number): Task {
    const task = createTask(id, title, dueAt);
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  overdueTasks(now: number): Task[] {
    return [...this.tasks.values()].filter((t) => overdue(t, now));
  }
}
