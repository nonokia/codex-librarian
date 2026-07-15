<?php

declare(strict_types=1);

namespace App\Model;

/** Builds the archive/summary report; reached only through a cross-controller dispatch. */
final class ReportService
{
    public static function build(): array
    {
        $tasks = TaskStore::all();
        return ['total' => count($tasks)];
    }
}
