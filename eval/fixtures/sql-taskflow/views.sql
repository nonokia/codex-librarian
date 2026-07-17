-- Read models over the base tables.

CREATE VIEW active_tasks AS
SELECT t.id, t.title, t.status, t.due_at, u.email AS assignee_email, p.name AS project_name
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN users u ON u.id = t.assignee_id
WHERE t.status <> 'done'
  AND NOT p.archived;

CREATE MATERIALIZED VIEW project_task_stats AS
SELECT p.id AS project_id,
       p.name,
       count(*) FILTER (WHERE t.status = 'open')  AS open_tasks,
       count(*) FILTER (WHERE t.status = 'done')  AS done_tasks
FROM projects p
LEFT JOIN tasks t ON t.project_id = p.id
GROUP BY p.id, p.name;
