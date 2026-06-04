import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { config } from "../config.js";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RotateBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10).max(200),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: "engineer" | "admin";
  must_rotate_password: boolean;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const { rows } = await query<UserRow>(
      "SELECT id, email, password_hash, role, must_rotate_password FROM users WHERE email = $1",
      [body.email.toLowerCase()]
    );
    const user = rows[0];
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !ok) {
      await audit(user?.id ?? null, "auth.login_failed", { email: body.email });
      reply.code(401).send({ error: "invalid_credentials" });
      return;
    }
    const token = signSession({
      sub: user.id,
      email: user.email,
      role: user.role,
      must_rotate: user.must_rotate_password,
    });
    reply.setCookie(config.sessionCookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: config.jwtTtlHours * 3600,
    });
    await audit(user.id, "auth.login", {});
    reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        must_rotate_password: user.must_rotate_password,
      },
    });
  });

  app.post("/auth/logout", async (req, reply) => {
    reply.clearCookie(config.sessionCookieName, { path: "/" });
    if (req.user?.sub) await audit(req.user.sub, "auth.logout", {});
    reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.user) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    const { rows } = await query<UserRow>(
      "SELECT id, email, role, must_rotate_password, password_hash FROM users WHERE id = $1",
      [req.user.sub]
    );
    const user = rows[0];
    if (!user) {
      reply.code(404).send({ error: "user_not_found" });
      return;
    }
    reply.send({
      id: user.id,
      email: user.email,
      role: user.role,
      must_rotate_password: user.must_rotate_password,
      group_ids: req.user.group_ids,
    });
  });

  app.post("/auth/rotate-password", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.user) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    const body = RotateBody.parse(req.body);
    const { rows } = await query<UserRow>(
      "SELECT id, email, password_hash, role, must_rotate_password FROM users WHERE id = $1",
      [req.user.sub]
    );
    const user = rows[0];
    if (!user) {
      reply.code(404).send({ error: "user_not_found" });
      return;
    }
    const ok = await verifyPassword(body.current_password, user.password_hash);
    if (!ok) {
      reply.code(401).send({ error: "invalid_current_password" });
      return;
    }
    const newHash = await hashPassword(body.new_password);
    await query(
      "UPDATE users SET password_hash = $1, must_rotate_password = FALSE, updated_at = NOW() WHERE id = $2",
      [newHash, user.id]
    );
    await audit(user.id, "auth.password_rotated", {});
    const token = signSession({
      sub: user.id,
      email: user.email,
      role: user.role,
      must_rotate: false,
    });
    reply.setCookie(config.sessionCookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: config.jwtTtlHours * 3600,
    });
    reply.send({ ok: true, token });
  });
}
