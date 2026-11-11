import { randomUUID } from 'node:crypto'
import type { Account } from './account.js'
import { providerKeepsSession, runAgentTurn } from './agent.js'
import { reviewByRules, type Approvals } from './approvals.js'
import { emit } from './events.js'
import { collectAttachments } from './files.js'
import type { Memory } from './memory.js'
import { findMentions } from './mentions.js'
import { routeSpeakers, type RouteMode } from './router.js'
import type { Store } from './store.js'
import { summarizeUsage } from './usage.js'
import type { Agent, Attachment, Conversation, Message, ProviderDef, Routine, Team } from '../shared/types.js'

interface RoundState {
  running: boolean
  abort: AbortController | null
  pending: { message: Message; forced?: Agent[]; note?: string }[]
  activeMessages?: Set<string>
  stopped?: boolean
  generation?: number
}

/**
 * Decide who speaks first for an owner message without the router (DMs, mentions, the
 * non-smart group modes). Returns null when the smart router should decide. Exported for tests.
 */
export function initialQueue(team: Team, conversation: Conversation, userText: string): Agent[] | null {
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  if (conversation.kind === 'dm') return members
  const mentioned = findMentions(userText, members)
  if (mentioned.length > 0) return mentioned
  const unmuted = members.filter((a) => !a.muted)
  if (team.settings.groupMode === 'mentions-only') return unmuted.slice(0, 1)
  if (team.settings.groupMode === 'everyone') return unmuted
  return null
}

/** Expand /skill-id tokens into the skill's instructions. Exported for tests. */
export function expandSkills(team: Team, text: string): string {
  return text.replace(/(^|\s)\/([a-z0-9_-]+)\b/g, (whole, lead: string, id: string) => {
    const skill = team.skills[id]
    if (!skill) return whole
    return `${lead}[Skill "${skill.name}": ${skill.body.trim()}]`
  })
}

const BUILD_NOTE = 'Dispatcher: the boss asked for something to be made. Build it now with your tools, then reply with the full path and one or two sentences. No plans, no options, no questions.'
const ROUTINE_NOTE = 'This is a scheduled routine, not a live chat. Do the job fully with your tools, then post the result here. If a source is unavailable, say so instead of guessing.'

const FALLBACK_PROVIDER: ProviderDef = { kind: 'claude', label: 'Claude (subscription)' }

export interface PostOptions {
  attachments?: Attachment[]
  replyTo?: Message['replyTo']
  /** Author id; defaults to the owner. Routines post as 'routine'. */
  authorId?: string
  /** Skip routing and make exactly these employees reply. */
  forced?: Agent[]
  note?: string
}

export class Orchestrator {
  private readonly rounds = new Map<string, RoundState>()

  constructor(
    private readonly getTeam: () => Team,
    private readonly store: Store,
    private readonly account: Account,
    private readonly approvals: Approvals,
    private readonly memory: Memory,
    /** Whether a file path may be shown in the chat (inside the workspace, an employee folder, or uploads). */
    private readonly allowedFile: (p: string) => boolean,
  ) {}

  isBusy(conversationId: string): boolean {
    return this.rounds.get(conversationId)?.running ?? false
  }

  busyIds(): string[] {
    return [...this.rounds.entries()].filter(([, s]) => s.running).map(([id]) => id)
  }

  /** Post a message and start (or queue) a round of replies. */
  post(conversationId: string, text: string, opts: PostOptions = {}): Message {
    const conversation = this.store.get(conversationId)
    if (!conversation) throw new Error(`unknown conversation ${conversationId}`)
    const message: Message = {
      id: randomUUID(),
      conversationId,
      authorId: opts.authorId ?? 'user',
      text: expandSkills(this.getTeam(), text),
      createdAt: Date.now(),
      status: 'done',
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    }
    this.store.addMessage(conversationId, message)
    emit({ type: 'message:done', message })

    const state = this.state(conversationId)
    const job = { message, ...(opts.forced ? { forced: opts.forced } : {}), ...(opts.note ? { note: opts.note } : {}) }
    if (state.running) state.pending.push(job)
    else void this.runRound(conversationId, job)
    return message
  }

  /** Run a routine: post its instruction as a routine message and make its owner reply. */
  async runRoutine(routine: Routine): Promise<{ messageId?: string }> {
    const team = this.getTeam()
    const agent = team.agents.find((a) => a.id === routine.agentId)
    if (!agent) throw new Error(`employee ${routine.agentId} no longer exists`)
    const conversation = this.store.get(routine.conversationId)
    if (!conversation) throw new Error(`conversation ${routine.conversationId} no longer exists`)
    if (!conversation.memberIds.includes(agent.id)) throw new Error(`${agent.name} is not in that conversation`)
    const before = conversation.messages.length
    const trigger = this.post(routine.conversationId, `⏰ ${routine.name}\n${routine.instruction}`, { authorId: 'routine', forced: [agent], note: ROUTINE_NOTE })
    await this.waitForIdle(routine.conversationId)
    const reply = this.store.get(routine.conversationId)?.messages.slice(before + 1).find((m) => m.authorId === agent.id)
    if (!reply) return {}
    if (reply.status === 'error') throw new Error(reply.text.replace(/^⚠️\s*/, ''))
    void trigger
    return { messageId: reply.id }
  }

  stop(conversationId: string): void {
    const state = this.rounds.get(conversationId)
    if (!state) return
    state.pending = []
    state.stopped = true
    state.generation = (state.generation ?? 0) + 1
    state.abort?.abort()
    // Finalize the live bubble right away: a stuck provider or child process must not
    // leave the UI spinning after the owner pressed Stop.
    for (const messageId of state.activeMessages ?? []) {
      const msg = this.store.get(conversationId)?.messages.find((m) => m.id === messageId)
      if (msg && msg.status === 'streaming') {
        const text = msg.text.trim() || '⚠️ Đã dừng theo yêu cầu.'
        const done = this.store.updateMessage(conversationId, messageId, { text, status: 'error' }) ?? { ...msg, text, status: 'error' as const }
        emit({ type: 'message:done', message: done })
      }
    }
    state.activeMessages = new Set()
    state.running = false
    state.abort = null
    emit({ type: 'round', conversationId, running: false })
  }

  /** Runs a minimal Claude turn just to refresh the account's rate-limit picture. */
  async probeAccount(): Promise<void> {
    const team = this.getTeam()
    const base = team.agents[0]
    const probe: Agent = {
      ...(base ?? { id: 'x', name: 'X', role: 'X', color: '#fff', shape: 'blob', permissionMode: 'dontAsk', effort: 'low', personality: '', tools: [], mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, muted: false, model: '', provider: 'claude', approvals: 'auto' }),
      id: 'probe',
      name: 'PROBE',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      effort: 'low',
      tools: [],
      mcpServers: [],
      inheritClaudeSettings: false,
      autoApproveTools: false,
      approvals: 'auto',
      personality: 'Reply with the single word OK.',
    }
    const conversation: Conversation = {
      id: 'probe',
      kind: 'dm',
      name: 'probe',
      memberIds: ['user', 'probe'],
      messages: [{ id: 'p', conversationId: 'probe', authorId: 'user', text: 'ping', createdAt: Date.now(), status: 'done' }],
      sessions: {},
    }
    await runAgentTurn({
      team: { ...team, agents: [probe] },
      conversation,
      agent: probe,
      provider: team.providers.claude ?? FALLBACK_PROVIDER,
      sessionId: undefined,
      signal: new AbortController().signal,
      handlers: {
        onDelta: () => {},
        onActivity: () => {},
        onSession: () => {},
        onInit: (src, ver) => this.account.noteInit(src, ver),
        onRateLimit: (info) => this.account.noteRateLimit(info),
      },
    })
    emit({ type: 'account', account: this.account.get() })
  }

  private waitForIdle(conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const s = this.rounds.get(conversationId)
        if (!s || (!s.running && s.pending.length === 0)) resolve()
        else setTimeout(check, 500)
      }
      check()
    })
  }

  private state(conversationId: string): RoundState {
    let s = this.rounds.get(conversationId)
    if (!s) {
      s = { running: false, abort: null, pending: [], activeMessages: new Set(), stopped: false, generation: 0 }
      this.rounds.set(conversationId, s)
    }
    return s
  }

  private async runRound(conversationId: string, job: RoundState['pending'][number]): Promise<void> {
    const state = this.state(conversationId)
    state.running = true
    state.stopped = false
    state.activeMessages = new Set()
    const generation = (state.generation = (state.generation ?? 0) + 1)
    state.abort = new AbortController()
    emit({ type: 'round', conversationId, running: true })
    const startIndex = this.store.get(conversationId)?.messages.length ?? 0
    const spoke = new Set<string>()
    try {
      await this.speakers(conversationId, job, state.abort.signal, spoke)
    } finally {
      // A stopped round was already finalized; a newer round owns the state now.
      if (state.generation !== generation) return
      state.running = false
      state.abort = null
      emit({ type: 'round', conversationId, running: false })
      this.remember(conversationId, startIndex - 1, spoke)
      const next = state.pending.shift()
      if (next) void this.runRound(conversationId, next)
    }
  }

  /** Background memory update for everyone who spoke this round. */
  private remember(conversationId: string, fromIndex: number, spoke: Set<string>): void {
    const team = this.getTeam()
    const conversation = this.store.get(conversationId)
    if (!conversation || spoke.size === 0) return
    const recent = conversation.messages.slice(Math.max(0, fromIndex))
    for (const id of spoke) {
      const agent = team.agents.find((a) => a.id === id)
      if (agent) void this.memory.update(team, agent, recent)
    }
  }

  private async speakers(conversationId: string, job: RoundState['pending'][number], signal: AbortSignal, spoke: Set<string>): Promise<void> {
    const conversation = this.store.get(conversationId)
    if (!conversation) return
    const team = this.getTeam()
    const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
    let queue = job.forced ?? initialQueue(team, conversation, job.message.text)
    let mode: RouteMode = 'discuss'
    if (queue === null) {
      const route = await routeSpeakers(team, conversation, job.message.text, signal)
      queue = route.speakers
      mode = route.mode
      console.log(`[router] ${conversation.id}: ${route.speakers.map((a) => a.name).join(', ') || 'nobody'} (${route.mode}) — ${route.why}`)
    }
    const turns = new Map<string, number>()
    let count = 0
    let first = true
    // The per-agent cap already bounds a chain (each agent may speak maxTurnsPerAgentPerRound
    // times per round). Make the round cap at least that large so a legitimate handoff is
    // never cut off silently; loops still stop when every member has used their turns.
    const perAgent = Math.max(1, team.settings.maxTurnsPerAgentPerRound)
    const hardCap = Math.max(team.settings.maxMessagesPerRound, team.agents.length * perAgent)

    // Run a wave of independent agents together. File/shell tools are serialized by a
    // process-wide lock, so parallel turns cannot corrupt the same repo.
    const parallel = Math.max(1, Math.min(5, Number(process.env.OGB_PARALLEL_AGENTS ?? 4) || 4))
    const manager = members[0]
    while (queue.length > 0 && count < hardCap && !signal.aborted) {
      // A newer owner message arrived mid-round: let the next round handle it with fresh context.
      if (this.state(conversationId).pending.length > 0) break
      const batch: Agent[] = []
      while (batch.length < parallel && queue.length > 0 && count + batch.length < hardCap) {
        const next = queue[0]
        if (!next) break
        // The manager reviews only after every worker has reported, so it never shares a wave.
        if (manager && next.id === manager.id && batch.length > 0) break
        queue.shift()
        batch.push(next)
        if (manager && next.id === manager.id) break
      }
      if (batch.length === 0) break
      const batchNotes = batch.map((agent, index) => {
        if (index > 0) return undefined
        const buildNote = first && mode === 'build' && agent.tools.some((t) => ['Edit', 'Write'].includes(t)) ? BUILD_NOTE : undefined
        return job.note ?? buildNote
      })
      first = false
      count += batch.length
      for (const agent of batch) turns.set(agent.id, (turns.get(agent.id) ?? 0) + 1)
      const replies = await Promise.all(batch.map((agent, index) => this.turn(conversationId, agent, signal, batchNotes[index])))
      batch.forEach((agent, index) => {
        const reply = replies[index] ?? ''
        if (reply) spoke.add(agent.id)
        if (!reply) return
        for (const m of findMentions(reply, members, agent.id)) {
          const taken = turns.get(m.id) ?? 0
          if (taken >= perAgent) continue
          if (queue.some((q) => q.id === m.id)) continue
          queue.push(m)
        }
      })
      // Company loop: workers just reported, so hand the floor back to the manager to
      // review the reports and assign the next tasks (bounded by the per-agent cap).
      if (
        members.length > 1 &&
        manager &&
        !manager.muted &&
        !batch.some((a) => a.id === manager.id) &&
        (turns.get(manager.id) ?? 0) < perAgent &&
        !queue.some((q) => q.id === manager.id)
      ) {
        queue.push(manager)
      }
    }
    if (queue.length > 0 && !signal.aborted) {
      const waiting = queue.map((a) => a.name).join(', ')
      console.warn(`[round] ${conversationId}: dừng sau ${count} lượt, còn chờ: ${waiting}`)
      const notice = `⏸️ Tạm dừng chuỗi trao đổi sau ${count} lượt để tránh lặp. Còn chờ: ${waiting}. Gõ "tiếp tục" nếu muốn chạy tiếp.`
      const message: Message = {
        id: randomUUID(),
        conversationId,
        authorId: 'routine',
        text: notice,
        createdAt: Date.now(),
        status: 'done',
      }
      this.store.addMessage(conversationId, message)
      emit({ type: 'message:done', message })
    }
  }

  /** Runs one agent turn, streaming into a message. Returns the final text ('' if skipped/error). */
  private async turn(conversationId: string, agent: Agent, signal: AbortSignal, note?: string): Promise<string> {
    const conversation = this.store.get(conversationId)
    if (!conversation) return ''
    const team = this.getTeam()
    const provider = team.providers[agent.provider] ?? FALLBACK_PROVIDER
    const message: Message = {
      id: randomUUID(),
      conversationId,
      authorId: agent.id,
      text: '',
      createdAt: Date.now(),
      status: 'streaming',
      activity: [],
    }
    this.state(conversationId).activeMessages?.add(message.id)
    emit({ type: 'typing', conversationId, agentId: agent.id, on: true })
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      this.store.addMessage(conversationId, message)
      emit({ type: 'message:start', message })
    }

    // Sessions are per provider kind: switching an employee to another provider starts fresh.
    const sessionKey = `${agent.id}@${provider.kind}`
    const sessionId = providerKeepsSession(provider.kind) ? conversation.sessions[sessionKey] : undefined
    const notes = [this.memory.read(agent.id), this.liveStatus(conversationId)].filter((x) => x && x.trim()).join('\n\n')

    const result = await runAgentTurn({
      team,
      conversation,
      agent,
      provider,
      sessionId,
      signal,
      notes,
      ...(note ? { note } : {}),
      handlers: {
        onDelta: (delta) => {
          start()
          message.text += delta
          emit({ type: 'message:delta', conversationId, messageId: message.id, delta })
        },
        onActivity: (line) => {
          start()
          message.activity?.push(line)
          emit({ type: 'message:activity', conversationId, messageId: message.id, line })
        },
        onSession: (id) => {
          this.store.setSession(conversationId, sessionKey, id)
        },
        onInit: (src, ver) => {
          if (this.account.noteInit(src, ver)) emit({ type: 'account', account: this.account.get() })
        },
        onRateLimit: (info) => {
          this.account.noteRateLimit(info)
          emit({ type: 'account', account: this.account.get() })
        },
        onToolPermission: async (tool, input) => {
          const verdict = reviewByRules(this.getTeam(), tool, input)
          if (verdict === 'allow') return true
          start()
          const line = `Waiting for your approval: ${tool}`
          message.activity?.push(line)
          emit({ type: 'message:activity', conversationId, messageId: message.id, line })
          return this.approvals.ask(conversationId, agent.id, tool, input, signal)
        },
      },
    })
    emit({ type: 'typing', conversationId, agentId: agent.id, on: false })
    const roundState = this.state(conversationId)
    roundState.activeMessages?.delete(message.id)
    if (roundState.stopped) return ''

    // A manager working in a DM still has to reach the team: relay assignments that mention
    // employees who are not in this DM into the shared group and dispatch them there.
    if (conversation.kind === 'dm' && !result.error && result.text.trim() && !result.text.includes('↪️ Đã đăng việc này')) {
      const outsiders = team.agents.filter((a) => !conversation.memberIds.includes(a.id))
      const targets = findMentions(result.text, outsiders, agent.id)
      if (targets.length > 0) {
        // post() hands this array to the new round, which shifts it; snapshot names first.
        const targetNames = targets.map((a) => a.name).join(', ')
        try {
          this.post(
            'group',
            `${result.text}\n\n↪️ (Chuyển tự động từ DM của ${agent.name})`,
            {
              authorId: agent.id,
              forced: [...targets],
              note: 'Việc này được chuyển từ DM sang nhóm. Hãy làm và báo cáo lại trong nhóm, @MINH khi xong.',
            },
          )
          result.text += `\n\n↪️ Đã đăng việc này vào nhóm chung và giao cho ${targetNames}.`
        } catch {
          /* group may not exist yet; keep the DM reply */
        }
      }
    }

    if (result.error && /session|resume|not found|No conversation found|thread/i.test(result.error) && sessionId) {
      // The stored session is gone (e.g. transcript deleted). Forget it and retry once fresh.
      this.store.clearSession(conversationId, sessionKey)
      if (!started) return this.turn(conversationId, agent, signal, note)
    }

    const usagePatch = result.usage ? { usage: result.usage } : {}

    if (result.error) {
      start()
      const text = message.text.trim().length > 0 ? message.text : `⚠️ ${result.error}`
      const done = this.store.updateMessage(conversationId, message.id, { text, status: 'error', ...usagePatch }) ?? { ...message, text, status: 'error' as const }
      emit({ type: 'message:done', message: done })
      this.emitUsage()
      return ''
    }

    if (result.text.length === 0) {
      // The agent chose to skip. Keep the cost on the books but drop the bubble.
      if (started) {
        this.store.removeMessage(conversationId, message.id)
        emit({ type: 'message:remove', conversationId, messageId: message.id })
      }
      if (result.usage) this.store.recordSilentUsage(conversationId, agent.id, result.usage)
      this.emitUsage()
      return ''
    }

    start()
    const attachments = collectAttachments(result.text, message.activity ?? [], this.allowedFile)
    const done = this.store.updateMessage(conversationId, message.id, { text: result.text, status: 'done', ...usagePatch, ...(attachments.length ? { attachments } : {}) }) ?? { ...message, text: result.text, status: 'done' as const }
    emit({ type: 'message:done', message: done })
    this.emitUsage()
    return result.text
  }

  /** A snapshot of what the team is doing right now, so managers do not guess from old log files. */
  private liveStatus(conversationId: string): string {
    const team = this.getTeam()
    const now = Date.now()
    const lines: string[] = ['[Trạng thái đội ngũ — dữ liệu trực tiếp từ hệ thống, chính xác hơn log cũ]']
    let running = 0
    for (const [cid, st] of this.rounds) {
      if (!st.running) continue
      const conv = this.store.get(cid)
      const active = [...(st.activeMessages ?? [])]
        .map((id) => conv?.messages.find((m) => m.id === id))
        .filter((m): m is Message => Boolean(m))
      const who = active.length > 0 ? active.map((m) => team.agents.find((a) => a.id === m.authorId)?.name ?? m.authorId).join(', ') : 'một agent'
      const secs = active.length > 0 ? Math.max(0, Math.round((now - Math.min(...active.map((m) => m.createdAt))) / 1000)) : 0
      const steps = active.reduce((n, m) => n + (m.activity?.length ?? 0), 0)
      lines.push(`- ĐANG CHẠY: ${who} trong "${conv?.name ?? cid}" (${secs}s, ${steps} bước)`)
      if (st.pending.length > 0) lines.push(`- Đang chờ trong "${conv?.name ?? cid}": ${st.pending.length} yêu cầu`)
      running++
    }
    if (running === 0) lines.push('- Không có agent nào đang chạy ngay lúc này.')
    const conv = this.store.get(conversationId)
    const recent = (conv?.messages ?? []).filter((m) => m.status === 'done' && m.authorId !== 'user').slice(-5)
    if (recent.length > 0) {
      lines.push('- Báo cáo gần nhất:')
      for (const m of recent) {
        const name = team.agents.find((a) => a.id === m.authorId)?.name ?? m.authorId
        const mins = Math.max(0, Math.round((now - m.createdAt) / 60_000))
        lines.push(`  · ${name} (${mins} phút trước): ${(m.text || '').replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    lines.push('Nếu được hỏi "team đang làm gì", hãy dựa vào mục ĐANG CHẠY ở trên, không suy đoán từ file log cũ.')
    return lines.join('\n')
  }

  private emitUsage(): void {
    emit({ type: 'usage', usage: summarizeUsage(this.store.list()) })
  }
}
