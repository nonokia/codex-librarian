<?php

declare(strict_types=1);

namespace App\Controller;

use App\Model\TaskStore;

/**
 * Task screens. Each action does its own work through a resolved static `calls`
 * edge to TaskStore, then hands off to the *next screen* through a CakePHP
 * runtime dispatch (`redirect`/`setAction`) — the transition the language grammar
 * cannot see. Those hand-offs only reach the graph once `resolve-dispatches` binds
 * the `dispatches` edges the php-extractor emitted unresolved.
 */
class TasksController extends AppController
{
    public function index(): array
    {
        return TaskStore::all();
    }

    public function add(string $title): mixed
    {
        TaskStore::create($title);
        // hand off to the detail screen — dispatch to TasksController::view
        return $this->redirect(['action' => 'view']);
    }

    public function view(int $id): ?array
    {
        return TaskStore::get($id);
    }

    public function edit(int $id, string $title): mixed
    {
        TaskStore::update($id, $title);
        // re-render as the detail screen — dispatch to TasksController::view
        $this->setAction('view');
        return $id;
    }

    public function complete(int $id): mixed
    {
        TaskStore::markDone($id);
        // back to the list screen — dispatch to TasksController::index
        return $this->redirect(['controller' => 'Tasks', 'action' => 'index']);
    }

    public function archive(): mixed
    {
        // cross-controller hand-off — dispatch to ReportsController::summary
        return $this->redirect(['controller' => 'Reports', 'action' => 'summary']);
    }
}
