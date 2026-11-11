import { needsApproval } from '../approvals.js'
import { buildSystemPrompt, buildTurnPrompt, stripSkip } from '../prompt.js'
import { LOCAL_TOOLS, runLocalTool, summarizeLocalTool } from './localtools.js'
import { callMcpTool, isMcpTool, loadMcpTools } from './mcp.js'
import { emptyUsage, type RunTurnParams, type TurnResult } from './types.js'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string }
}

/**
 * Hides model "thinking" that some providers (MiniMax, DeepSeek uncensored, ...) inline in the
 * content stream as <think>...</think>. The chat only shows the visible answer.
 */
function createThinkingFilter(): { push: (chunk: string) => string; flush: () => string } {
  let buf = ''
  const push = (chunk: string): string => {
    buf += chunk
    let out = ''
    for (;;) {
      const lower = buf.toLowerCase()
      const start = lower.indexOf('<think')
      if (start === -1) {
        const safe = Math.max(0, buf.length - 6)
        out += buf.slice(0, safe)
        buf = buf.slice(safe)
        break
      }
      out += buf.slice(0, start)
      const close = lower.indexOf('</think', start)
      if (close === -1) {
        buf = buf.slice(start)
        break
      }
      const gt = buf.indexOf('>', close)
      if (gt === -1) {
        buf = buf.slice(start)
        break
      }
      buf = buf.slice(gt + 1)
    }
    return out
  }
  const flush = (): string => {
    const i = buf.toLowerCase().indexOf('<think')
    const out = i === -1 ? buf : buf.slice(0, i)
    buf = ''
    return out
  }
  return { push, flush }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Stopped.'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Stopped.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * fetch() with retries for transient network failures and rate limits. The chat endpoint
 * occasionally drops a TLS connection or answers 429/503 under load; without this a whole
 * employee turn fails with "fetch failed". Only safe to retry before the response body is used.
 */
export async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const attempts = 4
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error('Stopped.')
    try {
      const res = await fetch(url, init)
      if (!RETRYABLE_STATUS.has(res.status) || attempt === attempts - 1) return res
      const retryAfter = Number(res.headers.get('retry-after'))
      await res.body?.cancel().catch(() => {})
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : 600 * 2 ** attempt + Math.random() * 300
      console.warn(`[openai] HTTP ${res.status} from ${url}; retry ${attempt + 1}/${attempts - 1} in ${Math.round(wait)}ms`)
      await abortableSleep(wait, signal)
    } catch (err) {
      if (signal.aborted) throw err
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      if (aborted || attempt === attempts - 1) throw err
      const wait = 600 * 2 ** attempt + Math.random() * 300
      console.warn(`[openai] ${err instanceof Error ? err.message : String(err)}; retry ${attempt + 1}/${attempts - 1} in ${Math.round(wait)}ms`)
      await abortableSleep(wait, signal)
    }
  }
}

/**
 * Any OpenAI-compatible chat API (Kimi, OpenRouter, DeepSeek, Groq, xAI, Ollama…). Streams the
 * reply and runs a small tool loop with local file/shell tools when the employee has tools.
 */
export async function runOpenAiTurn(params: RunTurnParams): Promise<TurnResult> {
  const { team, conversation, agent, provider, signal, handlers, note, notes } = params
  const started = Date.now()
  const cwd = agent.cwd ?? team.workspace
  const allowOutside = agent.autoApproveTools || agent.permissionMode === 'bypassPermissions'
  const tools = LOCAL_TOOLS.filter((t) => agent.tools.includes(t.claudeName))
  const mcpTools = await loadMcpTools(team, agent)
  const mcpByName = new Map(mcpTools.map((t) => [t.fnName, t]))
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(team, conversation, agent, '', notes ?? '') },
    { role: 'user', content: buildTurnPrompt(team, conversation, agent, false, note) },
  ]
  const usage = emptyUsage(agent.model)
  usage.numTurns = 0
  let text = ''
  let sawAnyText = false
  let lastCallSignature = ''
  let repeatedCalls = 0
  // Abort a stalled provider stream instead of hanging the whole round forever.
  const requestAbort = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const bumpIdle = (ms = 120_000): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => requestAbort.abort(), ms)
  }
  const stopIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  for (let turn = 0; turn < Math.max(1, team.settings.maxTurnsPerReply); turn++) {
    if (signal.aborted) return { text: text.trim(), error: 'Stopped.', usage }
    usage.numTurns++
    const body: Record<string, unknown> = {
      model: agent.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    const allTools = [
      ...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ...mcpTools.map((t) => ({ name: t.fnName, description: t.description, parameters: t.parameters })),
    ]
    if (allTools.length > 0) body.tools = allTools.map((t) => ({ type: 'function', function: t }))

    let res: Response
    try {
      res = await fetchWithRetry(
        `${provider.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${provider.apiKey ?? 'none'}`,
            'HTTP-Referer': 'https://github.com/Z4YT0N/OpenGrokBot',
            'X-Title': 'OpenGrokBot',
            // OpenCode Go asks clients to identify themselves and send a stable per-conversation session id.
            'user-agent': 'OpenGrokBot/0.3.0',
            'x-opencode-session': conversation.id,
          },
          body: JSON.stringify(body),
        },
        AbortSignal.any([signal, requestAbort.signal]),
      )
    } catch (err) {
      const detail = err instanceof Error ? `${err.message}${err.cause ? ` (${err.cause instanceof Error ? err.cause.message : String(err.cause)})` : ''}` : String(err)
      return { text: text.trim(), error: signal.aborted ? 'Stopped.' : `Could not reach ${provider.baseUrl}: ${detail}`, usage }
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 400)
      return { text: text.trim(), error: `${provider.label} returned HTTP ${res.status}: ${detail}`, usage }
    }

    const calls = new Map<number, ToolCall>()
    let turnText = ''
    let finish: string | null = null
    let streamError: string | undefined
    bumpIdle()
    const think = createThinkingFilter()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        bumpIdle()
        if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload) as StreamChunk
        } catch {
          continue
        }
        if (chunk.error?.message) streamError = chunk.error.message
        if (chunk.usage) {
          usage.inputTokens += chunk.usage.prompt_tokens ?? 0
          usage.outputTokens += chunk.usage.completion_tokens ?? 0
          usage.cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.delta?.content) {
          const visible = think.push(choice.delta.content)
          if (visible) {
            if (!sawAnyText && text.length > 0) {
              text += '\n\n'
              handlers.onDelta('\n\n')
            }
            sawAnyText = true
            turnText += visible
            text += visible
            handlers.onDelta(visible)
          }
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.function.name += tc.function.name
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
          calls.set(tc.index, cur)
        }
        if (choice.finish_reason) finish = choice.finish_reason
        }
      }
    } catch (err) {
      if (signal.aborted) return { text: text.trim(), error: 'Stopped.', usage }
      if (requestAbort.signal.aborted)
        return { text: text.trim(), error: `${provider.label} stalled: no data for 120s. Try again.`, usage }
      return { text: text.trim(), error: `Stream error: ${err instanceof Error ? err.message : String(err)}`, usage }
    } finally {
      stopIdle()
    }
    const tail = think.flush()
    if (tail) {
      if (!sawAnyText && text.length > 0) {
        text += '\n\n'
        handlers.onDelta('\n\n')
      }
      sawAnyText = true
      turnText += tail
      text += tail
      handlers.onDelta(tail)
    }
    if (streamError) return { text: text.trim(), error: streamError, usage }

    if (calls.size === 0 || finish === 'stop') {
      usage.durationMs = Date.now() - started
      return { text: stripSkip(text), usage }
    }

    // Tool round: run every call, feed results back, and let the model continue.
    const toolCalls = [...calls.values()]
    messages.push({ role: 'assistant', content: turnText || null, tool_calls: toolCalls })
    sawAnyText = false
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        args = {}
      }
      const signature = `${call.function.name}:${JSON.stringify(args)}`
      if (signature === lastCallSignature) repeatedCalls++
      else {
        lastCallSignature = signature
        repeatedCalls = 1
      }
      const mcpTool = mcpByName.get(call.function.name)
      handlers.onActivity(mcpTool ? `MCP ${mcpTool.server}: ${mcpTool.tool}` : summarizeLocalTool(call.function.name, args))
      let result: string
      const claudeName = mcpTool
        ? `mcp__${mcpTool.server}`
        : (LOCAL_TOOLS.find((t) => t.name === call.function.name)?.claudeName ?? call.function.name)
      const mustAsk = !agent.autoApproveTools && handlers.onToolPermission !== undefined && needsApproval(agent, claudeName)
      try {
        if (mustAsk && !(await handlers.onToolPermission?.(claudeName, args))) result = 'Denied by the boss. Explain what you wanted to do and stop.'
        else if (isMcpTool(call.function.name)) result = await callMcpTool(call.function.name, args, cwd)
        else result = await runLocalTool(call.function.name, args, cwd, allowOutside, signal)
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`
      }
      if (repeatedCalls >= 3) {
        result =
          `[Note: you already called ${call.function.name} with these exact arguments ${repeatedCalls} times. ` +
          `Do not repeat it. Use this result and either continue differently or answer the boss now.]\n` +
          result
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 60_000) })
    }
  }
  // Tool budget exhausted: ask once more with tools disabled so the employee still answers.
  if (!text.trim()) {
    try {
      messages.push({
        role: 'user',
        content:
          'You have reached the tool step limit. Answer the boss right now using what you already have. ' +
          'Do not call any tools. If something is unfinished, say what remains in one line.',
      })
      const finalRes = await fetchWithRetry(
        `${provider.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${provider.apiKey ?? 'none'}`,
            'HTTP-Referer': 'https://github.com/Z4YT0N/OpenGrokBot',
            'X-Title': 'OpenGrokBot',
            'user-agent': 'OpenGrokBot/0.3.0',
            'x-opencode-session': conversation.id,
          },
          body: JSON.stringify({ model: agent.model, messages, stream: true, stream_options: { include_usage: true } }),
        },
        AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      )
      if (finalRes.ok && finalRes.body) {
        const reader = finalRes.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let finalText = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl = buffer.indexOf('\n')
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            nl = buffer.indexOf('\n')
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            let chunk: StreamChunk
            try {
              chunk = JSON.parse(payload) as StreamChunk
            } catch {
              continue
            }
            if (chunk.usage) {
              usage.inputTokens += chunk.usage.prompt_tokens ?? 0
              usage.outputTokens += chunk.usage.completion_tokens ?? 0
              usage.cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            }
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) {
              finalText += delta
              handlers.onDelta(delta)
            }
          }
        }
        if (finalText.trim()) text = finalText
      }
    } catch {
      /* fall through to the error below */
    }
  }

  usage.durationMs = Date.now() - started
  return { text: stripSkip(text), usage, error: text.trim() ? undefined : 'Ran out of tool steps before answering.' }
}

/** Lists models from an OpenAI-compatible endpoint, for the provider status page. */
export async function listOpenAiModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey ?? 'none'}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { data?: { id?: string }[] }
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort()
}
