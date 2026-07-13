"""A task entity: identity, title, priority, optional due date, done flag."""

from datetime import datetime
from typing import Optional

from taskflow.store.priority import Priority


class Task:
    def __init__(
        self,
        id: int,
        title: str,
        priority: Priority = Priority.NORMAL,
        due: Optional[datetime] = None,
    ) -> None:
        self.id = id
        self.title = title
        self.priority = priority
        self.due = due
        self.done = False

    def overdue(self, now: datetime) -> bool:
        """A task is overdue when it has a due date in the past and is not done."""
        if self.done or self.due is None:
            return False
        return self.due < now

    def mark_done(self) -> None:
        self.done = True
