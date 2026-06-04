import { runMigrations } from "./migrate.js";
import { pool, query, withTx } from "./pool.js";
import { hashPassword } from "../auth/password.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { SEED_PLAYBOOKS } from "@deepconsol/shared/playbooks";

const SEED_GROUPS = [
  { name: "Network Team", description: "End-to-end network operations" },
  { name: "Core Team", description: "EPC / 5GC / IMS core operations" },
  { name: "RAN Team", description: "LTE / 5G NR radio access network" },
  { name: "Transport Team", description: "Backhaul, fronthaul, IP/MPLS, optical" },
  { name: "NOC Team", description: "Network operations center / 24x7 monitoring" },
  { name: "Vendor Support Team", description: "Vendor-side TAC / support engineers" },
];

async function ensureSeedAdmin(): Promise<void> {
  if (!config.seedAdminPassword) {
    logger.warn("SEED_ADMIN_PASSWORD not set — skipping admin seeding");
    return;
  }
  const { rows: existing } = await query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [config.seedAdminEmail.toLowerCase()]
  );
  if (existing[0]) {
    logger.info({ email: config.seedAdminEmail }, "seed admin already exists");
    return;
  }
  const hash = await hashPassword(config.seedAdminPassword);
  await query(
    "INSERT INTO users (email, password_hash, role, must_rotate_password) VALUES ($1,$2,'admin',TRUE)",
    [config.seedAdminEmail.toLowerCase(), hash]
  );
  logger.info({ email: config.seedAdminEmail }, "seed admin created (password rotation required)");
}

async function ensureSeedGroups(): Promise<void> {
  for (const g of SEED_GROUPS) {
    await query(
      "INSERT INTO user_groups (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
      [g.name, g.description]
    );
  }
}

async function ensureSeedPlaybooks(): Promise<void> {
  await withTx(async (client) => {
    for (const p of SEED_PLAYBOOKS) {
      await client.query(
        `INSERT INTO playbooks
            (title, category, symptoms, questions, commands, expected_outputs,
             interpretation, next_steps, escalation_template)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (title) DO UPDATE SET
            category = EXCLUDED.category,
            symptoms = EXCLUDED.symptoms,
            questions = EXCLUDED.questions,
            commands = EXCLUDED.commands,
            expected_outputs = EXCLUDED.expected_outputs,
            interpretation = EXCLUDED.interpretation,
            next_steps = EXCLUDED.next_steps,
            escalation_template = EXCLUDED.escalation_template`,
        [
          p.title,
          p.category,
          JSON.stringify(p.symptoms),
          JSON.stringify(p.questions),
          JSON.stringify(p.commands),
          JSON.stringify(p.expected_outputs),
          JSON.stringify(p.interpretation),
          JSON.stringify(p.next_steps),
          p.escalation_template,
        ]
      );
    }
  });
}

export async function seed(): Promise<void> {
  await runMigrations();
  await ensureSeedGroups();
  await ensureSeedAdmin();
  await ensureSeedPlaybooks();
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed.js");
if (isMain) {
  seed()
    .then(() => {
      logger.info("seed complete");
      return pool.end();
    })
    .catch((err) => {
      logger.error({ err }, "seed failed");
      pool.end();
      process.exit(1);
    });
}
