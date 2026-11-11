import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Agent, McpServerDef, Team } from '../../shared/types.js'

export interface McpToolDef {
  fnName: string
  server: string
  tool: string
  description: string
  parameters: Record<string, unknown>
}

interface Entry {
  client: any
  tools: { name: string; description: string; inputSchema: unknown }[]
}

const cache = new Map<string, Promise<Entry>>()
const index = new Map<string, { server: string; tool: string; entry: Promise<Entry> }>()
const activeClients = new Set<any>()

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function keyFor(name: string, def: McpServerDef): string {
  return `${name}::${JSON.stringify(def)}`
}

async function connect(name: string, def: McpServerDef): Promise<Entry> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'OpenGrokBot', version: '0.3.0' })

  if (def.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const env = { ...(process.env as Record<string, string>), ...(def.env ?? {}) } as Record<string, string>
    // On Windows, spawn() cannot run .cmd shims (npx, uvx, ...) directly; go through cmd.exe for those.
    const needsShell = process.platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(def.command)
    const command = needsShell ? process.env.ComSpec || 'cmd.exe' : def.command
    const args = needsShell ? ['/c', def.command, ...(def.args ?? [])] : (def.args ?? [])
    const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' })
    await withTimeout(client.connect(transport), 20_000, `MCP ${name} connect`)
  } else if (def.type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    const transport = new SSEClientTransport(new URL(def.url), def.headers ? { requestInit: { headers: def.headers } } : undefined)
    await withTimeout(client.connect(transport), 20_000, `MCP ${name} connect`)
  } else {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const transport = new StreamableHTTPClientTransport(new URL(def.url), def.headers ? { requestInit: { headers: def.headers } } : undefined)
    await withTimeout(client.connect(transport), 20_000, `MCP ${name} connect`)
  }

  activeClients.add(client)
  const listed: any = await withTimeout(client.listTools(), 15_000, `MCP ${name} listTools`)
  const tools = (listed?.tools ?? []).map((t: any) => ({
    name: String(t.name ?? ''),
    description: String(t.description ?? ''),
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }))
  return { client, tools }
}

/** Connect to the MCP servers enabled for this employee and expose their tools as function calls. */
export async function loadMcpTools(team: Team, agent: Agent): Promise<McpToolDef[]> {
  const out: McpToolDef[] = []
  for (const name of agent.mcpServers) {
    const def = team.mcpServers[name]
    if (!def) continue
    const key = keyFor(name, def)
    let entryP = cache.get(key)
    if (!entryP) {
      entryP = connect(name, def).catch((err: unknown) => {
        cache.delete(key)
        console.warn(`[mcp] ${name}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      })
      cache.set(key, entryP)
    }
    let entry: Entry
    try {
      entry = await entryP
    } catch {
      continue
    }
    for (const t of entry.tools) {
      const base = `mcp__${name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
      let fnName = base
      let n = 1
      while (index.has(fnName)) fnName = `${base.slice(0, 56)}_${n++}`
      index.set(fnName, { server: name, tool: t.name, entry: entryP })
      out.push({
        fnName,
        server: name,
        tool: t.name,
        description: t.description || `${t.name} (MCP server: ${name})`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      })
    }
  }
  return out
}

export function isMcpTool(fnName: string): boolean {
  return fnName.startsWith('mcp__') && index.has(fnName)
}

export async function callMcpTool(fnName: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  const hit = index.get(fnName)
  if (!hit) return `Error: unknown MCP tool ${fnName}`
  let entry: Entry
  try {
    entry = await hit.entry
  } catch (err) {
    return `Error: MCP server ${hit.server} is not available: ${err instanceof Error ? err.message : String(err)}`
  }
  let res: any
  try {
    res = await entry.client.callTool({ name: hit.tool, arguments: args }, undefined, { timeout: 120_000, resetTimeoutOnProgress: true })
  } catch (err) {
    return `Error: MCP call failed: ${err instanceof Error ? err.message : String(err)}`
  }
  const parts: string[] = []
  for (const c of res?.content ?? []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''))
    else if (c?.type === 'image' && c.data) {
      const rel = path.join('.mcp-images', `${Date.now()}-${parts.length}.png`)
      const abs = path.resolve(cwd, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, Buffer.from(String(c.data), 'base64'))
      parts.push(`[image saved: ${rel}]`)
    } else if (c?.type === 'resource') parts.push(String(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`))
    else if (c?.type === 'resource_link') parts.push(`[link ${c.uri ?? ''}${c.name ? ` ${c.name}` : ''}]`)
    else parts.push(`[${c?.type ?? 'content'}]`)
  }
  let text = parts.join('\n').trim()
  if (!text) text = JSON.stringify(res ?? {}).slice(0, 4000)
  if (res?.isError) text = `Error: ${text}`
  return text.slice(0, 60_000)
}

process.once('beforeExit', () => {
  for (const client of activeClients) {
    try {
      void client.close().catch(() => {})
    } catch {
      /* ignore */
    }
  }
  activeClients.clear()
  cache.clear()
  index.clear()
})
