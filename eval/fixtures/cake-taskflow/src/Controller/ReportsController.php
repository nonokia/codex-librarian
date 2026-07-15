<?php

declare(strict_types=1);

namespace App\Controller;

use App\Model\ReportService;

/** Reached from TasksController::archive through a cross-controller dispatch. */
class ReportsController extends AppController
{
    public function summary(): array
    {
        return ReportService::build();
    }
}
