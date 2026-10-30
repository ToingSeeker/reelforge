# Security Policy

ReelForge handles private footage and, optionally, AI provider credentials. We take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Include affected version/commit, reproduction steps and impact.

We aim to acknowledge reports within 3 business days and to agree on a disclosure timeline with you.

## Supported versions

ReelForge is alpha. Only the latest `main` receives fixes.

## Security model (current)

- The local API binds to `127.0.0.1` only, requires a per-launch bearer token (handed to the engine over a pipe, not
  the environment), and rejects unexpected `Host` (DNS rebinding) and `Origin` headers.
- **File paths.** Everything that holds the token, and the MCP client, acts for you: it may import any media file
  you can read (by path) and export to a new `.mp4` anywhere you can write. Imports accept only regular files with a
  media extension, opened with a forced demuxer and local files only; exports never overwrite and are published
  atomically. A model's *output* never supplies paths: it can only propose timeline operations.
- **MCP clients may be prompt-injected** (by a transcript, a file name, a web page). They can read and propose, but
  every timeline change, undo, and workflow that changes the timeline or searches your folders with a glob needs your
  approval (MCP elicitation, Apply in ReelForge, or `--yes`). Proposals they ask for are labelled as theirs.
- AI output is treated as untrusted data: schema-validated and dry-run, never executed as shell commands.
- The desktop webview has no filesystem or shell permissions (Tauri capabilities: only event listening and native
  open/save dialogs) and a CSP without inline scripts.
- API keys are stored in the OS keychain and handed to the engine in memory, never written to the project database,
  logs or exports. Project context goes to an external AI provider (Claude, or Ollama on another machine) only after
  per-project consent.
