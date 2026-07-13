"""Application service: the use-case layer over the Store contract.

Depends on the Store contract, never on a concrete store (constructor
injection).
"""

from datetime import datetime
from typing import List

from taskflow.service.errors import ValidationError
from taskflow.store.base import Store
from taskflow.store.priority import Priority
from taskflow.store.task import Task

MAX_TITLE = 120
"""Maximum accepted title length; enforced by create_task."""


class Service:
    def __init__(self, store: Store) -> None:
        self._store = store

    def create_task(self, title: str, priority: Priority = Priority.NORMAL) -> Task:
        title = title.strip()
        if title == "" or len(title) > MAX_TITLE:
            raise ValidationError(f"title must be 1..{MAX_TITLE} chars")
        task = Task(0, title, priority)
        self._store.add(task)
        return task

    def complete_task(self, id: int) -> None:
        self._store.complete(id)

    def list_tasks(self) -> List[Task]:
        return self._store.all()

    def overdue_tasks(self, now: datetime) -> List[Task]:
        return [task for task in self._store.all() if task.overdue(now)]
