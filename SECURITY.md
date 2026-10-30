# Security Policy

ReelForge handles private footage and, optionally, AI provider credentials. We take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Include affected version/commit, reproduction steps and impact.

We aim to acknowledge reports within 3 business days and to agree on a disclosure timeline with you.

## Supported versions

ReelForge is pre-alpha. Only the latest `main` receives fixes.

## Security model (current)

- The local API binds to `127.0.0.1` only, requires a per-launch bearer token, and rejects unexpected `Host` (DNS rebinding) and `Origin` headers.
- Project and asset access goes through validated IDs; free-form paths from clients or AI output are not accepted.
- AI output is treated as untrusted data: schema-validated, never executed as shell commands.
- The desktop webview has no filesystem or shell permissions (Tauri capabilities default-deny).
- API keys (from M4) are stored in the OS keychain, never in the project database or exports.
