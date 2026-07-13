"""Wall-clock now(), a free function used where overdue checks need the time."""

from datetime import datetime, timezone


def now() -> datetime:
    return datetime.now(timezone.utc)
