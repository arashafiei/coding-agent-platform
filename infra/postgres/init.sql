CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  request_id TEXT,
  github_repo TEXT,
  github_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'INITIAL_BUILD',
  request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'created',
  plan JSONB,
  human_feedback JSONB NOT NULL DEFAULT '[]'::jsonb,
  fix_attempt INT NOT NULL DEFAULT 0,
  final_report TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS code_versions (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  files JSONB NOT NULL,
  commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_results (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt INT NOT NULL DEFAULT 0,
  command TEXT NOT NULL,
  exit_code INT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL DEFAULT 'project',
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, namespace, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_request_id ON projects(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_actions (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  attempt INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  source TEXT NOT NULL DEFAULT 'manual',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE(run_id, action, attempt)
);
CREATE INDEX IF NOT EXISTS idx_run_actions_run_action ON run_actions(run_id, action, attempt DESC);
