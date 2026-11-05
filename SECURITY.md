# Security Policy

DeepConsol handles network device credentials and output from production
networks, so security reports are taken seriously. Thank you for helping keep
its users safe.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security
problem.**

Report it privately through GitHub:

1. Go to the repository's **Security** tab →
   **[Report a vulnerability](https://github.com/s-ttp/DeepConsol/security/advisories/new)**.
2. Describe the issue, the affected component and version/commit, and the steps
   to reproduce it. A proof of concept helps, but **use test systems and fake
   data only**. Never include real credentials, device output or subscriber
   identifiers.

What to expect (best effort; this is a small project):

- **Acknowledgement:** within about a week.
- **Assessment:** whether we consider it a vulnerability, and how severe.
- **Fix:** developed in a private fork where possible, then released on
  `main` with a GitHub Security Advisory. You'll be credited unless you prefer
  not to be.
- **Disclosure:** please give us a reasonable chance to release a fix before
  publishing details. We aim for no more than 90 days.

## Supported versions

DeepConsol is pre-1.0 and has no release branches. Security fixes go to
**`main` only**. Run a recent `main` and update with:

```bash
git pull && ./ops/install.sh
```

## Scope

**In scope**, for example:

| Area | Examples |
|---|---|
| Sanitizer | Secrets or subscriber/network identifiers reaching the AI provider, chat history or the knowledge base unmasked, in a format the built-in rules claim to cover; anything that bypasses the server-side pass |
| Terminal gateway | Reaching targets the [terminal target policy](README.md#terminal-target-policy) should block (loopback, metadata, the server's own addresses, denied ranges); session hijacking; accessing another user's sessions or credentials |
| Auth and access control | Privilege escalation to admin; reading documents, chats or credentials you're not entitled to; authentication bypass |
| Secrets at rest | Recovering SSH credentials or API keys without the vault key; secrets returned to the browser or written to logs |
| Web | XSS, CSRF, injection (SQL, command, header) |
| Installer (`ops/`) | Scripts that expose secrets, create insecure permissions, or open services to the network |

**Not treated as vulnerabilities:** these are already documented in the
README's [Known limitations](README.md#known-limitations). Improvements are
still welcome as normal issues and PRs.

- Hardening items listed there: no SSH host-key verification; login tokens
  that can't be revoked before expiry; first-login password change enforced
  only in the UI; no login rate limiting.
- Sanitizer formats the README lists as **not** covered by built-in rules
  (Cisco type 0/8/9, TACACS/RADIUS/ISAKMP keys, SNMPv3, Juniper `$9$`). Report
  these with the *Sanitizer gap* issue template. Masking that's too aggressive
  (over-masking) also isn't a security issue.
- Findings that need an already-compromised server, `.env` or admin account.
- The self-signed TLS certificate that the installer creates by default.
- Reports from automated scanners without a demonstrated impact.

## Hardening your deployment

See the README's [Security & privacy features](README.md#security--privacy-features)
and [Known limitations](README.md#known-limitations). In particular:

- Set `TERMINAL_ALLOWED_CIDRS` to your device management networks.
- Replace the self-signed certificate with a real one.
- Keep `.env` (mode 600) and database backups together and protected. The
  vault key in `.env` decrypts every stored credential.
