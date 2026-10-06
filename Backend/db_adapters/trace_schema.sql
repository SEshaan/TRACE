-- ============================================================================
-- TRACEABLE QUERY EXECUTION PLATFORM - AUDIT & LOGS RELATIONAL SCHEMA
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 1. DATABASE METADATA
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL, -- 'sqlite', 'postgresql', etc.
    connection_uri TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schemas (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    schema_id TEXT NOT NULL,
    name TEXT NOT NULL,
    row_count_estimate INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (schema_id) REFERENCES schemas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    name TEXT NOT NULL,
    data_type TEXT NOT NULL,
    nullable BOOLEAN NOT NULL DEFAULT 1,
    primary_key BOOLEAN NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    schema_id TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_column TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_column TEXT NOT NULL,
    FOREIGN KEY (schema_id) REFERENCES schemas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS indexes (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    name TEXT NOT NULL,
    unique_flag BOOLEAN NOT NULL DEFAULT 0,
    columns_json TEXT NOT NULL, -- JSON array of column names
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 2. QUERY EXECUTION & GRAPH
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_versions (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL, -- 'lm-studio', 'openai', etc.
    parameters_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_sessions (
    id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    root_state_id TEXT,
    current_state_id TEXT,
    status TEXT NOT NULL, -- 'new', 'active', 'failed', 'completed'
    model_version_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (model_version_id) REFERENCES model_versions(id)
);

CREATE TABLE IF NOT EXISTS query_states (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    status TEXT NOT NULL,
    sql_text TEXT,
    sql_params_json TEXT,
    preview_json TEXT, -- preview columns, rows sample, row count, execution_time_ms
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES query_states(id)
);

CREATE TABLE IF NOT EXISTS query_actions (
    id TEXT PRIMARY KEY,
    state_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    sequence_order INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS action_results (
    id TEXT PRIMARY KEY,
    state_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    execution_time_ms REAL,
    row_count INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE,
    FOREIGN KEY (action_id) REFERENCES query_actions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_id TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exploration_nodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_id TEXT NOT NULL,
    node_type TEXT NOT NULL, -- 'action', 'checkpoint', 'failure', 'recovery_branch'
    ui_metadata_json TEXT, -- React Flow position, styling, badges
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 3. LEARNING & MODEL FEEDBACK
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_id TEXT NOT NULL,
    model_version_id TEXT,
    prompt_context TEXT,
    decision_json TEXT,
    probabilities_json TEXT,
    confidence REAL,
    latency_ms REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE,
    FOREIGN KEY (model_version_id) REFERENCES model_versions(id)
);

CREATE TABLE IF NOT EXISTS decision_outcomes (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    action_result_id TEXT NOT NULL,
    validated_success BOOLEAN NOT NULL,
    user_accepted BOOLEAN, -- True if user did not revert/backtrack
    user_feedback TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES agent_decisions(id) ON DELETE CASCADE,
    FOREIGN KEY (action_result_id) REFERENCES action_results(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_samples (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    natural_language_request TEXT NOT NULL,
    state_context_json TEXT NOT NULL,
    target_action_json TEXT NOT NULL,
    is_positive_sample BOOLEAN NOT NULL DEFAULT 1,
    source TEXT DEFAULT 'session_trace',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 4. AUDIT & LOGGING
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS execution_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_id TEXT,
    sql_executed TEXT,
    duration_ms REAL,
    row_count INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS failure_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (state_id) REFERENCES query_states(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recovery_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    branch_state_id TEXT NOT NULL,
    correction_action_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES query_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_state_id) REFERENCES query_states(id) ON DELETE CASCADE
);
