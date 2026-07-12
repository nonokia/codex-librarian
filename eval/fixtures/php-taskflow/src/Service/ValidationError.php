<?php

declare(strict_types=1);

namespace App\Service;

use InvalidArgumentException;

/** Raised by the service on invalid input; mapped to HTTP 400. */
class ValidationError extends InvalidArgumentException
{
}
