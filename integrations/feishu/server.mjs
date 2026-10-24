#!/usr/bin/env node
// MMBOT Feishu connector: an MCP stdio server that lets a Bot read and send Feishu (Lark)
// messages. It speaks MCP 2024-11-05 over newline-delimited JSON-RPC 2.0 on stdio and calls
// the Feishu OpenAPI with Node's built-in fetch, so it has no dependencies of its own.
//
// Environment, all optional except the first two:
//   FEISHU_APP_ID, FEISHU_APP_SECRET   the app credentials
//   FEISHU_BASE_URL                    default https://open.feishu.cn
//   FEISHU_TIMEOUT_MS                  default 15000
//   FEISHU_RETRIES                     retries for a transient failure, default 1
//
// No credential, token or response body is written to a log line or to a tool result.
// Feishu's error message is passed through, so keep the app's permissions narrow.

const SERVER_NAME = 'mmbot-feishu'
const SERVER_VERSION = '0.1.0' // keep in step with package.json
const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_BASE_URL = 'https://open.feishu.cn'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 50
const DEFAULT_RETRIES = 1
const MAX_RETRIES = 3
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const TOKEN_FAILURE_CODES = new Set([99991661, 99991663, 99991664, 99991668])
const RATE_LIMIT_CODES = new Set([230020, 99991400])
const INSTRUCTIONS =
  'Tools for Feishu (Lark): list the chats the bot is in, read a chat\'s history, send a text ' +
  'message, and turn an email or phone number into an open_id. Sending a message needs exactly ' +
  'one of chat_id, open_id or email; list chats first to find a chat_id.'

// --- logging ---------------------------------------------------------------------------

// Values registered here are replaced before anything reaches stderr or a tool result.
const secrets = new Set()

function noteSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value)
}

function redact(text) {
  let out = String(text)
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

function log(message, detail) {
  const line = detail === undefined ? message : `${message}: ${detail}`
  process.stderr.write(`[${SERVER_NAME}] ${redact(line)}\n`)
}

function logFailure(error) {
  if (error instanceof ToolError) log(`error ${error.code}`, redact(error.message))
  else log('error unexpected', redact(error?.message ?? String(error)))
}

// --- errors ----------------------------------------------------------------------------

class ToolError extends Error {
  constructor({ code, message, hint, feishuCode, status, path }) {
    super(message)
    this.name = 'ToolError'
    this.code = code ?? 'internal_error'
    this.hint = hint ?? ''
    this.feishuCode = feishuCode
    this.status = status
    this.path = path
  }

  toJSON() {
    const value = { ok: false, code: this.code, message: this.message, hint: this.hint }
    if (this.feishuCode !== undefined) value.feishu_code = this.feishuCode
    if (this.status !== undefined) value.status = this.status
    if (this.path !== undefined) value.endpoint = this.path
    return value
  }
}

const HINTS = {
  unauthorized:
    'Feishu rejected the app credentials or the token. Check FEISHU_APP_ID and FEISHU_APP_SECRET, ' +
    'and that the app has a published version.',
  permission_denied:
    'The Feishu app is missing a permission scope. Add it in the developer console ' +
    '(im:message, im:message:readonly, im:chat:readonly, contact:user.id:readonly), then publish a ' +
    'new app version.',
  not_in_chat:
    'The bot cannot see this chat. Add the bot to the group chat (or use a chat it already belongs ' +
    'to), then retry.',
  rate_limited: 'Feishu is rate limiting this app. Wait a few seconds before the next call.',
  not_found: 'The chat, message or user was not found. Check the ID; for a chat, the bot must be in it.',
  server_error: 'Feishu returned a server error. Retry later.',
  invalid_request: 'Feishu rejected the arguments. Check them against the tool schema.',
  feishu_error: 'Use feishu_code and endpoint from this result to look the code up in the Feishu docs.',
}

function classify(path, status, feishuCode) {
  if (path.includes('/auth/v3/tenant_access_token')) return 'unauthorized'
  if (status === 401 || TOKEN_FAILURE_CODES.has(feishuCode)) return 'unauthorized'
  if (status === 403 || feishuCode === 99991672 || feishuCode === 230027) return 'permission_denied'
  if (status === 429 || RATE_LIMIT_CODES.has(feishuCode)) return 'rate_limited'
  if (feishuCode === 230002) return 'not_in_chat'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server_error'
  if (status === 400 || status === 422) return 'invalid_request'
  return 'feishu_error'
}

function apiError(failure, { path }) {
  const payload = failure.payload
  const rawCode = payload?.code
  const feishuCode = rawCode === undefined || rawCode === null || rawCode === '' || !Number.isFinite(Number(rawCode))
    ? undefined
    : Number(rawCode)
  const message = String(payload?.msg ?? payload?.message ?? '').trim()
    || firstLine(failure.text)
    || `Feishu answered HTTP ${failure.status}`
  const code = classify(path, failure.status, feishuCode)
  return new ToolError({ code, message, hint: HINTS[code] ?? HINTS.feishu_error, feishuCode, status: failure.status, path })
}

// --- configuration ---------------------------------------------------------------------

function envText(name) {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function credentials() {
  const appId = envText('FEISHU_APP_ID')
  const appSecret = envText('FEISHU_APP_SECRET')
  if (appId === '' || appSecret === '') {
    throw new ToolError({
      code: 'missing_credentials',
      message: 'FEISHU_APP_ID and FEISHU_APP_SECRET are not both set.',
      hint:
        'Set FEISHU_APP_ID and FEISHU_APP_SECRET in the environment of this MCP server (they may ' +
        'be $DSH_SECRET_<NAME> references), then restart it.',
    })
  }
  noteSecret(appSecret)
  return { appId, appSecret }
}

function credentialsConfigured() {
  return envText('FEISHU_APP_ID') !== '' && envText('FEISHU_APP_SECRET') !== ''
}

function baseUrl() {
  const configured = envText('FEISHU_BASE_URL')
  const base = configured === '' ? DEFAULT_BASE_URL : configured.replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(base)
  } catch {
    throw new ToolError({
      code: 'invalid_config',
      message: 'FEISHU_BASE_URL is not a valid URL.',
      hint: 'Use https://open.feishu.cn, or your Lark/Feishu region address.',
    })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ToolError({
      code: 'invalid_config',
      message: 'FEISHU_BASE_URL must start with http:// or https://.',
      hint: 'Use https://open.feishu.cn, or your Lark/Feishu region address.',
    })
  }
  return base
}

function timeoutMs() {
  const value = Number(envText('FEISHU_TIMEOUT_MS'))
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

function retryCount() {
  const text = envText('FEISHU_RETRIES')
  if (text === '') return DEFAULT_RETRIES
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RETRIES
  return Math.min(MAX_RETRIES, Math.floor(value))
}

// --- token cache -----------------------------------------------------------------------
// The token is reused until 5 minutes before it expires, and one refresh runs at a time so
// that parallel tool calls do not fetch several tokens.

const tokenCache = { token: null, expiresAt: 0, pending: null }

function forgetToken() {
  tokenCache.token = null
  tokenCache.expiresAt = 0
}

async function tenantToken() {
  const fresh = tokenCache.token !== null && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS
  if (fresh) return tokenCache.token
  if (tokenCache.pending === null) {
    tokenCache.pending = fetchTenantToken().finally(() => {
      tokenCache.pending = null
    })
  }
  return tokenCache.pending
}

async function fetchTenantToken() {
  const { appId, appSecret } = credentials()
  const payload = await feishuRequest('/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: appId, app_secret: appSecret },
    auth: false,
  })
  const token = typeof payload?.tenant_access_token === 'string' ? payload.tenant_access_token : ''
  if (token === '') {
    throw new ToolError({
      code: 'unauthorized',
      message: 'Feishu did not return a tenant_access_token.',
      hint: HINTS.unauthorized,
    })
  }
  const expireSeconds = Number(payload?.expire)
  const lifetimeMs = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : 7200 * 1000
  noteSecret(token)
  tokenCache.token = token
  tokenCache.expiresAt = Date.now() + lifetimeMs
  return token
}

// --- HTTP ------------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function backoffMs(attempt) {
  return Math.min(1500, 250 * 2 ** (attempt - 1))
}

function firstLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function buildUrl(path, query) {
  const url = new URL(`${baseUrl()}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

function succeeded(payload) {
  if (payload === null || typeof payload !== 'object') return true
  if (!Object.prototype.hasOwnProperty.call(payload, 'code')) return true
  return Number(payload.code) === 0
}

function networkFailure(error, timeout) {
  const name = error?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ToolError({
      code: 'timeout',
      message: `Feishu did not answer within ${timeout} ms.`,
      hint: 'Raise FEISHU_TIMEOUT_MS, or retry when the network is back.',
    })
  }
  const reason = error?.cause?.code ?? error?.code ?? error?.message ?? 'unknown error'
  return new ToolError({
    code: 'network_error',
    message: `Could not reach Feishu: ${firstLine(reason)}`,
    hint: 'Check FEISHU_BASE_URL and the network of the machine that runs the Bot.',
  })
}

async function sendOnce({ url, method, body, token, timeout }) {
  const headers = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  let payloadBody
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    payloadBody = JSON.stringify(body)
  }
  let response
  let text
  try {
    response = await fetch(url, { method, headers, body: payloadBody, signal: AbortSignal.timeout(timeout) })
    text = await response.text()
  } catch (error) {
    return { ok: false, failure: { network: networkFailure(error, timeout) } }
  }
  let payload = null
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  const failure = { status: response.status, payload, text: text.slice(0, 500) }
  if (response.status >= 200 && response.status < 300 && succeeded(payload)) return { ok: true, payload }
  return { ok: false, failure }
}

function isTokenFailure(failure) {
  if (failure.status === 401) return true
  return TOKEN_FAILURE_CODES.has(Number(failure.payload?.code))
}

function isRetryable(failure) {
  if (failure.status === 429 || failure.status === 408) return true
  if (failure.status >= 500 && failure.status <= 599) return true
  return RATE_LIMIT_CODES.has(Number(failure.payload?.code))
}

// One token refresh and a bounded number of retries per call. A timeout is not retried, so
// the worst case stays close to FEISHU_TIMEOUT_MS.
async function feishuRequest(path, { method = 'GET', query, body, auth = true } = {}) {
  const timeout = timeoutMs()
  const retries = retryCount()
  let retried = 0
  let refreshed = false
  for (;;) {
    const token = auth ? await tenantToken() : null
    const outcome = await sendOnce({ url: buildUrl(path, query), method, body, token, timeout })
    if (outcome.ok) return outcome.payload
    const failure = outcome.failure
    if (failure.network !== undefined) {
      if (failure.network.code !== 'timeout' && retried < retries) {
        retried += 1
        await delay(backoffMs(retried))
        continue
      }
      throw failure.network
    }
    if (auth && isTokenFailure(failure) && !refreshed) {
      refreshed = true
      forgetToken()
      log('tenant access token was rejected; fetching a new one')
      continue
    }
    if (isRetryable(failure) && retried < retries) {
      retried += 1
      await delay(backoffMs(retried))
      continue
    }
    throw apiError(failure, { path })
  }
}

// --- tool schemas ----------------------------------------------------------------------

const ERROR_SCHEMA = {
  type: 'object',
  description: 'What a tool returns as an isError result when the call fails.',
  properties: {
    ok: { type: 'boolean', const: false },
    code: {
      type: 'string',
      enum: [
        'invalid_arguments', 'missing_credentials', 'invalid_config', 'timeout', 'network_error',
        'unauthorized', 'permission_denied', 'not_in_chat', 'rate_limited', 'not_found',
        'server_error', 'invalid_request', 'feishu_error', 'internal_error',
      ],
      description: 'A stable code for the failure. Branch on this, not on message.',
    },
    message: { type: 'string', description: "Feishu's own message when it answered." },
    hint: { type: 'string', description: 'What to change before trying again.' },
    feishu_code: { type: 'integer', description: "Feishu's numeric error code, when it sent one." },
    status: { type: 'integer', description: 'HTTP status, when Feishu answered.' },
    endpoint: { type: 'string', description: 'The Feishu API path that failed.' },
  },
  required: ['ok', 'code', 'message', 'hint'],
  additionalProperties: false,
}

const SEND_MESSAGE = {
  name: 'feishu_send_message',
  description:
    'Send a plain text message to a Feishu chat or a person. Give exactly one of chat_id, ' +
    'open_id or email as the target. The bot must be a member of the chat, or the person must ' +
    'be in the bot\'s availability scope.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', minLength: 1, description: 'Chat id (oc_…), for a group or a direct chat.' },
      open_id: { type: 'string', minLength: 1, description: 'User open_id (ou_…) to send a direct message to.' },
      email: { type: 'string', minLength: 1, description: 'User email; Feishu resolves it to the person.' },
      text: { type: 'string', minLength: 1, maxLength: 30000, description: 'The message text.' },
    },
    required: ['text'],
    oneOf: [{ required: ['chat_id'] }, { required: ['open_id'] }, { required: ['email'] }],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    description: 'The sent message.',
    properties: {
      ok: { type: 'boolean', const: true },
      message_id: { type: 'string', description: 'Message id (om_…).' },
      chat_id: { type: 'string', description: 'The chat the message is in.' },
      create_time: { type: 'string', description: 'Feishu create time in milliseconds, as a string.' },
      receive_id_type: { type: 'string', enum: ['chat_id', 'open_id', 'email'] },
      receive_id: { type: 'string' },
    },
    required: ['ok', 'message_id', 'receive_id_type', 'receive_id'],
    additionalProperties: false,
  },
}

const LIST_CHATS = {
  name: 'feishu_list_chats',
  description:
    'List the group and direct chats the bot belongs to, newest first, one page at a time. ' +
    'Use it to find the chat_id that feishu_send_message and feishu_get_chat_history take.',
  inputSchema: {
    type: 'object',
    properties: {
      page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Chats per page.' },
      page_token: { type: 'string', minLength: 1, description: 'page_token of the previous page.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    description: 'One page of chats.',
    properties: {
      ok: { type: 'boolean', const: true },
      chats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            chat_mode: { type: 'string', description: 'group or p2p.' },
            chat_type: { type: 'string' },
            external: { type: 'boolean' },
            owner_id: { type: 'string' },
          },
          required: ['chat_id', 'name', 'chat_mode', 'chat_type', 'external', 'owner_id'],
          additionalProperties: false,
        },
      },
      page_token: { type: 'string', description: 'Empty when this is the last page.' },
      has_more: { type: 'boolean' },
    },
    required: ['ok', 'chats', 'page_token', 'has_more'],
    additionalProperties: false,
  },
}

const GET_CHAT_HISTORY = {
  name: 'feishu_get_chat_history',
  description:
    'Read a chat\'s message history, one page at a time, newest first by default. The bot must ' +
    'be a member of the chat. Message text is flattened into a text field; media becomes a ' +
    'placeholder such as [image].',
  inputSchema: {
    type: 'object',
    properties: {
      container_id: { type: 'string', minLength: 1, description: 'The chat_id (oc_…) to read.' },
      container_id_type: { type: 'string', enum: ['chat'], default: 'chat', description: 'Only chat is supported.' },
      start_time: { type: 'string', minLength: 1, description: 'Oldest message time, in seconds.' },
      end_time: { type: 'string', minLength: 1, description: 'Newest message time, in seconds.' },
      sort_type: {
        type: 'string',
        enum: ['ByCreateTimeAsc', 'ByCreateTimeDesc'],
        default: 'ByCreateTimeDesc',
        description: 'Message order.',
      },
      page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Messages per page.' },
      page_token: { type: 'string', minLength: 1, description: 'page_token of the previous page.' },
    },
    required: ['container_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    description: 'One page of messages, oldest of the page order first.',
    properties: {
      ok: { type: 'boolean', const: true },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            msg_type: { type: 'string', description: 'text, post, image, file, …' },
            create_time: { type: 'string', description: 'Feishu create time in milliseconds, as a string.' },
            sender_id: { type: 'string' },
            sender_type: { type: 'string', description: 'user, app, …' },
            text: { type: 'string', description: 'The message content, flattened to text.' },
            mentions: { type: 'array', items: { type: 'string' }, description: 'Names the message mentions.' },
            deleted: { type: 'boolean' },
          },
          required: ['message_id', 'msg_type', 'create_time', 'sender_id', 'sender_type', 'text', 'mentions', 'deleted'],
          additionalProperties: false,
        },
      },
      page_token: { type: 'string', description: 'Empty when this is the last page.' },
      has_more: { type: 'boolean' },
    },
    required: ['ok', 'messages', 'page_token', 'has_more'],
    additionalProperties: false,
  },
}

const GET_USER = {
  name: 'feishu_get_user',
  description:
    'Turn an email or a mobile number into the user\'s open_id, which feishu_send_message takes. ' +
    'Give exactly one of email and mobile. Entries Feishu cannot match come back in not_found.',
  inputSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', minLength: 1, description: 'The user\'s email address.' },
      mobile: { type: 'string', minLength: 1, description: 'The user\'s mobile number, with country code if needed.' },
    },
    oneOf: [{ required: ['email'] }, { required: ['mobile'] }],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    description: 'The users Feishu matched.',
    properties: {
      ok: { type: 'boolean', const: true },
      users: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            open_id: { type: 'string', description: 'User open_id (ou_…).' },
            email: { type: 'string' },
            mobile: { type: 'string' },
          },
          required: ['open_id', 'email', 'mobile'],
          additionalProperties: false,
        },
      },
      not_found: { type: 'array', items: { type: 'string' }, description: 'The values that matched no user.' },
    },
    required: ['ok', 'users', 'not_found'],
    additionalProperties: false,
  },
}

const TOOLS = [SEND_MESSAGE, LIST_CHATS, GET_CHAT_HISTORY, GET_USER]

// --- argument validation ---------------------------------------------------------------
// The subset of JSON Schema the tool schemas use: object, array, string, integer, boolean,
// required, properties, additionalProperties, oneOf, enum, min/max.

function label(path) {
  return path === '' ? 'arguments' : path
}

function checkValue(schema, value, path) {
  const problems = []
  if (schema === null || typeof schema !== 'object') return problems
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(branch => checkValue(branch, value, path).length === 0)
    if (matches.length !== 1) {
      const names = schema.oneOf.map(branch => (branch.required ?? []).join(' and ')).filter(name => name !== '')
      problems.push(names.length > 0
        ? `exactly one of ${names.join(', ')} is required`
        : 'exactly one of these argument sets is required')
    }
  }
  const isObject = schema.type === 'object' || schema.properties !== undefined || schema.required !== undefined
  if (isObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${label(path)} must be an object`)
      return problems
    }
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
        problems.push(`${path === '' ? name : `${path}.${name}`} is required`)
      }
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) continue
      problems.push(...checkValue(child, value[name], path === '' ? name : `${path}.${name}`))
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, name)) problems.push(`unknown argument ${path === '' ? name : `${path}.${name}`}`)
      }
    }
    return problems
  }
  const type = schema.type
  if (type === 'string') {
    if (typeof value !== 'string') problems.push(`${label(path)} must be a string`)
    else {
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${label(path)} must not be empty`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${label(path)} is longer than ${schema.maxLength} characters`)
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${label(path)} must be one of ${schema.enum.join(', ')}`)
    }
    return problems
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) problems.push(`${label(path)} must be an integer`)
    else {
      if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${label(path)} must be at least ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${label(path)} must be at most ${schema.maximum}`)
    }
    return problems
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${label(path)} must be true or false`)
    return problems
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${label(path)} must be an array`)
      return problems
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${label(path)} needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${label(path)} allows at most ${schema.maxItems} items`)
    if (schema.items !== undefined) {
      value.forEach((item, index) => problems.push(...checkValue(schema.items, item, `${path}[${index}]`)))
    }
  }
  return problems
}

function validateArguments(tool, raw) {
  const args = raw === undefined || raw === null ? {} : raw
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError({
      code: 'invalid_arguments',
      message: 'arguments must be an object',
      hint: 'Call tools/list to see the arguments this tool takes.',
    })
  }
  const problems = checkValue(tool.inputSchema, args, '')
  if (problems.length > 0) {
    throw new ToolError({
      code: 'invalid_arguments',
      message: problems.join('; '),
      hint: 'Call tools/list to see the arguments this tool takes.',
    })
  }
  return args
}

// --- Feishu payload mapping ------------------------------------------------------------

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function nodeText(node) {
  if (node === null || typeof node !== 'object') return ''
  const tag = String(node.tag ?? '')
  if (tag === 'text') return String(node.text ?? '')
  if (tag === 'a') return String(node.text ?? node.href ?? '')
  if (tag === 'at') {
    const name = String(node.user_name ?? node.user_id ?? '')
    return name === '' ? '@' : `@${name}`
  }
  if (tag === 'img') return '[image]'
  if (tag === 'media') return '[video]'
  if (tag === 'emotion') return '[emoji]'
  if (tag === 'code_block') return String(node.text ?? '')
  if (tag === 'hr') return '---'
  return ''
}

function postText(content) {
  const post = content?.content !== undefined ? content : Object.values(content ?? {})[0]
  if (post === null || typeof post !== 'object') return ''
  const title = typeof post.title === 'string' ? post.title : ''
  const paragraphs = Array.isArray(post.content) ? post.content : []
  const lines = paragraphs.map(nodes => (Array.isArray(nodes) ? nodes.map(nodeText).join('') : ''))
  return [title, ...lines].filter(line => line !== '').join('\n')
}

function extractText(message) {
  const type = String(message?.msg_type ?? '')
  const content = parseJson(message?.body?.content) ?? {}
  if (type === 'text') return String(content.text ?? '')
  if (type === 'post') return postText(content)
  if (type === 'system') return String(content.text ?? '[system]')
  const labels = {
    image: '[image]', file: '[file]', audio: '[audio]', media: '[video]', sticker: '[sticker]',
    interactive: '[interactive card]', share_chat: '[shared chat]', share_user: '[shared user]',
    merge_forward: '[merged forward]',
  }
  return labels[type] ?? `[${type || 'unknown'}]`
}

function mapChat(chat) {
  return {
    chat_id: String(chat?.chat_id ?? ''),
    name: String(chat?.name ?? ''),
    description: String(chat?.description ?? ''),
    chat_mode: String(chat?.chat_mode ?? ''),
    chat_type: String(chat?.chat_type ?? ''),
    external: Boolean(chat?.external),
    owner_id: String(chat?.owner_id ?? ''),
  }
}

function mapMessage(message) {
  const mentions = Array.isArray(message?.mentions)
    ? message.mentions.map(mention => String(mention?.name ?? '')).filter(name => name !== '')
    : []
  return {
    message_id: String(message?.message_id ?? ''),
    msg_type: String(message?.msg_type ?? ''),
    create_time: String(message?.create_time ?? ''),
    sender_id: String(message?.sender?.id ?? ''),
    sender_type: String(message?.sender?.sender_type ?? ''),
    text: extractText(message),
    mentions,
    deleted: Boolean(message?.deleted),
  }
}

// --- tool handlers ---------------------------------------------------------------------

function targetOf(args) {
  if (args.chat_id !== undefined) return { receiveIdType: 'chat_id', receiveId: args.chat_id }
  if (args.open_id !== undefined) return { receiveIdType: 'open_id', receiveId: args.open_id }
  return { receiveIdType: 'email', receiveId: args.email }
}

async function sendMessage(args) {
  const target = targetOf(args)
  const payload = await feishuRequest('/open-apis/im/v1/messages', {
    method: 'POST',
    query: { receive_id_type: target.receiveIdType },
    body: {
      receive_id: target.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: args.text }),
    },
  })
  const data = payload?.data ?? {}
  return {
    ok: true,
    message_id: String(data.message_id ?? ''),
    chat_id: String(data.chat_id ?? ''),
    create_time: String(data.create_time ?? ''),
    receive_id_type: target.receiveIdType,
    receive_id: target.receiveId,
  }
}

async function listChats(args) {
  const payload = await feishuRequest('/open-apis/im/v1/chats', {
    query: {
      page_size: args.page_size ?? 20,
      page_token: args.page_token,
      user_id_type: 'open_id',
    },
  })
  const data = payload?.data ?? {}
  return {
    ok: true,
    chats: Array.isArray(data.items) ? data.items.map(mapChat) : [],
    page_token: String(data.page_token ?? ''),
    has_more: Boolean(data.has_more),
  }
}

async function getChatHistory(args) {
  const payload = await feishuRequest('/open-apis/im/v1/messages', {
    query: {
      container_id_type: args.container_id_type ?? 'chat',
      container_id: args.container_id,
      start_time: args.start_time,
      end_time: args.end_time,
      sort_type: args.sort_type ?? 'ByCreateTimeDesc',
      page_size: args.page_size ?? 20,
      page_token: args.page_token,
    },
  })
  const data = payload?.data ?? {}
  return {
    ok: true,
    messages: Array.isArray(data.items) ? data.items.map(mapMessage) : [],
    page_token: String(data.page_token ?? ''),
    has_more: Boolean(data.has_more),
  }
}

async function getUser(args) {
  const byEmail = args.email !== undefined
  const target = byEmail ? args.email : args.mobile
  const body = byEmail ? { emails: [args.email] } : { mobiles: [args.mobile] }
  const payload = await feishuRequest('/open-apis/contact/v3/users/batch_get_id', {
    method: 'POST',
    query: { user_id_type: 'open_id' },
    body,
  })
  const list = Array.isArray(payload?.data?.user_list) ? payload.data.user_list : []
  const users = []
  const notFound = []
  for (const entry of list) {
    if (typeof entry?.user_id === 'string' && entry.user_id !== '') {
      users.push({
        open_id: entry.user_id,
        email: String(entry.email ?? (byEmail ? args.email : '')),
        mobile: String(entry.mobile ?? (byEmail ? '' : args.mobile)),
      })
    } else {
      notFound.push(String(entry?.email ?? entry?.mobile ?? target))
    }
  }
  // Feishu omits an entry it could not match at all.
  if (users.length === 0 && notFound.length === 0) notFound.push(target)
  return { ok: true, users, not_found: notFound }
}

const TOOL_HANDLERS = {
  feishu_send_message: sendMessage,
  feishu_list_chats: listChats,
  feishu_get_chat_history: getChatHistory,
  feishu_get_user: getUser,
}

// --- MCP server ------------------------------------------------------------------------

function rpcError(code, message) {
  const error = new Error(message)
  error.rpcCode = code
  return error
}

function writeMessage(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The client went away; the process exits on stdin end anyway.
  }
}

function toolResult(value, isError) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  if (isError) result.isError = true
  return result
}

async function callTool(params) {
  const name = typeof params?.name === 'string' ? params.name : ''
  const tool = TOOLS.find(candidate => candidate.name === name)
  if (tool === undefined) throw rpcError(-32602, `Unknown tool: ${name || '(none)'}`)
  let args
  try {
    args = validateArguments(tool, params.arguments)
  } catch (error) {
    if (error instanceof ToolError) return toolResult(error.toJSON(), true)
    throw error
  }
  log('tools/call', name)
  try {
    const value = await TOOL_HANDLERS[name](args)
    return toolResult(value, false)
  } catch (error) {
    if (error instanceof ToolError) {
      logFailure(error)
      return toolResult(error.toJSON(), true)
    }
    const wrapped = new ToolError({
      code: 'internal_error',
      message: firstLine(error?.message ?? String(error)) || 'Unexpected error.',
      hint: 'This is a bug in the MMBOT Feishu connector; report the message.',
    })
    logFailure(error)
    return toolResult(wrapped.toJSON(), true)
  }
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') return callTool(params)
  throw rpcError(-32601, `Method not found: ${method}`)
}

async function handleLine(line) {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })
    return
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
  if (typeof message.method !== 'string') {
    if (hasId) writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request' } })
    return
  }
  if (!hasId) return // A notification; notifications/initialized and cancelled need no answer.
  try {
    const result = await dispatch(message.method, message.params)
    writeMessage({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: { code, message: redact(error?.message ?? 'Internal error') },
    })
  }
}

function startServer() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdout.on('error', () => {})
  process.stdin.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      void handleLine(line.replace(/\r$/, ''))
    }
  })
  process.stdin.on('end', () => {
    if (buffer.trim() !== '') void handleLine(buffer)
    buffer = ''
  })
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  log('ready', `${SERVER_NAME} ${SERVER_VERSION} (MCP ${PROTOCOL_VERSION}); credentials ${credentialsConfigured() ? 'set' : 'missing'}`)
}

// --- command line ----------------------------------------------------------------------

function toolsDocument() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    error: ERROR_SCHEMA,
    tools: TOOLS,
  }
}

function usage() {
  return `MMBOT Feishu connector ${SERVER_VERSION}: an MCP stdio server for Feishu (Lark).

Usage:
  node server.mjs                 speak MCP on stdin/stdout (how DSH starts it)
  node server.mjs --print-tools   print the tool list and schemas as JSON, then exit
  node server.mjs --help          print this text, then exit
  node server.mjs --version       print the version, then exit

Environment:
  FEISHU_APP_ID       Feishu app id, from the app's credentials page (required)
  FEISHU_APP_SECRET   Feishu app secret (required; never logged)
  FEISHU_BASE_URL     API base, default ${DEFAULT_BASE_URL}
  FEISHU_TIMEOUT_MS   per-request timeout, default ${DEFAULT_TIMEOUT_MS}
  FEISHU_RETRIES      retries after a transient failure, default ${DEFAULT_RETRIES} (0-${MAX_RETRIES})

Tools: ${TOOLS.map(tool => tool.name).join(', ')}

The server never prints a credential or a token. Feishu errors come back as tool results
{ ok: false, code, message, hint }; see README.md for the error codes.
`
}

const argv = process.argv.slice(2)
const wantsHelp = argv.includes('--help') || argv.includes('-h')
const wantsTools = argv.includes('--print-tools')
const wantsVersion = argv.includes('--version') || argv.includes('-V')
const unknown = argv.filter(argument => argument.startsWith('-') && !['--help', '-h', '--print-tools', '--version', '-V'].includes(argument))

if (wantsHelp) {
  process.stdout.write(usage())
} else if (wantsTools) {
  process.stdout.write(`${JSON.stringify(toolsDocument(), null, 2)}\n`)
} else if (wantsVersion) {
  process.stdout.write(`${SERVER_VERSION}\n`)
} else if (unknown.length > 0) {
  process.stderr.write(`${SERVER_NAME}: unknown option ${unknown.join(', ')}\n`)
  process.exit(2)
} else {
  startServer()
}
