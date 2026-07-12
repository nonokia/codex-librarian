<?php

declare(strict_types=1);

namespace App\Tests\Store;

use App\Store\MemStore;
use App\Store\NotFoundError;
use App\Store\Task;
use PHPUnit\Framework\TestCase;

class MemStoreTest extends TestCase
{
    public function testAddAssignsSequentialIds(): void
    {
        $store = new MemStore();
        $store->add(new Task(0, 'a'));
        $store->add(new Task(0, 'b'));
        $ids = array_map(fn (Task $t): int => $t->id, $store->all());
        $this->assertSame([1, 2], $ids);
    }

    public function testComplete(): void
    {
        $store = new MemStore();
        $store->add(new Task(0, 'a'));
        $store->complete(1);
        $this->assertTrue($store->get(1)->done);
    }

    public function testCompleteMissingThrows(): void
    {
        $store = new MemStore();
        $this->expectException(NotFoundError::class);
        $store->complete(99);
    }

    public function testRemoveMissingThrows(): void
    {
        $store = new MemStore();
        $this->expectException(NotFoundError::class);
        $store->remove(99);
    }
}
