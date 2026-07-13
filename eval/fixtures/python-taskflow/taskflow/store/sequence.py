"""Monotonic id generation, mixed into stores by inheritance."""


class Sequence:
    def __init__(self) -> None:
        self._seq = 0

    def next_id(self) -> int:
        self._seq += 1
        return self._seq
