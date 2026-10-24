#!/usr/bin/env node
// MMBOT 离线部署自检：配置文件、Web 端口、模型网关 /models、插件版本。
//
// 用法：node deploy/check.mjs [--dry-run] [--json] [--env <file>] [--timeout <ms>] [--skip <id,...>]
// 退出码：0 = 全部通过；1 = 有失败项；2 = 用法错误。
// 只依赖 Node.js 18+ 内置模块（需要全局 fetch），不需要 npm install，也不访问除本机与
// MMBOT_GATEWAY_BASE_URL 之外的地址。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SELF_DIR)
const DEFAULT_ENV_PATH = join(SELF_DIR, '.env')
const DEFAULT_PORT = 3080
const DEFAULT_TIMEOUT = 5000
const MAX_TIMEOUT = 60000
const REQUIRED_GATEWAY_KEYS = ['MMBOT_GATEWAY_BASE_URL', 'MMBOT_GATEWAY_API_KEY', 'MMBOT_MODEL_ID']

export function usage() {
  return `MMBOT 部署自检（deployment self-check）

用法：node deploy/check.mjs [选项]

选项：
  --dry-run           只打印将要执行的检查与解析出的配置，不联网、不读数据卷
  --json              机器可读输出（stdout 只输出一个 JSON 对象）
  --env <file>        配置文件路径（默认 deploy/.env）
  --timeout <ms>      单次网络请求超时，默认 ${DEFAULT_TIMEOUT}，上限 ${MAX_TIMEOUT}
  --skip <id,...>     跳过指定检查，可选 id：env, port, gateway, plugin
  -h, --help          显示本帮助

退出码：0 全部通过；1 有失败项；2 用法错误。

检查项：
  env       deploy/.env 是否存在，模型网关与模型配置是否填全
  port      本机能否访问 MMBOT_PORT（默认 ${DEFAULT_PORT}，按 MMBOT_BIND_ADDRESS 选择探测地址）
  gateway   GET \${MMBOT_GATEWAY_BASE_URL}/models 是否连通，且返回列表包含 MMBOT_MODEL_ID
  plugin    DATA_DIR/profiles/web 下已安装的 ds-bot 版本与仓库 ds-bot/package.json 是否一致

需要 Node.js 18+（依赖全局 fetch）。离线主机没有 Node.js 时，可用 README 里的 curl 命令替代。
`
}

/**
 * 解析 KEY=VALUE 形式的 .env，规则与 docker compose 读取 .env 一致：忽略空行与 # 注释，
 * 去掉可选的 export 前缀与成对引号，值后面的空白加 # 视为行内注释。
 */
export function parseEnvFile(text) {
  const values = {}
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    const quoted = /^(['"])([\s\S]*)\1$/u.exec(value)
    if (quoted === null) {
      value = value.replace(/\s+#.*$/u, '').trim()
    } else {
      value = quoted[2]
    }
    values[match[1]] = value
  }
  return values
}

/** 网关的模型列表地址；base_url 末尾的 / 会被去掉，因此 /v1 与 /v1/ 都得到 /v1/models。 */
export function gatewayModelsUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/u, '')
  return `${base}/models`
}

/** 模型列表里的 id，兼容 { data: [...] }、{ models: [...] } 与直接数组三种形状。 */
export function modelIds(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : []
  return list
    .map(item => (typeof item === 'string' ? item : item?.id))
    .filter(id => typeof id === 'string' && id !== '')
}

export function maskSecret(value) {
  return value === undefined || value === '' ? '' : '***'
}

/** 读取配置并按 compose 的语义解析相对路径（相对 deploy/，即 compose 文件所在目录）。 */
export function readConfig(envPath = DEFAULT_ENV_PATH) {
  const envExists = existsSync(envPath)
  const env = envExists ? parseEnvFile(readFileSync(envPath, 'utf8')) : {}
  const rawPort = String(env.MMBOT_PORT ?? '').trim()
  const parsedPort = rawPort === '' ? DEFAULT_PORT : Number(rawPort)
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null
  const rawBind = String(env.MMBOT_BIND_ADDRESS ?? '').trim()
  const probeHost = rawBind === '' || rawBind === '0.0.0.0' || rawBind === '::' ? '127.0.0.1' : rawBind
  const rawDataDir = String(env.DATA_DIR ?? './data').trim() || './data'
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(SELF_DIR, rawDataDir)
  return {
    envPath,
    envExists,
    env,
    port,
    probeHost,
    baseUrl: String(env.MMBOT_GATEWAY_BASE_URL ?? '').trim(),
    apiKey: String(env.MMBOT_GATEWAY_API_KEY ?? ''),
    model: String(env.MMBOT_MODEL_ID ?? '').trim(),
    dataDir,
  }
}

const ok = message => ({ status: 'pass', message })
const failed = (message, hint = '') => ({ status: 'fail', message, hint })
const snippet = text => {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}
const describeError = error => error?.cause?.code || error?.cause?.message || error?.name || error?.message || '未知错误'

function checkEnv(config) {
  if (!config.envExists) {
    return failed(`找不到配置文件 ${config.envPath}`, '执行 deploy/install.sh 生成配置，或 cp deploy/.env.example deploy/.env 后填写')
  }
  const missing = REQUIRED_GATEWAY_KEYS.filter(key => String(config.env[key] ?? '').trim() === '')
  if (config.port === null) missing.push('MMBOT_PORT（必须是 1-65535 的端口号）')
  if (missing.length > 0) {
    return failed(`缺少或无效的配置项：${missing.join('、')}`, `填写 ${config.envPath} 后重试；网关密钥与模型 id 必填`)
  }
  return ok(`配置完整（${config.envPath}）`)
}

async function checkPort(config, options) {
  if (config.port === null) return failed('MMBOT_PORT 无效，无法探测端口', '把 MMBOT_PORT 改成 1-65535 的端口号')
  const url = `http://${config.probeHost}:${config.port}/`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeout) })
    await response.arrayBuffer()
    return ok(`GET ${url} → HTTP ${response.status}`)
  } catch (error) {
    return failed(
      `无法访问 ${url}（${describeError(error)}）`,
      '确认容器在运行：docker compose -f deploy/compose.offline.yml ps；端口被占用时改 deploy/.env 的 MMBOT_PORT',
    )
  }
}

async function checkGateway(config, options) {
  if (config.baseUrl === '') return failed('MMBOT_GATEWAY_BASE_URL 为空，无法检查网关', '按 .env.example 的注释填写网关地址，需以 /v1 结尾')
  const url = gatewayModelsUrl(config.baseUrl)
  const headers = config.apiKey === '' ? {} : { Authorization: `Bearer ${config.apiKey}` }
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(options.timeout) })
    const text = await response.text()
    if (!response.ok) {
      return failed(
        `GET ${url} → HTTP ${response.status}（${snippet(text)}）`,
        '检查 MMBOT_GATEWAY_BASE_URL 是否以 /v1 结尾、MMBOT_GATEWAY_API_KEY 是否有效；容器内访问宿主机网关用 host.docker.internal',
      )
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return failed(`GET ${url} 返回的不是 JSON（${snippet(text)}）`, '确认网关实现了 OpenAI 兼容的 GET /v1/models')
    }
    const ids = modelIds(body)
    if (ids.length === 0) {
      return failed(`GET ${url} 返回的模型列表为空（${snippet(text)}）`, '在网关上为这枚密钥开启至少一个模型')
    }
    if (config.model !== '' && !ids.includes(config.model)) {
      return failed(
        `返回的 ${ids.length} 个模型里没有 ${config.model}（例如：${ids.slice(0, 5).join('、')}）`,
        'MMBOT_MODEL_ID 必须与 /models 返回的 id 完全一致，注意大小写与版本后缀',
      )
    }
    return ok(`GET ${url} → HTTP ${response.status}，${ids.length} 个模型${config.model === '' ? '' : `，包含 ${config.model}`}`)
  } catch (error) {
    return failed(
      `无法访问 ${url}（${describeError(error)}）`,
      '确认网关地址从本机可达；网关跑在宿主机时容器内地址用 host.docker.internal，宿主机自检可用 127.0.0.1',
    )
  }
}

function readVersion(manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

function checkPlugin(config) {
  const installedManifest = join(config.dataDir, 'profiles', 'web', 'node_modules', 'ds-bot', 'package.json')
  const repoManifest = join(REPO_ROOT, 'ds-bot', 'package.json')

  if (!existsSync(installedManifest)) {
    return failed(
      `未找到已安装的插件：${installedManifest}`,
      '数据卷尚未初始化：先 docker compose -f deploy/compose.offline.yml up -d，等日志出现 dsh web: 后再自检',
    )
  }
  const installed = readVersion(installedManifest)
  if (installed === '') {
    return failed(`无法读取插件版本：${installedManifest}`, '数据卷可能损坏；删除 DATA_DIR/profiles/web 后重启容器重建 profile')
  }
  const repo = existsSync(repoManifest) ? readVersion(repoManifest) : ''
  if (repo !== '' && repo !== installed) {
    return failed(
      `已安装插件 ${installed} 与仓库 ds-bot/package.json 的 ${repo} 不一致`,
      '重启容器会按镜像内的归档重装插件；仍不一致时确认 deploy/.env 的 MMBOT_IMAGE 与离线包版本相同',
    )
  }
  const stamp = join(config.dataDir, '.ds-bot-image.sha256')
  const stampNote = existsSync(stamp) ? '' : '；缺少归档标记，首次启动可能未完成'
  return ok(`插件 ${installed}${repo === '' ? '（未找到仓库清单，跳过对比）' : '（与仓库一致）'}${stampNote}`)
}

const CHECKS = [
  { id: 'env', title: '配置文件', plan: config => `检查 ${config.envPath} 是否存在并包含 ${REQUIRED_GATEWAY_KEYS.join('、')}`, run: checkEnv },
  { id: 'port', title: 'Web 端口', plan: config => `GET http://${config.probeHost}:${config.port ?? '?'}/`, run: checkPort },
  { id: 'gateway', title: '模型网关', plan: config => `GET ${gatewayModelsUrl(config.baseUrl || '<MMBOT_GATEWAY_BASE_URL>')}（Bearer ${maskSecret(config.apiKey) === '' ? '未设置' : '已设置'}）`, run: checkGateway },
  { id: 'plugin', title: '插件版本', plan: config => `读取 ${join(config.dataDir, 'profiles', 'web', 'node_modules', 'ds-bot', 'package.json')} 并与仓库比较`, run: checkPlugin },
]

function usageError(message) {
  return Object.assign(new Error(message), { usage: true })
}

function parseArgs(argv) {
  const options = {
    envPath: DEFAULT_ENV_PATH,
    timeout: DEFAULT_TIMEOUT,
    dryRun: false,
    json: false,
    help: false,
    skip: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--env') {
      const value = argv[index + 1]
      index += 1
      if (value === undefined || value === '' || value.startsWith('--')) throw usageError('--env 需要一个文件路径')
      options.envPath = resolve(value)
    } else if (arg.startsWith('--env=')) {
      options.envPath = resolve(arg.slice('--env='.length))
    } else if (arg === '--timeout') {
      const value = argv[index + 1]
      index += 1
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) throw usageError('--timeout 需要正整数毫秒数')
      options.timeout = Math.min(parsed, MAX_TIMEOUT)
    } else if (arg.startsWith('--timeout=')) {
      const parsed = Number(arg.slice('--timeout='.length))
      if (!Number.isFinite(parsed) || parsed <= 0) throw usageError('--timeout 需要正整数毫秒数')
      options.timeout = Math.min(parsed, MAX_TIMEOUT)
    } else if (arg === '--skip') {
      const value = argv[index + 1]
      index += 1
      if (value === undefined) throw usageError('--skip 需要检查 id，例如 --skip gateway')
      options.skip = value.split(',').map(item => item.trim()).filter(item => item !== '')
    } else if (arg.startsWith('--skip=')) {
      options.skip = arg.slice('--skip='.length).split(',').map(item => item.trim()).filter(item => item !== '')
    } else {
      throw usageError(`未知参数：${arg}`)
    }
  }
  const known = new Set(CHECKS.map(check => check.id))
  const unknown = options.skip.filter(id => !known.has(id))
  if (unknown.length > 0) throw usageError(`未知的检查 id：${unknown.join('、')}（可选：${[...known].join('、')}）`)
  return options
}

function selectedChecks(options) {
  return CHECKS.filter(check => !options.skip.includes(check.id))
}

function publicConfig(config) {
  return {
    envPath: config.envPath,
    envExists: config.envExists,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: maskSecret(config.apiKey),
    port: config.port,
    probeHost: config.probeHost,
    dataDir: config.dataDir,
  }
}

function printDryRun(config, options) {
  const checks = selectedChecks(options)
  if (options.json) {
    console.log(JSON.stringify({ dryRun: true, config: publicConfig(config), checks: checks.map(check => ({ id: check.id, title: check.title, plan: check.plan(config) })) }, null, 2))
    return
  }
  console.log('MMBOT 部署自检（dry-run：不联网、不读写数据卷）')
  console.log(`配置文件：${config.envPath}（${config.envExists ? '存在' : '不存在'}）`)
  for (const check of checks) {
    console.log(`  [dry-run] ${check.id.padEnd(7)} ${check.title}：${check.plan(config)}`)
  }
  console.log('提示：去掉 --dry-run 执行真实检查；检查项可用 --skip 跳过。')
}

async function main(argv) {
  if (typeof fetch !== 'function') {
    console.error('error: 需要 Node.js 18+（缺少全局 fetch）')
    return 2
  }
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`error: ${error.message}`)
    console.error('')
    console.error(usage())
    return 2
  }
  if (options.help) {
    console.log(usage())
    return 0
  }

  const config = readConfig(options.envPath)
  if (options.dryRun) {
    printDryRun(config, options)
    return 0
  }

  const checks = selectedChecks(options)
  const results = []
  for (const check of checks) {
    let result
    try {
      result = await check.run(config, options)
    } catch (error) {
      result = failed(`检查异常：${error?.message ?? error}`, '')
    }
    results.push({ id: check.id, title: check.title, ...result })
  }

  const failures = results.filter(result => result.status !== 'pass')
  if (options.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, config: publicConfig(config), checks: results }, null, 2))
    return failures.length === 0 ? 0 : 1
  }

  console.log('MMBOT 部署自检')
  console.log(`配置文件：${config.envPath}`)
  console.log('')
  for (const result of results) {
    const tag = result.status === 'pass' ? '[PASS]' : '[FAIL]'
    console.log(`${tag} ${result.title}：${result.message}`)
    if (result.hint) console.log(`       → ${result.hint}`)
  }
  console.log('')
  if (failures.length === 0) {
    console.log(`结果：${results.length} 项全部通过。`)
    return 0
  }
  console.log(`结果：${results.length - failures.length} 项通过，${failures.length} 项失败。`)
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(`error: ${error?.stack ?? error}`)
    process.exitCode = 2
  })
}
