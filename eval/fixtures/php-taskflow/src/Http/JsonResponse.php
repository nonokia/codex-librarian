<?php

declare(strict_types=1);

namespace App\Http;

/** Tiny response helper — status + body pair, built via static factories. */
final class JsonResponse
{
    /** @param array<string,mixed> $body */
    public function __construct(public int $status, public array $body)
    {
    }

    /** @param array<string,mixed> $body */
    public static function ok(array $body): self
    {
        return new self(200, $body);
    }

    public static function error(int $status, string $message): self
    {
        return new self($status, ['error' => $message]);
    }
}
