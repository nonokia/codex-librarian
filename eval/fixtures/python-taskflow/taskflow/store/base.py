"""The task store contracts: the read side, and the full store extending it."""

from abc import ABC, abstractmethod
from typing import List, Optional

from taskflow.store.task import Task


class Reader(ABC):
    """Read side of the task store (embedded by the full Store contract)."""

    @abstractmethod
    def get(self, id: int) -> Optional[Task]: ...

    @abstractmethod
    def all(self) -> List[Task]: ...


class Store(Reader):
    """The full task store contract; extends the read side."""

    @abstractmethod
    def add(self, task: Task) -> None: ...

    @abstractmethod
    def complete(self, id: int) -> None: ...

    @abstractmethod
    def remove(self, id: int) -> None: ...
