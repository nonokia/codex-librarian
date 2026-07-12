<?php

declare(strict_types=1);

namespace App\Store;

use DateTimeImmutable;

/** A task entity: identity, title, priority, optional due date, done flag. */
class Task
{
    public bool $done = false;

    public function __construct(
        public int $id,
        public string $title,
        public Priority $priority = Priority::Normal,
        public ?DateTimeImmutable $due = null,
    ) {
    }

    /** A task is overdue when it has a due date in the past and is not done. */
    public function overdue(DateTimeImmutable $now): bool
    {
        if ($this->done || $this->due === null) {
            return false;
        }
        return $this->due < $now;
    }

    public function markDone(): void
    {
        $this->done = true;
    }
}
