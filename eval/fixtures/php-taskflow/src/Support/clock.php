<?php

declare(strict_types=1);

namespace App\Support;

use DateTimeImmutable;

/** Wall-clock now(), a free function used where overdue checks need the time. */
function now(): DateTimeImmutable
{
    return new DateTimeImmutable();
}
