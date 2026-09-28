import type {
  ObservationRecord,
  SdkSessionRecord,
  SessionSummaryRecord,
  UserPromptRecord,
} from '../../src/types/database.js';

export type {
  ObservationRecord,
  SdkSessionRecord,
  SessionSummaryRecord,
  UserPromptRecord,
};

/** Body of `GET /api/search?format=json`, as `export-memories` reads it. */
export interface SearchExportResponse {
  observations?: ObservationRecord[];
  sessions?: SessionSummaryRecord[];
  prompts?: UserPromptRecord[];
}

export interface ExportData {
  exportedAt: string;
  exportedAtEpoch: number;
  query: string;
  project?: string;
  totalObservations: number;
  totalSessions: number;
  totalSummaries: number;
  totalPrompts: number;
  observations: ObservationRecord[];
  sessions: SdkSessionRecord[];
  summaries: SessionSummaryRecord[];
  prompts: UserPromptRecord[];
}
