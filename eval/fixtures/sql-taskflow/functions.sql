-- Task lifecycle routines.

CREATE FUNCTION complete_task(tid bigint) RETURNS void LANGUAGE sql AS $$
    UPDATE tasks SET status = 'done' WHERE id = tid;
$$;

CREATE PROCEDURE archive_done_tasks() LANGUAGE sql AS $$
    INSERT INTO task_events (task_id, old_status, new_status)
    SELECT id, status, 'archived' FROM tasks WHERE status = 'done';
    DELETE FROM tasks WHERE status = 'done';
$$;
