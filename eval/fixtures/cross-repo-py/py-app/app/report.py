"""Reporting helpers over the taskcore API (locally aliased import)."""
from taskcore import overdue as is_overdue, Task


def overdue_titles(tasks: list[Task], now: int) -> list[str]:
    """The call site says `is_overdue`, the package exports it as `overdue`."""
    return [t.title for t in tasks if is_overdue(t, now)]
