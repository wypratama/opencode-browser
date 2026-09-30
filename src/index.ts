import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"

interface ConnectionState {
  isConnected: boolean
  lastError?: string
  failureCount: number
}

const BROWSER_TOOL_PREFIX = "browsermcp_"

const browserSpeedGuidance = `When using Browser MCP, optimize for speed:
- Prefer direct URL navigation over click-through flows when the destination is known.
- Reuse the current tab and page state instead of repeating navigation.
- Minimize snapshots, screenshots, and waits; use them only after a page change or when visual confirmation is required.
- Prefer targeted extraction or direct actions over broad inspection.
- Finish the task in the fewest browser actions that still preserve correctness.`

// MCP tools are exposed through Code Mode, and CodeModeCatalog.summarize() renders a catalog
// listing from only the first line of each tool description. The per-tool "Performance:" section
// this plugin appends below that first line therefore never appears in the listing the model
// reads up front; it is only found by searching for the tool. Restating the cost rules as
// instruction text keeps them visible without a lookup.
const browserCatalogGuidance = `Browser MCP tools are exposed through Code Mode, whose catalog listing only shows each tool's first description line, so their performance notes are not visible there. Keep these in mind:
- ${BROWSER_TOOL_PREFIX}browser_navigate: prefer it whenever the destination URL is known instead of clicking through intermediate pages.
- ${BROWSER_TOOL_PREFIX}browser_snapshot: relatively expensive. Reuse the latest snapshot unless the page changed or you need fresh element references.
- ${BROWSER_TOOL_PREFIX}browser_screenshot: use only when the user needs visual confirmation; prefer extraction or targeted checks.
- ${BROWSER_TOOL_PREFIX}browser_wait: use only when content is still loading or an interaction has not settled, and avoid fixed waits when the next action can validate readiness.
- Every other ${BROWSER_TOOL_PREFIX}* tool: make the smallest call that advances the task, and do not repeat calls whose result you already have.`

const browserResumedContext = `## Browser Automation Context

Browser MCP was used in this session. When resuming:
- Assume the current browser tab may still be useful.
- Check browser state once, then reuse it instead of repeating navigation.
- Prefer direct navigation, extraction, and targeted actions over repeated snapshots or screenshots.
- Use waits only when the page is still loading or an interaction has not settled yet.`

const connectionFailedHint =
  "[Browser MCP] The browser connection looks unavailable. Re-enable the Browser MCP extension or browser, then retry. The plugin skips delayed backoff so the next attempt can run immediately."

const connectionRestoredHint = "[Browser MCP] Connection restored. Continuing without extra retry delay."

const stillUnavailableHint =
  "[Browser MCP] That failure is not a connection failure, so the browser connection is still treated as unavailable. Re-check the extension before spending more attempts on it."

const browserToolHints = [
  {
    suffixes: ["_browser_navigate", "_navigate"],
    hint: "Prefer this when you already know the destination URL instead of clicking through intermediate pages.",
  },
  {
    suffixes: ["_browser_snapshot", "_snapshot"],
    hint: "This is relatively expensive. Reuse the latest snapshot unless the page changed or you need fresh element references.",
  },
  {
    suffixes: ["_browser_screenshot", "_screenshot"],
    hint: "Use only when the user needs visual confirmation. Prefer extraction or targeted checks for faster workflows.",
  },
  {
    suffixes: ["_browser_wait", "_wait"],
    hint: "Use only when content is still loading or an interaction has not settled. Avoid fixed waits when the next action can validate readiness.",
  },
] as const

// The first group is what the original V1 plugin matched. The rest cover the transport errors
// @browsermcp/mcp@0.1.3 raises once a tab is connected: the socket has to be OPEN to send
// ("WebSocket is not open"), can fail mid-send ("WebSocket error occurred"), and gives up after
// the 30s default timeout ("WebSocket response timeout after 30000ms"). Without these a dropped
// extension looks like an ordinary tool failure and never reaches the skip-backoff path.
const connectionErrorPatterns = [
  /econnrefused/i,
  /connection refused/i,
  /failed to connect/i,
  /could not connect/i,
  /no connection to (?:the )?browser extension/i,
  /browser\s*mcp.*(?:disconnected|unavailable|not connected)/i,
  /extension.*(?:disabled|disconnected|not connected|unavailable)/i,
  /websocket.*(?:closed|failed)/i,
  /timed out while connecting/i,
  /websocket is not open/i,
  /websocket error occurred/i,
  /websocket response timeout after \d+\s*ms/i,
]

const matchesConnectionPattern = (text: string): boolean => {
  return connectionErrorPatterns.some((pattern) => pattern.test(text))
}

const isBrowserTool = (toolID: string): boolean => toolID.startsWith(BROWSER_TOOL_PREFIX)

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

const appendSection = (base: string, section: string): string => {
  const trimmedSection = section.trim()

  if (!trimmedSection) {
    return base
  }

  if (!base) {
    return trimmedSection
  }

  if (base.includes(trimmedSection)) {
    return base
  }

  return `${base.trimEnd()}\n\n${trimmedSection}`
}

const stringifyOutput = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const getFailureFlag = (value: Record<string, unknown>): boolean => {
  if (value.success === false || value.ok === false) {
    return true
  }

  if (value.isError === true || value.error === true) {
    return true
  }

  return false
}

/** A record that reports its own success is describing a call that ran, not a broken transport. */
const reportsSuccess = (value: Record<string, unknown>): boolean => {
  return value.ok === true || value.success === true
}

const getConnectionErrorText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value
  }

  if (!isRecord(value) || reportsSuccess(value)) {
    return undefined
  }

  if (typeof value.error === "string") {
    return value.error
  }

  if (typeof value.stderr === "string") {
    return value.stderr
  }

  if (!getFailureFlag(value)) {
    return undefined
  }

  for (const field of ["message", "details"] as const) {
    if (typeof value[field] === "string") {
      return value[field]
    }
  }

  return undefined
}

const isConnectionError = (value: unknown): boolean => {
  const errorString = getConnectionErrorText(value)

  if (!errorString) {
    return false
  }

  return matchesConnectionPattern(errorString)
}

/**
 * Completed results carry page text and console logs, so a completed result is only read as a
 * connection failure when it is unmistakably an error report. @browsermcp/mcp@0.1.3 turns a thrown
 * error into an `isError` result, which V2 converts into a Tool.Error, so the only completed shape
 * worth trusting is text that reproduces that `String(error)` serialization, or a record that
 * flags itself as failed.
 */
const isResultConnectionError = (result: { readonly output?: unknown }): boolean => {
  const output = result.output

  if (typeof output === "string") {
    return /^\s*Error\b/.test(output) && matchesConnectionPattern(output)
  }

  if (!isRecord(output) || !getFailureFlag(output)) {
    return false
  }

  const errorString = getConnectionErrorText(output)

  return errorString !== undefined && matchesConnectionPattern(errorString)
}

const getToolHint = (toolID: string): string => {
  for (const { suffixes, hint } of browserToolHints) {
    if (suffixes.some((suffix) => toolID.endsWith(suffix))) {
      return hint
    }
  }

  return "Prefer the smallest action that advances the task, and avoid redundant browser calls when the current page state is already known."
}

const appendSystemSection = (
  system: Array<{ readonly type: "text"; readonly text: string }>,
  section: string,
): void => {
  const last = system.length - 1

  if (last < 0) {
    system.push({ type: "text", text: section })
    return
  }

  const current = system[last]
  if (!current.text.includes(section)) {
    system[last] = { ...current, text: appendSection(current.text, section) }
  }
}

const appendResultSection = (content: unknown, output: unknown, section: string): Array<Record<string, unknown>> => {
  const initial = typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.filter(isRecord)
      : output === undefined
        ? []
        : [{ type: "text", text: stringifyOutput(output) }]

  const next = [...initial]

  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index]
    if (part?.type !== "text" || typeof part.text !== "string") {
      continue
    }

    if (!part.text.includes(section)) {
      next[index] = { ...part, text: appendSection(part.text, section) }
    }

    return next
  }

  next.push({ type: "text", text: section })
  return next
}

const replaceToolErrorMessage = (
  error: ToolError,
  message: string,
): ToolError => {
  return new ToolError({
    ...(error.error === undefined ? {} : { error: error.error }),
    ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
    message,
  })
}

export const BrowserMCPPlugin = Plugin.define({
  id: "opencode-browser-v2",
  async setup(ctx) {
    const browserSessions = new Set<string>()
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const events = new AbortController()

    // @browsermcp/mcp@0.1.3 holds one WebSocket-backed Context per server process, so the socket
    // is shared by every session using this server. Tracking health per session would let one
    // session report "Connection restored" purely because it never saw the failure, so the
    // connection state is process-wide and only the per-session "did we automate a browser" set
    // is keyed by session.
    const connectionState: ConnectionState = {
      isConnected: true,
      failureCount: 0,
    }

    const markConnectionFailed = (error: unknown) => {
      connectionState.isConnected = false
      connectionState.failureCount += 1
      connectionState.lastError = stringifyOutput(error)
    }

    const resetConnectionState = () => {
      connectionState.isConnected = true
      connectionState.failureCount = 0
      connectionState.lastError = undefined
    }

    const connectionHint = (): string => {
      return connectionState.failureCount === 1
        ? connectionFailedHint
        : `[Browser MCP] Browser connection is still unavailable (failure ${connectionState.failureCount}). Retry as soon as the extension is ready.`
    }

    registrations.push(
      await ctx.session.hook("context", async (event) => {
        appendSystemSection(event.system, browserSpeedGuidance)
        appendSystemSection(event.system, browserCatalogGuidance)

        // This hook runs for every request in the session, including the ones after a compaction,
        // so it is what actually carries the browser context across a summary. The compaction
        // hook below only nudges the summarizer; nothing it adds is persisted.
        if (browserSessions.has(event.sessionID)) {
          appendSystemSection(event.system, browserResumedContext)
        }

        // The transform already appends the per-tool hint, but MCP tools can register after a
        // transform replay. This request-level fallback keeps the hint effective either way.
        for (const [toolID, tool] of Object.entries(event.tools)) {
          if (!isBrowserTool(toolID)) {
            continue
          }

          tool.description = appendSection(tool.description, `Performance: ${getToolHint(toolID)}`)
        }
      }),
    )

    registrations.push(
      await ctx.tool.transform((editor) => {
        for (const tool of editor.list()) {
          if (!isBrowserTool(tool.id)) {
            continue
          }

          editor.update(tool.id, (definition) => {
            definition.description = appendSection(
              definition.description,
              `Performance: ${getToolHint(tool.id)}`,
            )
          })
        }
      }),
    )

    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        if (!isBrowserTool(event.tool)) {
          return
        }

        browserSessions.add(event.sessionID)

        if (event.status === "error") {
          if (isConnectionError(event.error.message)) {
            markConnectionFailed(event.error.message)
            Object.assign(event, {
              error: replaceToolErrorMessage(
                event.error,
                appendSection(event.error.message, connectionHint()),
              ),
            })
            return
          }

          // A tool that failed for its own reasons says nothing about the socket, so the
          // connection is not marked restored. Skipping the connection check here would spend a
          // whole 30s timeout on the next call for no reason.
          if (!connectionState.isConnected) {
            Object.assign(event, {
              error: replaceToolErrorMessage(
                event.error,
                appendSection(event.error.message, stillUnavailableHint),
              ),
            })
          }
          return
        }

        if (isResultConnectionError(event.result)) {
          markConnectionFailed({ output: event.result.output })
          Object.assign(event.result, {
            content: appendResultSection(event.result.content, event.result.output, connectionHint()),
          })
          return
        }

        if (!connectionState.isConnected) {
          resetConnectionState()
          Object.assign(event.result, {
            content: appendResultSection(
              event.result.content,
              event.result.output,
              connectionRestoredHint,
            ),
          })
        }
      }),
    )

    registrations.push(
      await ctx.session.hook("compaction", (event) => {
        if (browserSessions.has(event.sessionID)) {
          appendSystemSection(event.system, browserResumedContext)
        }
      }),
    )

    const eventConsumer = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type !== "session.deleted") {
            continue
          }

          browserSessions.delete(event.data.sessionID)
        }
      } catch (error) {
        if (!events.signal.aborted) {
          console.error("[Browser MCP] event subscription stopped", error)
        }
      }
    })()

    return async () => {
      events.abort()
      browserSessions.clear()
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
      // The consumer is deliberately not awaited. It only prunes a set that was just cleared, and
      // it already swallows its own errors, so there is nothing to join for. Awaiting it would
      // make plugin disposal block on the event stream noticing the abort, and editing this file
      // reloads the plugin often enough for a slow stream to pile up reloads behind each other.
      void eventConsumer
    }
  },
})

export default BrowserMCPPlugin
