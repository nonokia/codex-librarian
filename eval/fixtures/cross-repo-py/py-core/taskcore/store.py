"""In-memory task store built on the domain helpers."""
from taskcore.task import Task, create_task, overdue


class MemStore:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}

    def add(self, id: str, title: str, due_at: int) -> Task:
        task = create_task(id, title, due_at)
        self._tasks[id] = task
        return task

    def get(self, id: str) -> Task | None:
        return self._tasks.get(id)

    def overdue_tasks(self, now: int) -> list[Task]:
        return [t for t in self._tasks.values() if overdue(t, now)]
