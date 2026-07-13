"""Transport layer: maps service calls and their errors onto HTTP responses."""

from typing import Any, Dict

from taskflow.http.response import JsonResponse
from taskflow.service.errors import ValidationError
from taskflow.service.service import Service
from taskflow.store.errors import NotFoundError


class Handler:
    def __init__(self, service: Service) -> None:
        self._service = service

    def handle_create(self, payload: Dict[str, Any]) -> JsonResponse:
        try:
            task = self._service.create_task(str(payload.get("title", "")))
        except ValidationError as e:
            return JsonResponse.error(400, str(e))
        return JsonResponse.ok({"id": task.id, "title": task.title})

    def handle_complete(self, id: int) -> JsonResponse:
        try:
            self._service.complete_task(id)
        except NotFoundError as e:
            return JsonResponse.error(404, str(e))
        return JsonResponse.ok({"completed": id})

    def routes(self) -> Dict[str, Any]:
        return {
            "POST /tasks": self.handle_create,
            "POST /tasks/complete": self.handle_complete,
        }
