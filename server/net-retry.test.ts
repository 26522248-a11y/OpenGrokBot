import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { fetchWithRetry } from './providers/openai.js'

test('fetchWithRetry retries a 503 and a dropped connection', async () => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    if (hits === 1) {
      res.writeHead(503, { 'retry-after': '0' })
      res.end('busy')
      return
    }
    if (hits === 2) {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${address.port}/`, {}, new AbortController().signal)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
    assert.equal(hits, 3)
  } finally {
    server.close()
  }
})

test('fetchWithRetry stops when its signal aborts', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => fetchWithRetry('http://127.0.0.1:1/', {}, controller.signal),
    /Stopped\./,
  )
})
