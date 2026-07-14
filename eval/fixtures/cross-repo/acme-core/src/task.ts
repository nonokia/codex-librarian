export interface Task {
  id: string;
  title: string;
  dueAt: number;
  done: boolean;
}

export function createTask(id: string, title: string, dueAt: number): Task {
  if (title.trim() === '') throw new Error('title must not be empty');
  return { id, title, dueAt, done: false };
}

/** A task is overdue when it is still open and its due date has passed. */
export function overdue(task: Task, now: number): boolean {
  return !task.done && task.dueAt < now;
}
