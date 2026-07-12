<?php

declare(strict_types=1);

namespace App;

use App\Http\Handler;
use App\Service\Service;
use App\Store\MemStore;
use App\Store\Store;

/** Composition root: wires the concrete store up through the HTTP handler. */
final class Factory
{
    public static function build(): Handler
    {
        $store = self::store();
        return new Handler(new Service($store));
    }

    public static function store(): Store
    {
        return new MemStore();
    }
}
