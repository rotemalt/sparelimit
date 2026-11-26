# Security

Sparelimit reads the session logs your coding agent writes and runs entirely on your machine. It sends nothing anywhere.

## Reporting a vulnerability

Please report it privately through GitHub's **Report a vulnerability** button on the repository's Security tab
(Security → Advisories → Report a vulnerability). Do not open a public issue for it.

Include what you did, what you expected and what happened, and the version (`git rev-parse --short HEAD`). Please do not attach
session logs: they contain your prompts. If a log is needed to reproduce, say so and we will work out a safe way to share a redacted one.

## What is in scope

- The local dashboard (`sparelimit serve`): it must listen on the loopback address only, accept only POST for actions, and check the Host and
  Origin of every request.
- Anything that lets text from a session (prompts, command output, file paths) leave the machine, or reach a status file, an export or a
  handoff without the redaction described in the README.
- The hooks and status line `sparelimit init --apply` installs into `~/.claude/settings.json`.
- Reading the Claude Desktop app's plan-usage file: Sparelimit only reads it and drops the organisation id.

## What Sparelimit does not promise

The secret scanner hides the shapes of well-known credentials. A secret with no known shape, such as a plain password in a sentence, is
not found. This is stated on the methodology page.
