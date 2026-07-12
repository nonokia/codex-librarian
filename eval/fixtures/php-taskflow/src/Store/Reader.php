<?php

declare(strict_types=1);

namespace App\Store;

/** Read side of the task store (embedded by the full Store contract). */
interface Reader
{
    public function get(int $id): ?Task;

    /** @return Task[] */
    public function all(): array;
}
