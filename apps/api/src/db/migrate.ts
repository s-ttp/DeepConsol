import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "./pool.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadMigrations(): Promise<{ version: string; sql: string }[]> {
  const dir = path.join(__dirname, "migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: { version: string; sql: string }[] = [];
  for (const f of files) {
    const sql = await fs.readFile(path.join(dir, f), "utf-8");
    migrations.push({ version: f.replace(/\.sql$/, ""), sql });
  }
  return migrations;
}

export async function runMigrations(): Promise<void> {
  const migrations = await loadMigrations();
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows: applied } = await query<{ version: string }>(
    "SELECT version FROM schema_migrations"
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  for (const m of migrations) {
    if (appliedSet.has(m.version)) {
      logger.info({ version: m.version }, "migration already applied; skipping");
      continue;
    }
    logger.info({ version: m.version }, "applying migration");
    await query("BEGIN");
    try {
      await query(m.sql);
      await query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [m.version]);
      await query("COMMIT");
      logger.info({ version: m.version }, "migration applied");
    } catch (err) {
      await query("ROLLBACK");
      logger.error({ err, version: m.version }, "migration failed");
      throw err;
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.js");
if (isMain) {
  runMigrations()
    .then(() => {
      logger.info("migrations complete");
      return pool.end();
    })
    .catch((err) => {
      logger.error({ err }, "migrations failed");
      pool.end();
      process.exit(1);
    });
}
