"""Task priority — an enum used as a Task attribute type."""

from enum import Enum


class Priority(Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"

    def weight(self) -> int:
        return {Priority.LOW: 1, Priority.NORMAL: 2, Priority.HIGH: 3}[self]
