<?php

declare(strict_types=1);

namespace App\Model;

/**
 * Persistence for tasks. Static methods on purpose (fixture simplification): the
 * librarian PHP extractor resolves `TaskStore::x()` static calls to a symbol, so
 * the controllers' non-dispatch edges are resolved `calls` — the contrast that
 * makes the dispatches-edge A/B measurable (a controller reaches its store by a
 * plain call, but reaches the next *action* only through the framework).
 */
final class TaskStore
{
    /** @var array<int,array{id:int,title:string,done:bool}> */
    private static array $rows = [];
    private static int $seq = 0;

    public static function all(): array
    {
        return array_values(self::$rows);
    }

    public static function get(int $id): ?array
    {
        return self::$rows[$id] ?? null;
    }

    public static function create(string $title): int
    {
        $id = ++self::$seq;
        self::$rows[$id] = ['id' => $id, 'title' => $title, 'done' => false];
        return $id;
    }

    public static function update(int $id, string $title): void
    {
        if (isset(self::$rows[$id])) {
            self::$rows[$id]['title'] = $title;
        }
    }

    public static function markDone(int $id): void
    {
        if (isset(self::$rows[$id])) {
            self::$rows[$id]['done'] = true;
        }
    }
}
