"""Task domain type and the pure helpers over it."""
from dataclasses import dataclass


@dataclass
class Task:
    id: str
    title: str
    due_at: int
    done: bool = False


def create_task(id: str, title: str, due_at: int) -> Task:
    if title.strip() == "":
        raise ValueError("title must not be empty")
    return Task(id=id, title=title, due_at=due_at)


def overdue(task: Task, now: int) -> bool:
    """A task is overdue when it is still open and its due date has passed."""
    return not task.done and task.due_at < now
