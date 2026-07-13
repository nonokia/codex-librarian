"""Raised by the store when a task id is unknown; mapped to HTTP 404."""


class NotFoundError(RuntimeError):
    @classmethod
    def for_id(cls, id: int) -> "NotFoundError":
        return cls(f"task {id} not found")
