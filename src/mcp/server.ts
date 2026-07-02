import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createVaultTools, type VaultToolsDeps, type ToolResult } from '../core/vault-tools.js'

/**
 * THIN MCP wiring for the BYO-agent seam (DESIGN §7.5). All tool LOGIC lives in
 * `vault-tools.ts`; this file only adapts those handlers to the stable 1.x MCP
 * SDK: it registers each `createVaultTools(deps)` tool via `registerTool` (the
 * `inputSchema` is the tool's zod raw shape) and translates the handler's
 * `ToolResult` into the SDK's `CallToolResult` — mapping `{ok:false}` to an MCP
 * tool error (`isError:true`). The result keeps the daemon's own seam (CAS +
 * git + agentkeep-agent attribution) intact for any MCP agent.
 *
 * `connectStdio` defaults true (real CLI use); tests pass `false` and drive the
 * server over an in-memory transport, so the suite never touches stdio.
 */
export interface StartMcpServerOpts {
  connectStdio?: boolean
}

export interface RunningMcpServer {
  server: McpServer
  close(): Promise<void>
}

/** Render a handler result as the SDK's CallToolResult (JSON text; isError on failure). */
function toCallResult(r: ToolResult) {
  if (r.ok) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.data) }] }
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: r.error, code: r.code }) }],
  }
}

/**
 * Render an UNEXPECTED thrown error (anything a handler didn't catch and
 * return as `{ok:false}`) the same shape as `toCallResult`'s failure branch.
 * SPEC.md requires every failing tool call to come back as `isError:true` with
 * `{error, code}` — without this, a thrown `GitStateError` (the mutation-time
 * git-safety preflight) or any other unhandled exception would surface as a
 * raw JSON-RPC failure/rejection instead of a structured tool result. Known
 * error shapes (`GitStateError`/`ConflictError`/`VaultPathError`, all of which
 * carry `httpStatus`) keep their status as `code`; anything else has no code.
 */
function toErrorCallResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e)
  const httpStatus = e instanceof Error ? (e as unknown as { httpStatus?: unknown }).httpStatus : undefined
  const code = typeof httpStatus === 'number' ? httpStatus : undefined
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
  }
}

export async function startMcpServer(
  deps: VaultToolsDeps,
  opts: StartMcpServerOpts = {},
): Promise<RunningMcpServer> {
  const { connectStdio = true } = opts
  const server = new McpServer({ name: 'agentkeep', version: '0.1.0' })

  for (const tool of createVaultTools(deps)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return toCallResult(await tool.handler(args ?? {}))
        } catch (e) {
          return toErrorCallResult(e)
        }
      },
    )
  }

  if (connectStdio) {
    await server.connect(new StdioServerTransport())
  }

  return { server, close: () => server.close() }
}
