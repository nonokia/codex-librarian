-- Audit trail: every task status change is recorded by a trigger.

CREATE TABLE task_events (
    id         bigserial PRIMARY KEY,
    task_id    bigint NOT NULL REFERENCES tasks (id),
    old_status text,
    new_status text,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION log_task_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO task_events (task_id, old_status, new_status)
    VALUES (OLD.id, OLD.status, NEW.status);
    RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_audit
    AFTER UPDATE OF status ON tasks
    FOR EACH ROW EXECUTE FUNCTION log_task_change();
