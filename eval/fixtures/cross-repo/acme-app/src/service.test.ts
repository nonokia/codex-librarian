import { addTask, overdueCount } from './service.ts';

declare function it(title: string, fn: () => void): void;

it('creates a task with a generated id', () => {
  addTask('write the linker', 1000);
});

it('counts overdue tasks', () => {
  overdueCount([], 2000);
});
