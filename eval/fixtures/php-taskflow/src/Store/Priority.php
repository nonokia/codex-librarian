<?php

declare(strict_types=1);

namespace App\Store;

/** Task priority — a backed enum, used as a Task property type. */
enum Priority: string
{
    case Low = 'low';
    case Normal = 'normal';
    case High = 'high';

    public function weight(): int
    {
        return match ($this) {
            Priority::Low => 1,
            Priority::Normal => 2,
            Priority::High => 3,
        };
    }
}
