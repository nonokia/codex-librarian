-- Tasks: the core work item. References its owner and project.

CREATE TABLE tasks (
    id          bigserial PRIMARY KEY,
    project_id  bigint NOT NULL REFERENCES projects (id),
    assignee_id bigint REFERENCES users (id),
    title       text NOT NULL,
    status      text NOT NULL DEFAULT 'open',
    due_at      timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_status ON tasks (status);

CREATE INDEX idx_tasks_project ON tasks (project_id);
