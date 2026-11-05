# Contributing to DeepConsol

Thanks for your interest in improving DeepConsol. Bug reports, documentation
fixes, new sanitizer rules, vendor playbooks and code are all welcome.

This guide covers how to report problems, set up a development environment,
and get a pull request merged.

- [Ground rules](#ground-rules)
- [Reporting bugs and requesting features](#reporting-bugs-and-requesting-features)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Making changes](#making-changes)
- [Tests and CI](#tests-and-ci)
- [Pull request checklist](#pull-request-checklist)
- [Areas that need extra care](#areas-that-need-extra-care)

---

## Ground rules

1. **Never post real network data.** DeepConsol exists to keep device output,
   credentials and subscriber data away from places they shouldn't be. That
   applies to this repository too. In issues, pull requests, test fixtures and
   screenshots:
   - Don't include real passwords, keys, tokens, SNMP communities or
     configuration secrets.
   - Don't include real IMSI, MSISDN, IMEI, ICCID or other subscriber
     identifiers.
   - Don't include real public IPs, hostnames or customer names.

   Use the app's **Copy Sanitized** action on terminal output before pasting
   it. For examples, use documentation ranges: `192.0.2.0/24`,
   `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`, `example.com`, and
   obviously fake identifiers such as `001010123456789`.
2. **Report security vulnerabilities privately.** Don't open a public issue;
   follow [SECURITY.md](SECURITY.md).
3. **Be respectful.** Assume good intent, keep discussion technical, and be
   patient with people who are new to the project or to the telecom domain.

---

## Reporting bugs and requesting features

Open an issue using one of the templates:

- **Bug report:** something doesn't work as documented.
- **Sanitizer gap:** a secret or identifier that isn't masked, or normal output
  that is wrongly masked. Use **fake values** in the same format.
- **Feature request:** a new capability, vendor or playbook.

Search existing issues first. For questions about installation, check the
[Installation guide](README.md#installation-guide-startup-script) and its
troubleshooting table.

---

## Development setup

You need **Node.js ≥ 20**, **PostgreSQL 15 with `pgvector` and `pg_trgm`**, and
**Redis**. The quickest way to get all of them on a Debian/Ubuntu VM is the
installer (`./ops/bootstrap.sh`, see the README). For day-to-day development
you can then run the services in watch mode instead of through systemd:

```bash
git clone https://github.com/s-ttp/DeepConsol.git
cd DeepConsol
npm install
cp .env.example .env          # point DATABASE_URL / REDIS_URL at your local services,
                              # set JWT_SECRET and SSH_CRED_ENCRYPTION_KEY (openssl rand)
npm run build                 # shared → api → worker → web
npm run migrate               # apply DB migrations
npm run seed                  # create the seed admin, groups and playbooks

npm run dev:api               # API + terminal WebSocket gateway (watch)
npm run dev:worker            # document ingestion worker (watch)
npm run dev:web               # Next.js dev server on http://127.0.0.1:3002 (watch)
```

The AI features need a provider key (Gemini, OpenAI or Anthropic), which you set
in **Admin → LLM Config**. Everything else works without one.

You only need Node.js to run the test suites. No database or Redis is required:

```bash
npm ci
npm test
```

---

## Project layout

| Path | What lives there |
|---|---|
| `packages/shared` | Code used by both browser and server: **sanitizer**, command risk classifier, playbooks, types |
| `apps/api` | Fastify API, terminal WebSocket gateway (SSH/Telnet), auth, DB migrations |
| `apps/worker` | Document ingestion: parse → sanitize → chunk → embed |
| `apps/web` | Next.js UI: workspace and admin console |
| `ops/` | Installer (`bootstrap.sh`), redeploy (`install.sh`), Nginx and systemd templates |

The README describes the architecture, the security model and every
configuration setting.

---

## Making changes

1. **Fork** the repository and create a branch from `main`:
   `fix/<short-name>`, `feat/<short-name>`, `docs/<short-name>`, …
2. **Keep pull requests focused.** One logical change per PR is much easier to
   review.
3. **Code style:**
   - TypeScript in `strict` mode. Validate external input with Zod, and use
     parameterized SQL only (never string-build values into queries).
   - Match the style of the surrounding code. Comments should explain *why*,
     not repeat *what*.
4. **Database changes** go in a new numbered file in
   `apps/api/src/db/migrations/` (e.g. `007_<name>.sql`). Never edit a
   migration that has already been released.
5. **Commit messages:** a short `type(scope): summary` subject line, then a
   body explaining what changed and why. Types used in this repo: `feat`,
   `fix`, `docs`, `ops`, `security`, `chore`, `test`.
   ```
   fix(sanitizer): mask Juniper $9$ secrets

   Junos stores some secrets with reversible $9$ encoding; they were sent
   to the model unmasked. Adds a strip rule and test cases.
   ```
6. **Docs:** if you change behaviour, configuration or installation, update the
   README in the same PR.

---

## Tests and CI

```bash
npm test          # sanitizer suite (packages/shared) + terminal target policy suite (apps/api)
```

Tests use Node's built-in test runner (`node:test`) against the compiled code
in `dist/`, which is the same code the server and browser run. Every pull
request runs [CI](.github/workflows/ci.yml):

| Job | Checks |
|---|---|
| Build & test | `npm ci`, builds all four workspaces (including the Next.js type check), `npm test` |
| Shell scripts | `shellcheck` on `ops/*.sh` |
| Secret scan | `gitleaks` over the full history. Known fake test values are listed in `.gitleaksignore`. |

All jobs must pass before merging.

---

## Pull request checklist

- [ ] The branch is up to date with `main` and the PR does one thing.
- [ ] `npm test` passes locally, and new behaviour has tests.
- [ ] No real secrets, subscriber data, public IPs or customer names are in the
      code, fixtures, commits or PR description.
- [ ] README / `.env.example` are updated if behaviour or configuration
      changed.
- [ ] For `ops/` changes: `shellcheck` passes, and you've described how you
      tested the script (which OS, fresh host or re-run).

---

## Areas that need extra care

These parts of the code are security boundaries. Changes are welcome, but
expect a careful review and include tests.

- **Sanitizer** (`packages/shared/src/sanitizer.ts`).
  - Every built-in rule must have a before/after case in
    `packages/shared/test/sanitizer.test.mjs`; the suite fails if one is
    missing.
  - Add cases for output that must **not** be masked as well.
  - New patterns must be safe from catastrophic backtracking (ReDoS). Test
    them with long adversarial input.
- **Terminal target policy** (`apps/api/src/services/target-policy.ts`).
  - Must never allow loopback, link-local/metadata or the server's own
    addresses.
  - Add tests for any new bypass you guard against.
- **Auth, roles and document visibility** (`apps/api/src/auth/`,
  `services/retrieval.ts`).
  - Access checks belong on the server (SQL or route guards), never only in
    the UI.
- **Credential vault** (`apps/api/src/services/crypto.ts`).
  - Changes must keep existing encrypted rows decryptable, or include a
    migration path.
- **Installer** (`ops/`).
  - Scripts run with `sudo` on people's servers. They must fail fast, be
    safe to re-run, and never print secrets.

Thank you for helping make AI assistance safer for network engineers!
