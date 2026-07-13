from taskflow.http.handler import Handler
from taskflow.service.service import Service
from taskflow.store.memstore import MemStore


def handler() -> Handler:
    return Handler(Service(MemStore()))


def test_handle_create_returns_200() -> None:
    response = handler().handle_create({"title": "ship it"})
    assert response.status == 200


def test_handle_create_rejects_empty() -> None:
    response = handler().handle_create({"title": ""})
    assert response.status == 400


def test_handle_complete_not_found() -> None:
    response = handler().handle_complete(404)
    assert response.status == 404
