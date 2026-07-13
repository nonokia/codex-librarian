"""In-memory Store implementation; assigns ids via the Sequence mixin."""

from typing import Dict, List, Optional

from taskflow.store.base import Store
from taskflow.store.errors import NotFoundError
from taskflow.store.sequence import Sequence
from taskflow.store.task import Task


class MemStore(Sequence, Store):
    def __init__(self) -> None:
        super().__init__()
        self._tasks: Dict[int, Task] = {}

    def get(self, id: int) -> Optional[Task]:
        return self._tasks.get(id)

    def all(self) -> List[Task]:
        return list(self._tasks.values())

    def add(self, task: Task) -> None:
        if task.id == 0:
            task.id = self.next_id()
        self._tasks[task.id] = task

    def complete(self, id: int) -> None:
        task = self.get(id)
        if task is None:
            raise NotFoundError.for_id(id)
        task.mark_done()

    def remove(self, id: int) -> None:
        if id not in self._tasks:
            raise NotFoundError.for_id(id)
        del self._tasks[id]
