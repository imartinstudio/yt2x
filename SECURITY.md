# Security Policy

## Supported Versions

| Version                  | Supported           |
| ------------------------ | ------------------- |
| Latest release on `main` | ✅                  |
| Older tags               | ❌ (please upgrade) |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

1. Prefer [GitHub Private vulnerability reporting](https://github.com/imartinstudio/yt2x/security/advisories/new) if enabled on the repository.
2. Otherwise, open a **private** security advisory or contact the maintainer via GitHub Issues with minimal details and request a private channel.

We aim to acknowledge reports within **7 days** and will coordinate a fix and disclosure timeline.

## Scope

In scope:

- This monorepo's source code, CLI tooling, and published packages built from tagged releases
- Handling of API keys, tokens, and local credentials via `.env` and configuration files
- Data flows between YouTube acquisition, note generation, article writing, and X publishing steps

Out of scope:

- Vulnerabilities in YouTube, X/Twitter, or third-party AI provider platforms themselves
- Issues requiring a compromised machine, leaked `.env` files, or malicious input the operator explicitly supplied

## Security Expectations

- Secrets must not be committed to the repository; use `.env` locally and CI secrets in GitHub Actions.
- The pipeline must not exfiltrate user content, credentials, or API keys to unintended third-party endpoints.
- Dependencies should be kept current via Dependabot and security advisories.
