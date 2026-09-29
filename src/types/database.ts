
export interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface TableNameRow {
  name: string;
}

export interface SchemaVersion {
  version: number;
}

export interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  created_at: string;
  created_at_epoch: number;
  title?: string;
  prompt_number?: number;
  discovery_tokens?: number;
  // Added by the structured-observation migration as nullable columns. The four
  // array columns hold a JSON-encoded string array, not a parsed array.
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  // Added by the agent-attribution migration; null on rows written before it.
  agent_type?: string | null;
  agent_id?: string | null;
}

export interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
  prompt_number?: number;
  discovery_tokens?: number;
}

export interface UserPromptRecord {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project?: string;  
  platform_source?: string;
  created_at: string;
  created_at_epoch: number;
}

export interface SdkSessionRecord {
  id: number;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  platform_source: string;
  user_prompt: string;
  custom_title: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

export interface LatestPromptResult {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}
