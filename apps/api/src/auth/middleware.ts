import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { verifySession, type SessionClaims } from "./jwt.js";
import { query } from "../db/pool.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionClaims & { group_ids: string[] };
  }
}

function readToken(req: FastifyRequest): string | null {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[config.sessionCookieName];
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  const qs = req.query as Record<string, string> | undefined;
  if (qs?.token) return qs.token;
  return null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readToken(req);
  if (!token) {
    reply.code(401).send({ error: "unauthenticated" });
    return reply;
  }
  let claims: SessionClaims;
  try {
    claims = verifySession(token);
  } catch {
    reply.code(401).send({ error: "invalid_session" });
    return reply;
  }
  const { rows } = await query<{ group_id: string }>(
    "SELECT group_id FROM user_group_memberships WHERE user_id = $1",
    [claims.sub]
  );
  req.user = { ...claims, group_ids: rows.map((r) => r.group_id) };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== "admin") {
    reply.code(403).send({ error: "forbidden" });
    return reply;
  }
}

export async function requireRotated(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.must_rotate) {
    reply.code(403).send({ error: "password_rotation_required" });
    return reply;
  }
}
