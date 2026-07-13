"""Tiny response helper — status + body pair, built via static factories."""

from typing import Any, Dict


class JsonResponse:
    def __init__(self, status: int, body: Dict[str, Any]) -> None:
        self.status = status
        self.body = body

    @staticmethod
    def ok(body: Dict[str, Any]) -> "JsonResponse":
        return JsonResponse(200, body)

    @staticmethod
    def error(status: int, message: str) -> "JsonResponse":
        return JsonResponse(status, {"error": message})
