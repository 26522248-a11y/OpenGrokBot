import { readFileSync } from 'node:fs'

const cfg = JSON.parse(readFileSync('team.json', 'utf8'))
const key = cfg.providers['opencode-go'].apiKey

async function check(label, url, headers = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    console.log(`${label}: HTTP ${res.status} (${Date.now() - started}ms)`)
    return res.status
  } catch (err) {
    console.log(`${label}: FAIL ${err?.cause?.code ?? ''} ${err?.cause?.message ?? err.message} (${Date.now() - started}ms)`)
    return 0
  }
}

console.log('time:', new Date().toISOString())
await check('google', 'https://www.google.com')
await check('opencode root', 'https://opencode.ai')
await check('go models', 'https://opencode.ai/inference/go/v1/models', { authorization: `Bearer ${key}` })
await check('chat', 'https://opencode.ai/inference/go/openai/v1/chat/completions', {
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
})
