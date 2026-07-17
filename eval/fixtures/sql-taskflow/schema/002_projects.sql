-- Projects: grouping unit for tasks, owned by a user.

CREATE TABLE projects (
    id         bigserial PRIMARY KEY,
    owner_id   bigint NOT NULL REFERENCES users (id),
    name       text NOT NULL,
    archived   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
