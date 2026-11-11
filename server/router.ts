import { query } from '@anthropic-ai/claude-agent-sdk'
import { capability } from './prompt.js'
import type { Agent, Conversation, ProviderDef, Team } from '../shared/types.js'

export type RouteMode = 'build' | 'answer' | 'discuss'

export interface Route {
  speakers: Agent[]
  mode: RouteMode
  /** Why the router chose them; shown nowhere yet, useful in logs. */
  why: string
}

const ROUTER_MODEL = 'claude-haiku-4-5'
/** Cheap models tried first for the OpenAI-compatible router, in order. */
const PREFERRED_ROUTER_MODELS = [
  'z-ai-glm-5-3-flash',
  'glm-5.3-flash',
  'glm-5-3-flash',
  'qwen-3-8-flash',
  'qwen3.8-flash',
  'claude-haiku-5-5',
  'gemini-3-8-flash',
  'gemini-3-5-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-1-flash',
  'kimi-k2.7-code',
  'kimi-k2-7-code',
]

function memberLines(team: Team, members: Agent[]): string {
  return members
    .map(
      (a) =>
        `- id=${a.id} → ${a.name} (${a.role}) → ${capability(a)}${a.scope ? ` → owns: ${a.scope}` : ''}${a.muted ? ' → muted (only if clearly for them)' : ''}`,
    )
    .join('\n')
}

function systemPrompt(team: Team, members: Agent[]): string {
  const manager = members[0]
  return `You are the dispatcher of ${team.company}'s group chat. The boss (${team.owner.name}) just posted. Decide which employees should respond, and reply with JSON only:
{"speakers":["id", ...],"mode":"build"|"answer"|"discuss","why":"short reason"}

Employees:
${memberLines(team, members)}

Rules:
- One speaker is the norm. Two when the message clearly spans two domains. Three at most. Never more.
- "build": the boss wants something made, written, fixed or shown (a file, page, section, code, design, document, script, query). Pick exactly ONE employee who "builds files and code" and whose domain fits. Do not pick the manager or a chat-only employee for a build request. If nobody can build, pick the manager.
- "answer": a question or request inside one domain. Pick that domain's owner.
- "discuss": broad strategy, priorities, hiring, money, a complaint, frustration, a greeting, or an unclear message. Pick the manager (${manager?.name ?? 'the first employee'}) only.
- If the boss is replying to a specific employee's question or continuing their thread, pick that employee.
- If the boss says everyone should weigh in, pick up to three most relevant.
- Ignore @mentions; they are handled elsewhere.`
}

function context(team: Team, conversation: Conversation): string {
  const names = new Map<string, string>([['user', team.owner.name]])
  for (const a of team.agents) names.set(a.id, a.name)
  const recent = conversation.messages.filter((m) => m.status === 'done' && m.text.trim()).slice(-7)
  const lines = recent.map((m) => `[${names.get(m.authorId) ?? m.authorId}]: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  return lines.join('\n')
}

function parse(text: string, members: Agent[]): { ids: string[]; mode: RouteMode; why: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { speakers?: unknown; mode?: unknown; why?: unknown }
    const ids = Array.isArray(j.speakers) ? j.speakers.filter((s): s is string => typeof s === 'string') : []
    const known = ids
      .map((id) => members.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())?.id)
      .filter((id): id is string => id !== undefined)
    const mode: RouteMode = j.mode === 'build' || j.mode === 'answer' ? j.mode : 'discuss'
    return { ids: [...new Set(known)].slice(0, 3), mode, why: typeof j.why === 'string' ? j.why : '' }
  } catch {
    return null
  }
}

/** An OpenAI-compatible provider with a key, preferred for routing when present. */
function openAiRouter(team: Team): { provider: ProviderDef; model: string } | null {
  const wanted = process.env.OGB_ROUTER_PROVIDER
  const entries = Object.entries(team.providers).filter(([, p]) => p.kind === 'openai' && p.apiKey)
  const chosen = wanted ? entries.find(([id]) => id === wanted) : entries[0]
  if (!chosen) return null
  const [, provider] = chosen
  const models = provider.models ?? []
  const forced = process.env.OGB_ROUTER_MODEL
  const model =
    forced ||
    PREFERRED_ROUTER_MODELS.find((m) => models.includes(m)) ||
    models[0] ||
    ''
  if (!model) return null
  return { provider, model }
}

async function routeWithOpenAi(
  team: Team,
  conversation: Conversation,
  members: Agent[],
  userText: string,
  signal: AbortSignal,
): Promise<string> {
  const pick = openAiRouter(team)
  if (!pick) return ''
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    const res = await fetch(`${pick.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pick.provider.apiKey ?? 'none'}`,
        'user-agent': 'OpenGrokBot/0.3.0',
        // OpenCode Go requires a stable session id per conversation.
        'x-opencode-session': `router-${conversation.id}`,
      },
      body: JSON.stringify({
        model: pick.model,
        messages: [
          { role: 'system', content: systemPrompt(team, members) },
          { role: 'user', content: `Recent messages:\n${context(team, conversation)}\n\nLatest message from the boss:\n${userText}\n\nJSON:` },
        ],
        temperature: 0,
        max_tokens: 800,
      }),
      signal: abort.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      console.warn(`[router] ${pick.provider.label} (${pick.model}) HTTP ${res.status}: ${detail}`)
      return ''
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content) console.warn(`[router] ${pick.provider.label} (${pick.model}) returned no content`)
    return content
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Picks who should reply to the boss's latest message in a group. Uses a cheap model with no
 * tools; falls back to the manager (first member) if anything goes wrong.
 */
export async function routeSpeakers(team: Team, conversation: Conversation, userText: string, signal: AbortSignal): Promise<Route> {
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  const manager = members.find((a) => !a.muted) ?? members[0]
  const fallback: Route = { speakers: manager ? [manager] : [], mode: 'discuss', why: 'fallback' }
  if (members.length <= 1) return { speakers: members, mode: 'answer', why: 'single member' }

  const userPrompt = `Recent messages:\n${context(team, conversation)}\n\nLatest message from the boss:\n${userText}\n\nJSON:`

  // Prefer an OpenAI-compatible provider that already has a key (Venice, OpenCode Go, ...).
  if (openAiRouter(team)) {
    const text = await routeWithOpenAi(team, conversation, members, userText, signal)
    const parsed = parse(text, members)
    if (parsed && parsed.ids.length > 0) {
      const speakers = parsed.ids.map((id) => members.find((a) => a.id === id)).filter((a): a is Agent => a !== undefined)
      return { speakers, mode: parsed.mode, why: parsed.why }
    }
    if (text) console.warn('[router] could not parse OpenAI reply:', text.replace(/\s+/g, ' ').slice(0, 200))
  }

  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), 25_000)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN') env[k] = v

  let text = ''
  try {
    const q = query({
      prompt: userPrompt,
      options: {
        model: ROUTER_MODEL,
        systemPrompt: systemPrompt(team, members),
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        maxTurns: 1,
        env,
        abortController: abort,
        cwd: team.workspace,
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
    }
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  const parsed = parse(text, members)
  if (!parsed || parsed.ids.length === 0) return fallback
  const speakers = parsed.ids.map((id) => members.find((a) => a.id === id)).filter((a): a is Agent => a !== undefined)
  return { speakers, mode: parsed.mode, why: parsed.why }
}

export const __test = { parse, systemPrompt }
