import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * AES-256-GCM envelope encryption for SSH credential vault.
 *
 * KEK comes from SSH_CRED_ENCRYPTION_KEY (base64-encoded 32 bytes). Each row
 * gets a fresh random 12-byte IV; we store iv, auth_tag, and ciphertext
 * separately as base64. This keeps DB-only attackers from decrypting without
 * the env-resident KEK.
 */

function getKey(): Buffer {
  const raw = config.sshCredEncryptionKey;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `SSH_CRED_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}); generate with: openssl rand -base64 32`
    );
  }
  return buf;
}

export interface EncryptedField {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

export function encrypt(plaintext: string): EncryptedField {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: tag.toString("base64"),
  };
}

export function decrypt(field: EncryptedField): string {
  const key = getKey();
  const iv = Buffer.from(field.iv, "base64");
  const tag = Buffer.from(field.auth_tag, "base64");
  const ciphertext = Buffer.from(field.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
