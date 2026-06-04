import { query } from "../db/pool.js";
import { logger } from "../logger.js";

export type AuditEventType =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.password_rotated"
  | "user.created"
  | "user.updated"
  | "group.created"
  | "group.updated"
  | "group.member_added"
  | "group.member_removed"
  | "ssh_credential.created"
  | "ssh_credential.deleted"
  | "terminal.session_started"
  | "terminal.session_ended"
  | "knowledge.document_uploaded"
  | "knowledge.document_indexed"
  | "knowledge.document_visibility_changed"
  | "knowledge.document_deleted"
  | "rag.query"
  | "chat.message_sent"
  | "chat.message_received"
  | "safe_copy.confirmed"
  | "llm_config.updated"
  | "llm_config.tested"
  | "embedding_config.updated"
  | "embedding_config.tested"
  | "sanitizer_config.builtin_toggled"
  | "sanitizer_config.custom_created"
  | "sanitizer_config.custom_updated"
  | "sanitizer_config.custom_deleted"
  | "admin.action";

export async function audit(
  user_id: string | null,
  event_type: AuditEventType,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await query(
      "INSERT INTO audit_events (user_id, event_type, metadata_json) VALUES ($1, $2, $3)",
      [user_id, event_type, metadata]
    );
  } catch (err) {
    logger.error({ err, event_type }, "audit insert failed");
  }
}
