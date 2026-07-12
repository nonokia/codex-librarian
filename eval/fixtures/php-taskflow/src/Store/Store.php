<?php

declare(strict_types=1);

namespace App\Store;

/** The full task store contract; extends the read side. */
interface Store extends Reader
{
    public function add(Task $task): void;

    public function complete(int $id): void;

    public function remove(int $id): void;
}
