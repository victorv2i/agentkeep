# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

### Added

- Added `agentkeep demo <vault>` to seed three fictional memory notes for first-run demos.
- Added OSS readiness docs for security and contributing.

### Changed

- Clarified MCP tool descriptions for capture, durable memory, and markdown note listing.
- Replaced brief-related keeper routine claims with the actual routine scope.
- Simplified README intro copy for the readable memory promise.

### Security

- Fixed an RCE class by parsing frontmatter as YAML only, with no JavaScript execution.
- Added cross-process write locking around vault writes.
- Added git-state preflight checks before committing vault mutations.
- Standardized MCP tool errors as structured error results.
- Added vault path and note size guards.
- Added markdown link scheme allowlisting in live preview.
