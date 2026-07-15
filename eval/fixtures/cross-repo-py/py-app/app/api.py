"""Transport layer: turn requests into service calls."""
from app.service import add_task, overdue_count
from taskcore import Task


def handle_create(body: dict) -> Task:
    return add_task(body["title"], body["due_at"])


def handle_overdue(tasks: list[Task], now: int) -> dict:
    return {"overdue": overdue_count(tasks, now)}
