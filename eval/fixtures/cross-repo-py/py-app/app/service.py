"""Application service: create tasks and count overdue ones."""
from uuid import uuid4

from taskcore import MemStore, Task, create_task, overdue

_store = MemStore()


def add_task(title: str, due_at: int) -> Task:
    task = create_task(uuid4().hex, title, due_at)
    _store.add(task.id, task.title, task.due_at)
    return task


def overdue_count(tasks: list[Task], now: int) -> int:
    return len([t for t in tasks if overdue(t, now)])
