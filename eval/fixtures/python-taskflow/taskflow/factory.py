"""Composition root: wires the concrete store up through the HTTP handler."""

from taskflow.http.handler import Handler
from taskflow.service.service import Service
from taskflow.store.base import Store
from taskflow.store.memstore import MemStore


def build() -> Handler:
    return Handler(Service(store()))


def store() -> Store:
    return MemStore()
