"""Raised by the service on invalid input; mapped to HTTP 400."""


class ValidationError(ValueError):
    pass
