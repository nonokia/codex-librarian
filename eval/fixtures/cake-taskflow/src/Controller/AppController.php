<?php

declare(strict_types=1);

namespace App\Controller;

/**
 * Minimal CakePHP-shaped base controller. `redirect()` / `setAction()` stand in
 * for the framework methods a real `Cake\Controller\Controller` provides — their
 * bodies are irrelevant to the extractor, which recognizes the *call convention*,
 * not the implementation.
 */
class AppController
{
    /** @param array<string,string>|string $url */
    protected function redirect(array|string $url): mixed
    {
        return $url;
    }

    protected function setAction(string $action): mixed
    {
        return $action;
    }
}
