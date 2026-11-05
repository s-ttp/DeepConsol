## What and why

<!-- What does this PR change, and what problem does it solve? Link issues with "Fixes #123". -->

## How it was tested

<!-- Commands run, environments, before/after output (FAKE values only). -->

## Checklist

- [ ] `npm test` passes locally; new behaviour has tests
- [ ] No real secrets, subscriber data, public IPs or customer names in code, fixtures, commits or this description
- [ ] README / `.env.example` updated if behaviour or configuration changed
- [ ] `ops/` changes: `shellcheck` passes and testing is described above
- [ ] Touches a security boundary (sanitizer, target policy, auth, vault, installer)? → see [CONTRIBUTING.md](https://github.com/s-ttp/DeepConsol/blob/main/CONTRIBUTING.md#areas-that-need-extra-care)
