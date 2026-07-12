<?php

declare(strict_types=1);

namespace App\Tests\Http;

use App\Http\Handler;
use App\Service\Service;
use App\Store\MemStore;
use PHPUnit\Framework\TestCase;

class HandlerTest extends TestCase
{
    private function handler(): Handler
    {
        return new Handler(new Service(new MemStore()));
    }

    public function testHandleCreateReturns200(): void
    {
        $response = $this->handler()->handleCreate(['title' => 'ship it']);
        $this->assertSame(200, $response->status);
    }

    public function testHandleCreateRejectsEmpty(): void
    {
        $response = $this->handler()->handleCreate(['title' => '']);
        $this->assertSame(400, $response->status);
    }

    public function testHandleCompleteNotFound(): void
    {
        $response = $this->handler()->handleComplete(404);
        $this->assertSame(404, $response->status);
    }
}
