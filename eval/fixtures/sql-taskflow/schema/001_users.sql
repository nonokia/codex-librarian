-- Users: account records that own projects and tasks.

CREATE TABLE users (
    id         bigserial PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users (email);
