<?php

declare(strict_types=1);

namespace App\Store;

/** Monotonic id generation, mixed into stores via `use Sequence`. */
trait Sequence
{
    private int $seq = 0;

    protected function nextId(): int
    {
        return ++$this->seq;
    }
}
