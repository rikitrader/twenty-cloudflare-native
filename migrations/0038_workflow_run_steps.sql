CREATE TABLE IF NOT EXISTS native_workflow_run_steps (
  run_id TEXT NOT NULL REFERENCES native_workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  output_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_native_workflow_run_steps_workspace
  ON native_workflow_run_steps(workspace_id, run_id, started_at);
