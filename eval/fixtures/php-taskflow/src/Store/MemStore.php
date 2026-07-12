<?php

declare(strict_types=1);

namespace App\Store;

/** In-memory Store implementation; assigns ids via the Sequence trait. */
class MemStore implements Store
{
    use Sequence;

    /** @var array<int,Task> */
    private array $tasks = [];

    public function get(int $id): ?Task
    {
        return $this->tasks[$id] ?? null;
    }

    /** @return Task[] */
    public function all(): array
    {
        return array_values($this->tasks);
    }

    public function add(Task $task): void
    {
        if ($task->id === 0) {
            $task->id = $this->nextId();
        }
        $this->tasks[$task->id] = $task;
    }

    public function complete(int $id): void
    {
        $task = $this->get($id);
        if ($task === null) {
            throw NotFoundError::forId($id);
        }
        $task->markDone();
    }

    public function remove(int $id): void
    {
        if (!isset($this->tasks[$id])) {
            throw NotFoundError::forId($id);
        }
        unset($this->tasks[$id]);
    }
}
