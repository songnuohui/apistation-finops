CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_encrypted TEXT NOT NULL DEFAULT '',
  next_run_at TIMESTAMPTZ,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO {{FINOPS_SCHEMA}}.backup_settings(id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.backup_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_one_active
  ON {{FINOPS_SCHEMA}}.backup_jobs ((true)) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS backup_jobs_created ON {{FINOPS_SCHEMA}}.backup_jobs(created_at DESC);
