-- Migration: free-form notes on tasks, and a backfill for legacy rows.

ALTER TABLE tasks ADD COLUMN notes text;

UPDATE tasks SET notes = '' WHERE notes IS NULL;
