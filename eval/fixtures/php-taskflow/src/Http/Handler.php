<?php

declare(strict_types=1);

namespace App\Http;

use App\Service\Service;
use App\Service\ValidationError;
use App\Store\NotFoundError;

/** Transport layer: maps service calls and their errors onto HTTP responses. */
class Handler
{
    public function __construct(private Service $service)
    {
    }

    /** @param array<string,mixed> $payload */
    public function handleCreate(array $payload): JsonResponse
    {
        try {
            $task = $this->service->createTask((string) ($payload['title'] ?? ''));
        } catch (ValidationError $e) {
            return JsonResponse::error(400, $e->getMessage());
        }
        return JsonResponse::ok(['id' => $task->id, 'title' => $task->title]);
    }

    public function handleComplete(int $id): JsonResponse
    {
        try {
            $this->service->completeTask($id);
        } catch (NotFoundError $e) {
            return JsonResponse::error(404, $e->getMessage());
        }
        return JsonResponse::ok(['completed' => $id]);
    }

    /** @return array<string,callable> */
    public function routes(): array
    {
        return [
            'POST /tasks' => fn (array $p): JsonResponse => $this->handleCreate($p),
            'POST /tasks/complete' => fn (int $id): JsonResponse => $this->handleComplete($id),
        ];
    }
}
