<?php

declare(strict_types=1);

namespace App\Store;

use RuntimeException;

/** Raised by the store when a task id is unknown; mapped to HTTP 404. */
class NotFoundError extends RuntimeException
{
    public static function forId(int $id): self
    {
        return new self("task {$id} not found");
    }
}
