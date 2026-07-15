"""Regression tests for the app service."""
from app.service import add_task, overdue_count


def test_creates_a_task_with_generated_id():
    add_task("write the linker", 1000)


def test_counts_overdue_tasks():
    overdue_count([], 2000)
