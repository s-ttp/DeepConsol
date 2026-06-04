import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import { ZodError } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { installProxyDispatcher } from "./proxy.js";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { groupRoutes } from "./routes/groups.js";
import { sshCredentialRoutes } from "./routes/ssh-credentials.js";
import { terminalRoutes } from "./routes/terminal.js";
import { chatRoutes } from "./routes/chat.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { llmConfigRoutes } from "./routes/llm-config.js";
import { embeddingConfigRoutes } from "./routes/embedding-config.js";
import { sanitizerConfigRoutes } from "./routes/sanitizer-config.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { safeCopyRoutes } from "./routes/safe-copy.js";
import { registerTerminalGateway } from "./ws/terminal-gateway.js";

async function buildApiServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loggerInstance: logger as any,
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsAllowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: "validation_failed", details: err.flatten() });
      return;
    }
    logger.error({ err }, "request failed");
    const e = err as { statusCode?: number; code?: string; message?: string };
    reply.code(e.statusCode ?? 500).send({
      error: e.code ?? "internal_error",
      message: e.message ?? "Unknown error",
    });
  });

  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(groupRoutes);
  await app.register(sshCredentialRoutes);
  await app.register(terminalRoutes);
  await app.register(chatRoutes);
  await app.register(knowledgeRoutes);
  await app.register(llmConfigRoutes);
  await app.register(embeddingConfigRoutes);
  await app.register(sanitizerConfigRoutes);
  await app.register(playbookRoutes);
  await app.register(safeCopyRoutes);
  return app;
}

async function buildTerminalServer(): Promise<FastifyInstance> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = Fastify({ loggerInstance: logger as any, trustProxy: true });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });
  await registerTerminalGateway(app);
  app.get("/health", async () => ({ ok: true, role: "terminal-gateway" }));
  return app;
}

async function main(): Promise<void> {
  installProxyDispatcher();
  await runMigrations();

  // Sweep stale sessions on startup. Any row with `ended_at IS NULL` at this
  // point is necessarily orphaned — no WS gateway from the previous process
  // could possibly survive a restart, but the UPDATE that records ended_at
  // only fires from the gateway's WS-close handler. Without this sweep,
  // orphaned rows accumulate and eventually trip the per-user session cap
  // (TERMINAL_MAX_SESSIONS_PER_USER), causing "Failed to start session" 429s.
  const sweep = await pool.query(
    "UPDATE terminal_sessions SET ended_at = NOW() WHERE ended_at IS NULL RETURNING id"
  );
  if (sweep.rowCount && sweep.rowCount > 0) {
    logger.info({ closed: sweep.rowCount }, "swept stale terminal sessions on startup");
  }

  const apiApp = await buildApiServer();
  await apiApp.listen({ host: config.apiHost, port: config.apiPort });
  logger.info({ host: config.apiHost, port: config.apiPort }, "API listening");

  const termApp = await buildTerminalServer();
  await termApp.listen({ host: config.terminalWsHost, port: config.terminalWsPort });
  logger.info({ host: config.terminalWsHost, port: config.terminalWsPort }, "Terminal WS gateway listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await apiApp.close();
      await termApp.close();
      await pool.end();
    } catch (err) {
      logger.error({ err }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
