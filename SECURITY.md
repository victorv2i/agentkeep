# Security

Agentkeep is a local, single-user app.

There is no login or auth wall by design. Run it on `localhost` or a private tailnet only. Do not expose the web port to untrusted networks. Anyone who can reach the running web app can read and write the active vault.

The vault is your filesystem data. Protect it with normal OS permissions, disk backups, and git hygiene.

## Reporting

Please report vulnerabilities through GitHub Security Advisories for this repository.

## Current Guards

- YAML frontmatter is parsed as YAML only, with no JavaScript execution.
- Rendered markdown links allow only safe schemes. Other schemes are made inert.
- Vault writes use path guards, size limits, atomic writes, cross-process locking, and git commits.
