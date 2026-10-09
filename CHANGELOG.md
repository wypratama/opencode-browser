# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-10-09

### Fixed
- `opencode-browser init` now writes native V2 configuration: the `plugins` array and `mcp.servers.browsermcp` with `disabled`, instead of the V1 `plugin` key and `mcp.browsermcp` with `enabled`.
- `init` now migrates existing V1 keys (`plugin`, `mcp.<name>`, `enabled`) to their V2 form instead of leaving a mixed document behind. OpenCode V2 only runs its V1 migration shim when a document contains a V1-only key, so a config mixing V2 `plugins` with V1 `mcp.<name>` decoded as V2 and silently dropped the MCP server.
- `init` keeps its output in V1 shape when the target document still uses other V1-only keys (`mode`, `tools`, `agent`, `provider`, `permission`, `logLevel`, and others). Writing V2 `plugins` into such a document would make OpenCode decode it as V1 and drop the entry entirely. Documents that are already V2, or that used only the old `plugin` and `mcp.<name>` keys, are upgraded to V2.
- `init` now reads JSONC (line comments, block comments, trailing commas) and targets whichever of `opencode.jsonc` or `opencode.json` already exists, rather than always writing `opencode.json` and leaving a second, lower-priority config beside an existing `.jsonc`.
- `init` no longer overwrites an explicit `disabled` value when re-run.
- README documents the V2 config shape, using `permissions` and `agents` where it previously showed the V1 `tools` and `agent` keys, and uses the correct `github:wypratama/opencode-browser#main` install specifier.

### Added
- `init` warns when rewriting a file drops comments it found.

### Notes
- The `init` CLI was not broken end to end: because it emitted the V1 `plugin` key, OpenCode's V1 migration shim still handled the document. This release removes that dependency and the mixed-config failure mode.

## [2.0.0] - 2026-09-30

### Changed
- **Breaking:** Migrated to the OpenCode V2 plugin API. The plugin is now exported as `Plugin.define({ id, setup })` instead of a bare async function, and the peer dependency moved from `@opencode-ai/plugin` to `@opencode/plugin >=2.0.0`.
- Replaced the V1 hooks `experimental.chat.system.transform`, `tool.definition`, `tool.execute.after`, and `experimental.session.compacting` with `session.hook("context")`, `tool.transform`, `tool.hook("execute.after")`, and `session.hook("compaction")`.
- Added the exact `@browsermcp/mcp@0.1.3` WebSocket failure strings (`WebSocket is not open`, `WebSocket error occurred`, `WebSocket response timeout after 30000ms`) to connection detection. A dropped extension could previously surface as an ordinary tool failure and never reach the skip-backoff path.
- Connection health is now tracked process-wide rather than per session. `@browsermcp/mcp@0.1.3` holds a single WebSocket-backed context per server process, so a failure in one session left other sessions believing the browser was still reachable.
- Browser context now survives compaction through the per-request `context` hook rather than the compaction hook's system text, which OpenCode V2 does not carry into the resumed session.
- Read the V2 `session.deleted` payload as `event.data.sessionID`; V1 exposed a top-level `sessionID`.
- Added a `typecheck` script and TypeScript dev dependencies so the plugin is verified to compile.

### Fixed
- A non-connection tool failure no longer resets connection state or emits a spurious "Connection restored." message.
- Completed tool results are no longer scanned for connection-error text. Page content and console output can contain phrases such as "failed to connect" or "ECONNREFUSED" and were being misread as a dropped browser connection.
- Results reporting `ok: true` or `success: true` are never treated as failures.
- Added a Code Mode note explaining that catalog listings render only each tool's first description line, so the appended `Performance:` guidance is not visible there.

## [1.2.3] - 2026-04-29

### Fixed
- Appended Browser MCP speed guidance to the last existing system message to avoid provider errors from multiple system-role messages

## [1.2.2] - 2026-04-01

### Changed
- Tightened Browser MCP connection post-processing to avoid stringifying large successful tool payloads and to annotate structured error output safely
- Made Browser MCP tool performance hints apply to both `browsermcp_*` and `browsermcp_browser_*` tool IDs
- Pinned the generated Browser MCP server command to `@browsermcp/mcp@0.1.3` and upgraded legacy `@latest` configs when rerunning `opencode-browser init`

### Fixed
- Avoided runtime issues when Browser MCP tools return structured objects instead of string output
- Reduced false-positive Browser MCP disconnect detection from unrelated successful tool payload content

## [1.2.1] - 2026-03-25

### Added
- `opencode-browser init` CLI to create or update `opencode.json` with the required plugin and Browser MCP settings

### Changed
- Shifted the plugin toward faster Browser MCP sessions with system-level speed guidance and tool performance hints
- Removed plugin-side reconnect backoff delays so retries can happen immediately once Browser MCP is available
- Promoted the one-command setup flow in the installation and quickstart docs

## [1.1.0] - 2026-01-08

### Added
- **Automatic reconnection** when browser extension is disabled/enabled
- **Exponential backoff retry logic** for handling connection failures (1s → 2s → 4s → 8s → 16s, up to 30s max)
- **Connection health monitoring** to detect and recover from disconnections automatically
- **Connection state management** to track retry attempts and connection status
- **User notifications** for connection status changes with clear messages
- Smart error detection for various connection issues (timeouts, network errors, disconnections)
- Periodic health checks every 30 seconds when disconnected
- Automatic cleanup of health check resources on session end

### Changed
- Enhanced `tool.execute.before` hook to notify users of reconnection attempts
- Enhanced `tool.execute.after` hook to detect connection errors and trigger automatic retry
- Improved error handling in event hook to detect browser-related errors
- Updated README with comprehensive reconnection feature documentation
- Added reconnection configuration details to README

### Fixed
- No longer requires OpenCode restart when browser extension is toggled on/off
- Automatically recovers from temporary connection losses

## [1.0.2] - 2026-01-05

### Changed
- Improved configuration documentation with clearer setup instructions

### Removed
- Removed obsolete documentation files
- Removed opencode.json from tracking and added to gitignore

### Fixed
- Clarified that both plugin and MCP configuration are required
- Added release status documentation

## [1.0.1] - 2025-12-XX

### Changed
- Updated GitHub repository URLs to michaljach/opencode-browser

### Fixed
- Removed console.log statements to prevent UI pollution

## [1.0.0] - 2025-12-XX

### Added
- Initial release
- Browser MCP integration
- Session context preservation
- Tool execution logging
- Event handling

[1.2.3]: https://github.com/michaljach/opencode-browser/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/michaljach/opencode-browser/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/michaljach/opencode-browser/compare/v1.2.0...v1.2.1
[1.1.0]: https://github.com/michaljach/opencode-browser/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/michaljach/opencode-browser/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/michaljach/opencode-browser/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/michaljach/opencode-browser/releases/tag/v1.0.0
