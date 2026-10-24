// Tests for the Feishu MCP server. Every Feishu call goes to a mock HTTP server on
// 127.0.0.1 (FEISHU_BASE_URL), so the suite never reaches the network.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const APP_ID = 'cli_test_app_id'
const APP_SECRET = 'test-app-secret-value'
const TOKEN = 't-test-token'
const START_TIMEOUT_MS = 5000
const TOOL_NAMES = ['feishu_send_message', 'feishu_list_chats', 'feishu_get_chat_history', 'feishu_get_user']
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

// --- helpers ---------------------------------------------------------------------------

function rejectAfter(ms, message) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
}

function reply(res, spec = {}) {
  const { status = 200, body, delayMs = 0 } = spec
  const write = () => {
    if (res.destroyed) return
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (delayMs > 0) {
    const timer = setTimeout(write, delayMs)
    timer.unref()
  } else {
    write()
  }
}

function tokenBody(token = TOKEN, expire = 7200) {
  return { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: token, expire } }
}

function okBody(data) {
  return { status: 200, body: { code: 0, msg: 'ok', data } }
}

// routes: { token?, [path]: (call) => reply spec }
function mockApi(routes = {}) {
  return (call, res) => {
    if (call.path === TOKEN_PATH) return reply(res, routes.token === undefined ? tokenBody() : routes.token(call))
    const route = routes[call.path]
    if (route === undefined) return reply(res, okBody({}))
    return reply(res, route(call))
  }
}

async function startMock(handler) {
  const calls = []
  const server = createServer((request, response) => {
    // A timed-out call closes its socket; a late write must not take the test process down.
    response.on('error', () => {})
    let raw = ''
    request.on('data', chunk => {
      raw += chunk
    })
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      let body = null
      if (raw !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      const call = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body,
      }
      calls.push(call)
      try {
        handler(call, response)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' }).end(String(error))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function startClient(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      FEISHU_APP_ID: APP_ID,
      FEISHU_APP_SECRET: APP_SECRET,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = { child, stderr: '', messages: [], pending: new Map(), nextId: 1, exited: null }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let buffer = ''
  let readyResolve
  let readySeen = false
  const ready = new Promise(resolve => {
    readyResolve = resolve
  })
  child.stderr.on('data', chunk => {
    client.stderr += chunk
    if (!readySeen && client.stderr.includes('ready')) {
      readySeen = true
      readyResolve()
    }
  })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      client.messages.push(message)
      const waiter = client.pending.get(message.id)
      if (waiter === undefined) continue
      client.pending.delete(message.id)
      if (message.error !== undefined) {
        waiter.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }))
      } else {
        waiter.resolve(message.result)
      }
    }
  })
  child.on('exit', code => {
    client.exited = code
    for (const waiter of client.pending.values()) waiter.reject(new Error(`server exited with code ${code}`))
    client.pending.clear()
  })

  client.ready = Promise.race([ready, rejectAfter(START_TIMEOUT_MS, 'the MCP server did not start')])
  client.request = (method, params) => new Promise((resolve, reject) => {
    const id = client.nextId
    client.nextId += 1
    client.pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  client.notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  client.sendRaw = line => {
    child.stdin.write(`${line}\n`)
  }
  client.callTool = async (name, args) => {
    const result = await client.request('tools/call', { name, arguments: args })
    const text = result.content?.[0]?.text ?? ''
    return { isError: result.isError === true, value: JSON.parse(text) }
  }
  client.close = async () => {
    if (client.exited !== null) return
    child.stdin.end()
    child.kill()
    await Promise.race([once(child, 'exit'), rejectAfter(2000, 'the MCP server did not stop').catch(() => {})])
  }
  return client
}

// Starts the mock, the server, and cleans both up after the test.
async function withMock(t, handler, env, run) {
  const mock = await startMock(handler)
  const client = startClient({ FEISHU_BASE_URL: mock.baseUrl, ...env })
  t.after(async () => {
    await client.close()
    await mock.close()
  })
  await client.ready
  return run({ client, mock })
}

function runCli(arguments_, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...arguments_], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the expected state')
}

// --- protocol --------------------------------------------------------------------------

test('initialize reports MCP 2024-11-05 and the tools capability', async t => {
  await withMock(t, mockApi(), {}, async ({ client }) => {
    const result = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'feishu-test', version: '1.0.0' },
    })
    assert.equal(result.protocolVersion, '2024-11-05')
    assert.deepEqual(result.capabilities, { tools: {} })
    assert.equal(result.serverInfo.name, 'mmbot-feishu')
    assert.equal(result.serverInfo.version, PACKAGE.version)
    assert.match(result.instructions, /Feishu/)
    client.notify('notifications/initialized')
    assert.deepEqual(await client.request('ping'), {})
  })
})

test('tools/list describes every tool with input and output JSON Schema', async t => {
  await withMock(t, mockApi(), {}, async ({ client }) => {
    const { tools } = await client.request('tools/list')
    assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES)
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an input schema`)
      assert.equal(tool.outputSchema.type, 'object', `${tool.name} needs an output schema`)
      assert.ok(tool.description.length > 20, `${tool.name} needs a description`)
    }
    const send = tools.find(tool => tool.name === 'feishu_send_message')
    assert.deepEqual(send.inputSchema.oneOf.map(branch => branch.required[0]), ['chat_id', 'open_id', 'email'])
    assert.deepEqual(send.inputSchema.required, ['text'])
    const history = tools.find(tool => tool.name === 'feishu_get_chat_history')
    assert.deepEqual(history.inputSchema.required, ['container_id'])
    const user = tools.find(tool => tool.name === 'feishu_get_user')
    assert.deepEqual(user.inputSchema.oneOf.map(branch => branch.required[0]), ['email', 'mobile'])
  })
})

test('protocol errors use JSON-RPC error codes', async t => {
  await withMock(t, mockApi(), {}, async ({ client }) => {
    await assert.rejects(client.request('does/not/exist', {}), error => error.rpcError.code === -32601)
    await assert.rejects(
      client.request('tools/call', { name: 'feishu_nope', arguments: {} }),
      error => error.rpcError.code === -32602,
    )
    client.sendRaw('this is not json')
    await waitFor(() => client.messages.some(message => message.error?.code === -32700))
  })
})

// --- tools -----------------------------------------------------------------------------

test('feishu_send_message posts a text message to a chat and returns the message id', async t => {
  const handler = mockApi({
    '/open-apis/im/v1/messages': () => okBody({ message_id: 'om_1', chat_id: 'oc_1', create_time: '1700000000000' }),
  })
  await withMock(t, handler, {}, async ({ client, mock }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hello team' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, {
      ok: true,
      message_id: 'om_1',
      chat_id: 'oc_1',
      create_time: '1700000000000',
      receive_id_type: 'chat_id',
      receive_id: 'oc_1',
    })
    const messageCall = mock.calls.find(call => call.path === '/open-apis/im/v1/messages')
    assert.equal(messageCall.method, 'POST')
    assert.equal(messageCall.query.receive_id_type, 'chat_id')
    assert.equal(messageCall.headers.authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(messageCall.body, {
      receive_id: 'oc_1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello team' }),
    })
    const tokenCall = mock.calls.find(call => call.path === TOKEN_PATH)
    assert.deepEqual(tokenCall.body, { app_id: APP_ID, app_secret: APP_SECRET })
    assert.ok(!client.stderr.includes(APP_SECRET), 'the app secret must never reach the log')
    assert.ok(!client.stderr.includes(TOKEN), 'the token must never reach the log')
  })
})

test('feishu_send_message resolves an email target with receive_id_type=email', async t => {
  const handler = mockApi({ '/open-apis/im/v1/messages': () => okBody({ message_id: 'om_2' }) })
  await withMock(t, handler, {}, async ({ client, mock }) => {
    const result = await client.callTool('feishu_send_message', { email: 'ada@example.com', text: 'hi' })
    assert.equal(result.isError, false)
    assert.equal(result.value.receive_id_type, 'email')
    const messageCall = mock.calls.find(call => call.path === '/open-apis/im/v1/messages')
    assert.equal(messageCall.query.receive_id_type, 'email')
    assert.equal(messageCall.body.receive_id, 'ada@example.com')
  })
})

test('argument validation rejects a bad target without calling Feishu', async t => {
  await withMock(t, mockApi(), {}, async ({ client, mock }) => {
    const noTarget = await client.callTool('feishu_send_message', { text: 'hi' })
    assert.equal(noTarget.isError, true)
    assert.equal(noTarget.value.ok, false)
    assert.equal(noTarget.value.code, 'invalid_arguments')
    assert.match(noTarget.value.message, /exactly one of chat_id, open_id, email/)

    const twoTargets = await client.callTool('feishu_send_message', { chat_id: 'oc_1', open_id: 'ou_1', text: 'hi' })
    assert.match(twoTargets.value.message, /exactly one of/)

    const noText = await client.callTool('feishu_send_message', { chat_id: 'oc_1' })
    assert.match(noText.value.message, /text is required/)

    const unknown = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi', text_id: 'x' })
    assert.match(unknown.value.message, /unknown argument text_id/)

    const badPageSize = await client.callTool('feishu_list_chats', { page_size: 500 })
    assert.match(badPageSize.value.message, /page_size must be at most 100/)

    assert.equal(mock.calls.length, 0, 'invalid arguments must not reach Feishu')
  })
})

test('feishu_list_chats passes paging through and maps the chats', async t => {
  const handler = mockApi({
    '/open-apis/im/v1/chats': call => {
      assert.equal(call.query.page_size, '50')
      assert.equal(call.query.page_token, 'cursor-1')
      return okBody({
        items: [
          {
            chat_id: 'oc_1',
            name: 'Team',
            description: 'Builders',
            chat_mode: 'group',
            chat_type: 'private',
            external: false,
            owner_id: 'ou_1',
          },
          { chat_id: 'oc_2', name: '', chat_mode: 'p2p', chat_type: 'p2p', external: true },
        ],
        page_token: 'cursor-2',
        has_more: true,
      })
    },
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_list_chats', { page_size: 50, page_token: 'cursor-1' })
    assert.equal(result.isError, false)
    assert.equal(result.value.chats.length, 2)
    assert.deepEqual(result.value.chats[0], {
      chat_id: 'oc_1',
      name: 'Team',
      description: 'Builders',
      chat_mode: 'group',
      chat_type: 'private',
      external: false,
      owner_id: 'ou_1',
    })
    assert.equal(result.value.page_token, 'cursor-2')
    assert.equal(result.value.has_more, true)
  })
})

test('feishu_get_chat_history needs a chat id and flattens message content', async t => {
  const handler = mockApi({
    '/open-apis/im/v1/messages': call => {
      assert.equal(call.query.container_id_type, 'chat')
      assert.equal(call.query.container_id, 'oc_1')
      assert.equal(call.query.sort_type, 'ByCreateTimeDesc')
      return okBody({
        items: [
          {
            message_id: 'om_1',
            msg_type: 'text',
            create_time: '1700000000000',
            sender: { id: 'ou_1', sender_type: 'user' },
            body: { content: JSON.stringify({ text: 'hi there' }) },
            mentions: [{ name: 'Ada' }],
          },
          {
            message_id: 'om_2',
            msg_type: 'post',
            create_time: '1700000001000',
            sender: { id: 'cli_app', sender_type: 'app' },
            body: {
              content: JSON.stringify({
                title: 'Weekly',
                content: [[
                  { tag: 'text', text: 'done ' },
                  { tag: 'a', text: 'link', href: 'https://example.com' },
                  { tag: 'at', user_id: 'ou_9' },
                ]],
              }),
            },
          },
          { message_id: 'om_3', msg_type: 'image', sender: { id: 'ou_2', sender_type: 'user' } },
        ],
        page_token: '',
        has_more: false,
      })
    },
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const missing = await client.callTool('feishu_get_chat_history', {})
    assert.equal(missing.isError, true)
    assert.match(missing.value.message, /container_id is required/)

    const result = await client.callTool('feishu_get_chat_history', { container_id: 'oc_1' })
    assert.equal(result.isError, false)
    const [text, post, image] = result.value.messages
    assert.equal(text.text, 'hi there')
    assert.deepEqual(text.mentions, ['Ada'])
    assert.equal(post.text, 'Weekly\ndone link@ou_9')
    assert.equal(post.sender_type, 'app')
    assert.equal(image.text, '[image]')
    assert.equal(result.value.has_more, false)
  })
})

test('feishu_get_user turns an email into an open_id', async t => {
  const handler = mockApi({
    '/open-apis/contact/v3/users/batch_get_id': call => {
      assert.equal(call.method, 'POST')
      assert.equal(call.query.user_id_type, 'open_id')
      assert.deepEqual(call.body, { emails: ['ada@example.com'] })
      return okBody({ user_list: [{ email: 'ada@example.com', user_id: 'ou_ada' }] })
    },
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_get_user', { email: 'ada@example.com' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, {
      ok: true,
      users: [{ open_id: 'ou_ada', email: 'ada@example.com', mobile: '' }],
      not_found: [],
    })
  })
})

test('feishu_get_user reports a user that Feishu cannot match', async t => {
  const handler = mockApi({
    '/open-apis/contact/v3/users/batch_get_id': () => okBody({ user_list: [{ email: 'ghost@example.com', user_id: '' }] }),
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_get_user', { email: 'ghost@example.com' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value.users, [])
    assert.deepEqual(result.value.not_found, ['ghost@example.com'])
  })
})

test('feishu_get_user rejects a call without an email or a mobile', async t => {
  await withMock(t, mockApi(), {}, async ({ client }) => {
    const result = await client.callTool('feishu_get_user', {})
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'invalid_arguments')
    assert.match(result.value.message, /exactly one of email, mobile/)
  })
})

// --- auth and failures -----------------------------------------------------------------

test('a rejected tenant token is fetched again once and the call is retried', async t => {
  let tokens = 0
  let messages = 0
  const handler = mockApi({
    token: () => {
      tokens += 1
      return tokenBody(`t-token-${tokens}`)
    },
    '/open-apis/im/v1/messages': () => {
      messages += 1
      if (messages === 1) return { status: 401, body: { code: 99991663, msg: 'invalid access token' } }
      return okBody({ message_id: 'om_ok' })
    },
  })
  await withMock(t, handler, {}, async ({ client, mock }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi' })
    assert.equal(result.isError, false)
    assert.equal(result.value.message_id, 'om_ok')
    assert.equal(tokens, 2, 'the token is fetched a second time')
    assert.equal(messages, 2, 'the call is retried exactly once')
    const messageCalls = mock.calls.filter(call => call.path === '/open-apis/im/v1/messages')
    assert.equal(messageCalls[0].headers.authorization, 'Bearer t-token-1')
    assert.equal(messageCalls[1].headers.authorization, 'Bearer t-token-2')
  })
})

test('a token that expires inside the refresh margin is fetched again for the next call', async t => {
  let tokens = 0
  const handler = mockApi({
    token: () => {
      tokens += 1
      return tokenBody(TOKEN, 120)
    },
    '/open-apis/im/v1/messages': () => okBody({ message_id: 'om_1' }),
  })
  await withMock(t, handler, {}, async ({ client }) => {
    await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'one' })
    await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'two' })
    assert.equal(tokens, 2, 'a token inside the 5 minute margin is not reused')
  })
})

test('a permission error becomes a structured tool error', async t => {
  const handler = mockApi({
    '/open-apis/im/v1/messages': () => ({ status: 200, body: { code: 99991672, msg: 'no permission' } }),
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi' })
    assert.equal(result.isError, true)
    assert.equal(result.value.ok, false)
    assert.equal(result.value.code, 'permission_denied')
    assert.equal(result.value.message, 'no permission')
    assert.equal(result.value.feishu_code, 99991672)
    assert.equal(result.value.status, 200)
    assert.equal(result.value.endpoint, '/open-apis/im/v1/messages')
    assert.match(result.value.hint, /permission scope/)
  })
})

test('a bot outside the chat is named in the error and its hint', async t => {
  const handler = mockApi({
    '/open-apis/im/v1/messages': () => ({ status: 400, body: { code: 230002, msg: 'bot is not in the chat' } }),
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi' })
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'not_in_chat')
    assert.match(result.value.hint, /Add the bot to the group chat/)
  })
})

test('rate limiting is retried once, then reported', async t => {
  let messages = 0
  const handler = mockApi({
    '/open-apis/im/v1/messages': () => {
      messages += 1
      return { status: 429, body: { code: 99991400, msg: 'too many request' } }
    },
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi' })
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'rate_limited')
    assert.equal(result.value.status, 429)
    assert.equal(messages, 2, 'one retry and no more')
  })
})

test('a Feishu server error is reported after one retry', async t => {
  let calls = 0
  const handler = mockApi({
    '/open-apis/im/v1/chats': () => {
      calls += 1
      return { status: 503, body: { code: 500, msg: 'service unavailable' } }
    },
  })
  await withMock(t, handler, {}, async ({ client }) => {
    const result = await client.callTool('feishu_list_chats', {})
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'server_error')
    assert.equal(result.value.status, 503)
    assert.equal(calls, 2)
  })
})

test('a slow Feishu call times out with a structured error', async t => {
  let messages = 0
  const handler = mockApi({
    '/open-apis/im/v1/messages': () => {
      messages += 1
      return { status: 200, body: { code: 0, msg: 'ok', data: { message_id: 'om_late' } }, delayMs: 500 }
    },
  })
  await withMock(t, handler, { FEISHU_TIMEOUT_MS: '120', FEISHU_RETRIES: '0' }, async ({ client }) => {
    const result = await client.callTool('feishu_send_message', { chat_id: 'oc_1', text: 'hi' })
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'timeout')
    assert.match(result.value.message, /120 ms/)
    assert.equal(messages, 1, 'a timeout is not retried')
  })
})

test('missing credentials fail the tool call but not the server', async t => {
  await withMock(t, mockApi(), { FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' }, async ({ client, mock }) => {
    const result = await client.callTool('feishu_list_chats', {})
    assert.equal(result.isError, true)
    assert.equal(result.value.code, 'missing_credentials')
    assert.match(result.value.message, /FEISHU_APP_ID/)
    assert.match(result.value.hint, /FEISHU_APP_SECRET/)
    assert.equal(mock.calls.length, 0)
  })
})

test('an invalid FEISHU_BASE_URL is reported without a request', async t => {
  const client = startClient({ FEISHU_BASE_URL: 'ftp://example.com' })
  t.after(() => client.close())
  await client.ready
  const result = await client.callTool('feishu_list_chats', {})
  assert.equal(result.isError, true)
  assert.equal(result.value.code, 'invalid_config')
})

// --- command line ----------------------------------------------------------------------

test('--print-tools prints the tool list as JSON', async () => {
  const { code, stdout } = await runCli(['--print-tools'])
  assert.equal(code, 0)
  const document = JSON.parse(stdout)
  assert.equal(document.protocolVersion, '2024-11-05')
  assert.equal(document.server.name, 'mmbot-feishu')
  assert.equal(document.server.version, PACKAGE.version)
  assert.deepEqual(document.tools.map(tool => tool.name), TOOL_NAMES)
  assert.equal(document.error.properties.ok.const, false)
  for (const tool of document.tools) {
    assert.equal(tool.outputSchema.type, 'object')
  }
})

test('--help prints the usage and the environment variables', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /Usage:/)
  assert.match(stdout, /FEISHU_APP_ID/)
  assert.match(stdout, /FEISHU_BASE_URL/)
  assert.match(stdout, /feishu_send_message/)
  assert.ok(!stdout.includes(APP_SECRET))
})

test('--version prints the package version', async () => {
  const { code, stdout } = await runCli(['--version'])
  assert.equal(code, 0)
  assert.equal(stdout.trim(), PACKAGE.version)
})

test('an unknown option fails without starting the server', async () => {
  const { code, stderr } = await runCli(['--nope'])
  assert.notEqual(code, 0)
  assert.match(stderr, /unknown option/)
})
