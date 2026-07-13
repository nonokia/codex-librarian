import pytest

from taskflow.service.errors import ValidationError
from taskflow.service.service import Service
from taskflow.store.memstore import MemStore
from taskflow.store.task import Task
from taskflow.support.clock import now


def service() -> Service:
    return Service(MemStore())


def test_create_task_persists_and_returns() -> None:
    svc = service()
    task = svc.create_task("write tests")
    assert task.title == "write tests"
    assert len(svc.list_tasks()) == 1


def test_rejects_empty_title() -> None:
    with pytest.raises(ValidationError):
        service().create_task("   ")


def test_overdue_tasks() -> None:
    svc = service()
    svc.create_task("old")
    overdue = svc.overdue_tasks(now())
    assert all(isinstance(t, Task) for t in overdue)
