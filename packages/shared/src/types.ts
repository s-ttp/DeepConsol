export type UserRole = "engineer" | "admin";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  must_rotate_password: boolean;
  created_at: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export type DocumentVisibility = "private" | "group" | "global";

export type DocumentStatus =
  | "uploaded"
  | "queued"
  | "parsing"
  | "embedding"
  | "ready"
  | "error";

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mime: string;
  owner_user_id: string;
  visibility: DocumentVisibility;
  vendor: string | null;
  domain: string | null;
  product: string | null;
  version: string | null;
  document_type: string | null;
  document_date: string | null;
  status: DocumentStatus;
  error_message: string | null;
  object_storage_key: string;
  created_at: string;
  updated_at: string;
}

export type ChatMode = "auto" | "kb_only" | "model_only" | "web_grounded";

export type ProvenanceTag = "KB" | "GEN" | "WEB";

export interface MessageSegment {
  tag: ProvenanceTag;
  text: string;
  citations: string[];
}

export interface MessageProvenance {
  mode: "model_only" | "kb_only" | "mixed" | "web_grounded";
  rag_used: boolean;
  web_used: boolean;
}

export interface AssistantMessageContent {
  provenance: MessageProvenance;
  segments: MessageSegment[];
}

export interface UserMessageContent {
  text: string;
  attached_snippet_ids?: string[];
}

export interface ChatThread {
  id: string;
  user_id: string;
  title: string | null;
  mode: ChatMode;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content_json: AssistantMessageContent | UserMessageContent | { text: string };
  created_at: string;
}

export type SshAuthType = "password" | "key";

export interface SshCredential {
  id: string;
  user_id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_type: SshAuthType;
  created_at: string;
  updated_at: string;
}

export interface TerminalSession {
  id: string;
  user_id: string;
  credential_id: string | null;
  target: string;
  started_at: string;
  ended_at: string | null;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
  matched: string[];
  read_only: boolean;
  state_changing: boolean;
}

export interface SafeCopyAuditPayload {
  message_id: string;
  risk_level: RiskLevel;
  content_hash: string;
  confirmation: "click" | "typed";
}

export interface AuditEvent {
  id: string;
  user_id: string | null;
  event_type: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface Playbook {
  id: string;
  title: string;
  category: string;
  symptoms: string[];
  questions: string[];
  commands: string[];
  expected_outputs: string[];
  interpretation: string[];
  next_steps: string[];
  escalation_template: string;
}
