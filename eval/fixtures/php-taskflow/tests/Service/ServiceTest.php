<?php

declare(strict_types=1);

namespace App\Tests\Service;

use App\Service\Service;
use App\Service\ValidationError;
use App\Store\MemStore;
use App\Store\Task;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

use function App\Support\now;

class ServiceTest extends TestCase
{
    private function service(): Service
    {
        return new Service(new MemStore());
    }

    public function testCreateTaskPersistsAndReturns(): void
    {
        $service = $this->service();
        $task = $service->createTask('write tests');
        $this->assertSame('write tests', $task->title);
        $this->assertCount(1, $service->listTasks());
    }

    #[Test]
    public function rejectsEmptyTitle(): void
    {
        $this->expectException(ValidationError::class);
        $this->service()->createTask('   ');
    }

    public function testOverdueTasks(): void
    {
        $service = $this->service();
        $service->createTask('old');
        $overdue = $service->overdueTasks(now());
        $this->assertContainsOnlyInstancesOf(Task::class, $overdue);
    }
}
