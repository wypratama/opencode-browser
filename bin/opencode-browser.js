#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

const schemaUrl = "https://opencode.ai/config.json"
const pluginName = "@wypratama/opencode-browser-v2"
const browserMcpServerName = "browsermcp"
const browserMcpVersion = "0.1.3"
const legacyBrowserMcpCommand = ["npx", "-y", "@browsermcp/mcp@latest"]
const defaultBrowserMcpConfig = {
  type: "local",
  command: ["npx", "-y", `@browsermcp/mcp@${browserMcpVersion}`],
  disabled: false,
}

// OpenCode chooses a config dialect per document: if any of these keys is
// present it runs the V1 migration shim, otherwise it decodes as V2. `plugin`
// is excluded because this tool always rewrites it; every other key here can
// outlive that rewrite and keep the document in V1 mode.
const LINGERING_V1_KEYS = new Set([
  "logLevel",
  "server",
  "command",
  "reference",
  "snapshot",
  "autoshare",
  "disabled_providers",
  "enabled_providers",
  "small_model",
  "mode",
  "agent",
  "provider",
  "permission",
  "tools",
  "attachment",
  "layout",
])

function isSameCommand(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
}

function printUsage() {
  console.log(`Usage: opencode-browser [init] [--project|--global|--path <file>] [--print]\n\n` +
    `Examples:\n` +
    `  npx @wypratama/opencode-browser-v2 init\n` +
    `  npx @wypratama/opencode-browser-v2 init --global\n` +
    `  npx @wypratama/opencode-browser-v2 init --path ./opencode.json\n` +
    `  npx @wypratama/opencode-browser-v2 init --print`)
}

function parseArgs(argv) {
  const args = [...argv]
  let command = "init"

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift()
  }

  const options = {
    mode: "project",
    configPath: undefined,
    printOnly: false,
  }

  while (args.length > 0) {
    const arg = args.shift()

    if (arg === "--global") {
      options.mode = "global"
      continue
    }

    if (arg === "--project") {
      options.mode = "project"
      continue
    }

    if (arg === "--path") {
      const customPath = args.shift()

      if (!customPath) {
        throw new Error("Missing value for --path")
      }

      options.configPath = customPath
      continue
    }

    if (arg === "--print") {
      options.printOnly = true
      continue
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { command, options }
}

// OpenCode config files are JSONC: `//` line comments, `/* */` block comments,
// and trailing commas are all accepted. Strip comments first (reporting whether
// any were present, so the caller can warn that a rewrite will not keep them),
// then drop trailing commas, then hand the result to JSON.parse.
function stripJsonComments(text) {
  let output = ""
  let hadComment = false
  let index = 0

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '"') {
      output += char
      index += 1

      while (index < text.length) {
        const current = text[index]
        output += current
        index += 1

        if (current === "\\") {
          if (index < text.length) {
            output += text[index]
            index += 1
          }
          continue
        }

        if (current === '"') {
          break
        }
      }

      continue
    }

    if (char === "/" && next === "/") {
      hadComment = true
      index += 2

      while (index < text.length && text[index] !== "\n") {
        index += 1
      }

      continue
    }

    if (char === "/" && next === "*") {
      hadComment = true
      index += 2

      while (index + 1 < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1
      }

      index += 2
      continue
    }

    output += char
    index += 1
  }

  return { text: output, hadComment }
}

function stripTrailingCommas(text) {
  let output = ""
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === '"') {
      output += char
      index += 1

      while (index < text.length) {
        const current = text[index]
        output += current
        index += 1

        if (current === "\\") {
          if (index < text.length) {
            output += text[index]
            index += 1
          }
          continue
        }

        if (current === '"') {
          break
        }
      }

      continue
    }

    if (char === ",") {
      let lookahead = index + 1

      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1
      }

      if (text[lookahead] === "}" || text[lookahead] === "]") {
        index += 1
        continue
      }
    }

    output += char
    index += 1
  }

  return output
}

function loadConfig(targetPath) {
  if (!existsSync(targetPath)) {
    return { config: {}, hadComment: false }
  }

  const raw = readFileSync(targetPath, "utf8")

  if (raw.trim() === "") {
    return { config: {}, hadComment: false }
  }

  let value
  let hadComment

  try {
    const stripped = stripJsonComments(raw)
    hadComment = stripped.hadComment
    value = JSON.parse(stripTrailingCommas(stripped.text))
  } catch (error) {
    throw new Error(`Unable to parse ${targetPath}: ${error.message}`)
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unable to parse ${targetPath}: config must be a JSON object`)
  }

  return { config: value, hadComment }
}

function normalizePlugins(value) {
  if (value === undefined) {
    return []
  }

  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value) && value.every((entry) =>
    typeof entry === "string" || (entry !== null && typeof entry === "object" && !Array.isArray(entry)))) {
    return [...value]
  }

  throw new Error('The "plugins" field must be a string or an array of plugin entries')
}

function ensureObject(value, fieldName) {
  if (value === undefined) {
    return {}
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The "${fieldName}" field must be an object`)
  }

  return { ...value }
}

// OpenCode V2 still reads V1-shaped config through a migration shim, but that
// shim only activates when the document contains a V1-only key. A document that
// mixes V2 `plugins` with V1 `mcp.<name>` decodes as V2, where `mcp.<name>` is an
// unknown property and is dropped without warning. Normalize V1 keys we find so
// the file we write is unambiguously V2.
function migrateLegacyConfig(config, changes) {
  if (config.plugin !== undefined) {
    const legacy = normalizePlugins(config.plugin)
    const current = normalizePlugins(config.plugins)

    for (const entry of legacy) {
      if (!current.includes(entry)) {
        current.push(entry)
      }
    }

    config.plugins = current
    delete config.plugin
    changes.push('migrated V1 "plugin" to V2 "plugins"')
  }

  const mcp = config.mcp

  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const legacyServers = Object.entries(mcp).filter(([key]) => key !== "servers" && key !== "timeout")

    if (legacyServers.length > 0) {
      const servers = ensureObject(mcp.servers, "mcp.servers")

      for (const [name, server] of legacyServers) {
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          continue
        }

        const migrated = { ...server }

        if (migrated.enabled !== undefined) {
          if (migrated.disabled === undefined) {
            migrated.disabled = migrated.enabled === false
          }
          delete migrated.enabled
        }

        servers[name] = { ...migrated, ...(servers[name] ?? {}) }
        delete mcp[name]
      }

      mcp.servers = servers
      changes.push('migrated V1 MCP servers to V2 "mcp.servers"')
    }
  }
}

function isLegacyDocument(config) {
  return Object.keys(config).some((key) => LINGERING_V1_KEYS.has(key))
}

// Convert the merged V2 output back to V1 shape. Used only when the document
// still carries other V1-only keys, in which case OpenCode would decode it as
// V1 and drop the V2 `plugins` and `mcp.servers` keys we just wrote.
function toLegacyConfig(config, changes) {
  const nextConfig = { ...config }

  const plugins = normalizePlugins(nextConfig.plugins)
  delete nextConfig.plugins
  if (plugins.length > 0) {
    nextConfig.plugin = plugins
  }

  const mcp = ensureObject(nextConfig.mcp, "mcp")
  const servers = ensureObject(mcp.servers, "mcp.servers")

  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      continue
    }

    const converted = { ...server }

    if (converted.disabled !== undefined) {
      converted.enabled = converted.disabled === false
      delete converted.disabled
    }

    mcp[name] = converted
  }

  delete mcp.servers

  if (mcp.timeout !== undefined) {
    const experimental = ensureObject(nextConfig.experimental, "experimental")
    if (experimental.mcp_timeout === undefined) {
      experimental.mcp_timeout = mcp.timeout
    }
    delete mcp.timeout
    nextConfig.experimental = experimental
  }

  if (Object.keys(mcp).length > 0) {
    nextConfig.mcp = mcp
  } else {
    delete nextConfig.mcp
  }

  changes.push("kept V1 config shape because other V1 keys are present")

  return nextConfig
}

function mergeConfig(config) {
  const nextConfig = { ...config }
  const changes = []
  const legacy = isLegacyDocument(config)

  migrateLegacyConfig(nextConfig, changes)

  if (!nextConfig.$schema) {
    nextConfig.$schema = schemaUrl
    changes.push("added OpenCode schema")
  }

  const plugins = normalizePlugins(nextConfig.plugins)

  if (!plugins.includes(pluginName)) {
    plugins.push(pluginName)
    changes.push("enabled opencode-browser plugin")
  }

  nextConfig.plugins = plugins

  const mcp = ensureObject(nextConfig.mcp, "mcp")
  const servers = ensureObject(mcp.servers, "mcp.servers")
  const browsermcp = ensureObject(servers[browserMcpServerName], `mcp.servers.${browserMcpServerName}`)

  if (browsermcp.type === undefined) {
    browsermcp.type = defaultBrowserMcpConfig.type
    changes.push("set Browser MCP type")
  }

  if (browsermcp.command === undefined) {
    browsermcp.command = [...defaultBrowserMcpConfig.command]
    changes.push("set Browser MCP command")
  } else if (isSameCommand(browsermcp.command, legacyBrowserMcpCommand)) {
    browsermcp.command = [...defaultBrowserMcpConfig.command]
    changes.push("pinned Browser MCP command version")
  }

  if (browsermcp.disabled === undefined) {
    browsermcp.disabled = defaultBrowserMcpConfig.disabled
    changes.push("enabled Browser MCP server")
  }

  servers[browserMcpServerName] = browsermcp
  mcp.servers = servers
  nextConfig.mcp = mcp

  if (legacy) {
    return { nextConfig: toLegacyConfig(nextConfig, changes), changes }
  }

  return { nextConfig, changes }
}

function getTargetPath(mode, customPath) {
  if (customPath) {
    return resolve(customPath)
  }

  const directory = mode === "global" ? resolve(homedir(), ".config/opencode") : process.cwd()

  // OpenCode reads both files, so target whichever already exists rather than
  // creating a second, lower-priority config beside it.
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = resolve(directory, name)

    if (existsSync(candidate)) {
      return candidate
    }
  }

  return resolve(directory, "opencode.json")
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2))

    if (options.help) {
      printUsage()
      return
    }

    if (command !== "init") {
      throw new Error(`Unknown command: ${command}`)
    }

    const targetPath = getTargetPath(options.mode, options.configPath)
    const hadExistingConfig = existsSync(targetPath)
    const { config, hadComment } = loadConfig(targetPath)
    const { nextConfig, changes } = mergeConfig(config)
    const output = `${JSON.stringify(nextConfig, null, 2)}\n`

    if (options.printOnly) {
      process.stdout.write(output)
      return
    }

    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, output)

    const action = hadExistingConfig ? "Updated" : "Created"
    console.log(`${action} ${targetPath}`)

    if (hadComment) {
      console.log("Note: comments are not preserved when this tool rewrites the file.")
    }

    if (changes.length === 0) {
      console.log("No changes were needed; Browser MCP is already configured.")
      return
    }

    console.log(`Applied ${changes.length} change${changes.length === 1 ? "" : "s"}:`)
    for (const change of changes) {
      console.log(`- ${change}`)
    }
  } catch (error) {
    console.error(`[opencode-browser] ${error.message}`)
    printUsage()
    process.exitCode = 1
  }
}

await main()
