<?php

declare(strict_types=1);

namespace App\Service;

use App\Store\Priority;
use App\Store\Store;
use App\Store\Task;
use DateTimeImmutable;

/** Maximum accepted title length; enforced by createTask. */
const MAX_TITLE = 120;

/**
 * Application service: the use-case layer over the Store contract. Depends on
 * the Store interface, never on a concrete store (constructor injection).
 */
class Service
{
    public function __construct(private Store $store)
    {
    }

    public function createTask(string $title, Priority $priority = Priority::Normal): Task
    {
        $title = trim($title);
        if ($title === '' || strlen($title) > MAX_TITLE) {
            throw new ValidationError('title must be 1..' . MAX_TITLE . ' chars');
        }
        $task = new Task(0, $title, $priority);
        $this->store->add($task);
        return $task;
    }

    public function completeTask(int $id): void
    {
        $this->store->complete($id);
    }

    /** @return Task[] */
    public function listTasks(): array
    {
        return $this->store->all();
    }

    /** @return Task[] */
    public function overdueTasks(DateTimeImmutable $now): array
    {
        return array_values(array_filter(
            $this->store->all(),
            fn (Task $task): bool => $task->overdue($now),
        ));
    }
}
