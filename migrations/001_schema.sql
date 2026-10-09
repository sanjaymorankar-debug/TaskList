-- TaskList schema. Safe to run more than once: every statement checks first.
-- The app applies the files in this folder, in name order, on every start.
--
-- Dates the user types (planned/actual start and end) are DATE: a calendar day,
-- no time zone. Moments the server records (created_at, comment times) are
-- TIMESTAMPTZ, stored in UTC and shown in IST by the app.

-- Optional grouping, carried over from the earlier Task Tracker so its data
-- still fits. `legacy` keeps the old project fields that have no place here.
CREATE TABLE IF NOT EXISTS projects (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT,
  legacy      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sr_no is the task's Sr No. and its key. GENERATED ALWAYS means it can only
-- come from the sequence: an insert cannot choose it, an update cannot change
-- it, and a sequence never hands out the same number twice, so a deleted
-- task's number is never reused.
CREATE TABLE IF NOT EXISTS tasks (
  sr_no              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description        TEXT,
  project_id         BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'Not Started'
                     CHECK (status IN ('Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled')),
  owner              TEXT,
  planned_start      DATE,
  planned_end        DATE,
  actual_start       DATE,
  actual_end         DATE,
  delay_reason       TEXT,
  next_action        TEXT,
  next_action_owner  TEXT,
  legacy             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_planned_order CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start),
  CONSTRAINT tasks_actual_order  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end >= actual_start)
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);

-- "task_sr_no waits for depends_on_sr_no". Deleting either task removes the link.
-- The loop check (A waits for B waits for A) is done by the app, because a
-- CHECK constraint cannot look at other rows.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_sr_no       BIGINT NOT NULL REFERENCES tasks(sr_no) ON DELETE CASCADE,
  depends_on_sr_no BIGINT NOT NULL REFERENCES tasks(sr_no) ON DELETE CASCADE,
  PRIMARY KEY (task_sr_no, depends_on_sr_no),
  CONSTRAINT task_dependencies_not_self CHECK (task_sr_no <> depends_on_sr_no)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_reverse ON task_dependencies (depends_on_sr_no);

-- Comments are append-only. created_at defaults to the database clock and the
-- API never accepts a time from the client.
CREATE TABLE IF NOT EXISTS comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_sr_no BIGINT NOT NULL REFERENCES tasks(sr_no) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_sr_no, created_at, id);

-- Keeps the history true even against a stray UPDATE or DELETE typed into psql.
-- The one delete allowed is the cascade from deleting the task itself: by the
-- time it reaches this trigger the task row is already gone.
CREATE OR REPLACE FUNCTION tasklist_comments_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Comments cannot be edited once saved';
  END IF;
  IF EXISTS (SELECT 1 FROM tasks WHERE sr_no = OLD.task_sr_no) THEN
    RAISE EXCEPTION 'Comments cannot be deleted once saved';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS comments_append_only ON comments;
CREATE TRIGGER comments_append_only
  BEFORE UPDATE OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION tasklist_comments_append_only();

-- Which rows the one-off import (scripts/import-legacy.js) has already copied,
-- so running it again adds nothing twice.
CREATE TABLE IF NOT EXISTS legacy_import (
  source      TEXT   NOT NULL,
  kind        TEXT   NOT NULL,
  legacy_id   BIGINT NOT NULL,
  new_id      BIGINT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, kind, legacy_id)
);
