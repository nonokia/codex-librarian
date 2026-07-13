import pytest

from taskflow.store.errors import NotFoundError
from taskflow.store.memstore import MemStore
from taskflow.store.task import Task


def test_add_assigns_sequential_ids() -> None:
    store = MemStore()
    store.add(Task(0, "a"))
    store.add(Task(0, "b"))
    assert [t.id for t in store.all()] == [1, 2]


def test_complete() -> None:
    store = MemStore()
    store.add(Task(0, "a"))
    store.complete(1)
    task = store.get(1)
    assert task is not None and task.done


def test_complete_missing_raises() -> None:
    store = MemStore()
    with pytest.raises(NotFoundError):
        store.complete(99)


def test_remove_missing_raises() -> None:
    store = MemStore()
    with pytest.raises(NotFoundError):
        store.remove(99)
