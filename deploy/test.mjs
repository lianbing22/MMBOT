#!/usr/bin/env node
// deploy/ 的离线测试：不需要 Docker 守护进程、不起容器、不访问外部网络。
//
//   node --test deploy/test.mjs
//   node deploy/test.mjs
//
// 覆盖：
//   - deploy/check.mjs 的 --help、--dry-run（不联网）、--json、真实通过/失败路径与退出码
//   - deploy/install.sh 的静态校验、--help 与 --dry-run（不调用 docker、不写文件）
//   - deploy/compose.offline.yml 与 deploy/.env.example 的变量一致性
//   - deploy/README*.md 的关键章节

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const deployDir = join(repoRoot, 'deploy')
const checkScript = join(deployDir, 'check.mjs')
const installScript = join(deployDir, 'install.sh')
const composeFile = join(deployDir, 'compose.offline.yml')
const envExample = join(deployDir, '.env.example')
const pluginVersion = JSON.parse(readFileSync(join(repoRoot, 'ds-bot', 'package.json'), 'utf8')).version

const { parseEnvFile, gatewayModelsUrl, modelIds, maskSecret } = await import(pathToFileURL(checkScript).href)

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function tempDir(t, prefix = 'mmbot-deploy-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeEnvFile(dir, values) {
  const path = join(dir, '.env')
  writeFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
  return path
}

// 一个只服务本机回环的假网关 + 假 Web 首页，让通过路径也能被测试。
async function startFakeStack(t, { models = ['deepseek-chat', 'qwen-max'] } = {}) {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: models.map(id => ({ id })) }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<title>MMBOT</title>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { server, port: server.address().port }
}

function writeInstalledPlugin(dataDir, version = pluginVersion) {
  const manifestDir = join(dataDir, 'profiles', 'web', 'node_modules', 'ds-bot')
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({ name: 'ds-bot', version }))
  writeFileSync(join(dataDir, '.ds-bot-image.sha256'), 'test-stamp\n')
}

test('parseEnvFile follows the .env rules docker compose uses', () => {
  const parsed = parseEnvFile([
    '# comment',
    '',
    'MMBOT_PORT=3080',
    'export MMBOT_MODEL_ID="deepseek-chat"',
    "MMBOT_MODEL_NAME='DeepSeek Chat'",
    'MMBOT_GATEWAY_BASE_URL=http://127.0.0.1:4000/v1   # 行内注释',
    'not a valid line',
    'EMPTY=',
  ].join('\n'))
  assert.equal(parsed.MMBOT_PORT, '3080')
  assert.equal(parsed.MMBOT_MODEL_ID, 'deepseek-chat')
  assert.equal(parsed.MMBOT_MODEL_NAME, 'DeepSeek Chat')
  assert.equal(parsed.MMBOT_GATEWAY_BASE_URL, 'http://127.0.0.1:4000/v1')
  assert.equal(parsed.EMPTY, '')
  assert.equal(Object.hasOwn(parsed, 'not a valid line'), false)
})

test('gatewayModelsUrl joins /v1 with and without a trailing slash', () => {
  assert.equal(gatewayModelsUrl('http://gw:4000/v1'), 'http://gw:4000/v1/models')
  assert.equal(gatewayModelsUrl('http://gw:4000/v1/'), 'http://gw:4000/v1/models')
  assert.equal(gatewayModelsUrl(' https://gw.example/openai/v1/// '), 'https://gw.example/openai/v1/models')
})

test('modelIds accepts the shapes OpenAI-compatible gateways return', () => {
  assert.deepEqual(modelIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(modelIds({ models: ['a', { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(modelIds(['a']), ['a'])
  assert.deepEqual(modelIds({}), [])
  assert.deepEqual(modelIds(null), [])
})

test('maskSecret never returns the value', () => {
  assert.equal(maskSecret('sk-secret-value'), '***')
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret(undefined), '')
})

test('check.mjs --help documents usage and exits 0', async () => {
  const result = await run(process.execPath, [checkScript, '--help'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /--dry-run/u)
  assert.match(result.stdout, /--json/u)
  assert.match(result.stdout, /退出码/u)
})

test('check.mjs --dry-run plans every check without touching the network', async () => {
  const started = Date.now()
  const result = await run(process.execPath, [checkScript, '--dry-run', '--env', join(tmpdir(), 'mmbot-no-such-env')])
  assert.equal(result.code, 0, result.stderr)
  for (const id of ['env', 'port', 'gateway', 'plugin']) assert.match(result.stdout, new RegExp(id, 'u'))
  assert.match(result.stdout, /dry-run/u)
  // 校验没有真的发请求：默认超时是 5s，这里远小于它。
  assert.ok(Date.now() - started < 5000, 'dry-run 不应等待网络')
})

test('check.mjs --dry-run --json emits one parseable JSON object', async () => {
  const result = await run(process.execPath, [checkScript, '--dry-run', '--json'])
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.checks.length, 4)
  assert.equal(parsed.config.apiKey, '')
})

test('check.mjs returns 2 on a usage error', async () => {
  const result = await run(process.execPath, [checkScript, '--nope'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /未知参数/u)

  const unknownSkip = await run(process.execPath, [checkScript, '--skip', 'nothing'])
  assert.equal(unknownSkip.code, 2)
  assert.match(unknownSkip.stderr, /未知的检查 id/u)
})

test('check.mjs passes against a reachable local stack and installed plugin', async t => {
  const { port } = await startFakeStack(t)
  const dir = tempDir(t)
  const dataDir = join(dir, 'data')
  writeInstalledPlugin(dataDir)
  const envPath = writeEnvFile(dir, {
    MMBOT_IMAGE: 'ds-bot:local',
    MMBOT_PORT: String(port),
    MMBOT_BIND_ADDRESS: '127.0.0.1',
    MMBOT_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    MMBOT_GATEWAY_API_KEY: 'test-key',
    MMBOT_MODEL_ID: 'deepseek-chat',
    DATA_DIR: dataDir,
  })
  const result = await run(process.execPath, [checkScript, '--env', envPath])
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /4 项全部通过/u)
  assert.match(result.stdout, /包含 deepseek-chat/u)
  assert.doesNotMatch(result.stdout, /test-key/u)
})

test('check.mjs fails with exit code 1 and names each broken check', async t => {
  const { port } = await startFakeStack(t, { models: ['qwen-max'] })
  const dir = tempDir(t)
  const dataDir = join(dir, 'data')
  writeInstalledPlugin(dataDir, '9.9.9')
  const envPath = writeEnvFile(dir, {
    MMBOT_PORT: '1',
    MMBOT_BIND_ADDRESS: '127.0.0.1',
    MMBOT_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    MMBOT_GATEWAY_API_KEY: 'test-key',
    MMBOT_MODEL_ID: 'deepseek-chat',
    DATA_DIR: dataDir,
  })
  const result = await run(process.execPath, [checkScript, '--env', envPath, '--timeout', '1000'])
  assert.equal(result.code, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /Web 端口/u)
  assert.match(result.stdout, /没有 deepseek-chat/u)
  assert.match(result.stdout, /不一致/u)
})

test('check.mjs reports a missing .env instead of crashing', async t => {
  const dir = tempDir(t)
  const result = await run(process.execPath, [checkScript, '--env', join(dir, 'missing.env'), '--skip', 'port,gateway'])
  assert.equal(result.code, 1)
  assert.match(result.stdout, /找不到配置文件/u)
})

test('check.mjs --json stays machine readable and masks the key', async t => {
  const { port } = await startFakeStack(t)
  const dir = tempDir(t)
  const dataDir = join(dir, 'data')
  writeInstalledPlugin(dataDir)
  const envPath = writeEnvFile(dir, {
    MMBOT_PORT: String(port),
    MMBOT_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    MMBOT_GATEWAY_API_KEY: 'super-secret',
    MMBOT_MODEL_ID: 'deepseek-chat',
    DATA_DIR: dataDir,
  })
  const result = await run(process.execPath, [checkScript, '--env', envPath, '--json'])
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.apiKey, '***')
  assert.equal(parsed.checks.every(check => check.status === 'pass'), true)
})

test('install.sh passes bash syntax check and documents its commands', () => {
  const syntax = spawnSync('bash', ['-n', installScript], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const text = readFileSync(installScript, 'utf8')
  assert.match(text, /^#!\/usr\/bin\/env bash/u)
  assert.match(text, /set -euo pipefail/u)
  for (const command of ['prepare', 'load', 'config', 'check']) assert.match(text, new RegExp(`\\b${command}\\b`, 'u'))

  const help = spawnSync('bash', [installScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--dry-run/u)
  assert.match(help.stdout, /--without-secrets/u)
})

test('install.sh --dry-run prints the pipeline without calling docker or writing files', async t => {
  const marker = join(tempDir(t), 'docker-was-called')
  const binDir = join(tempDir(t), 'bin')
  mkdirSync(binDir, { recursive: true })
  const fakeDocker = join(binDir, 'docker')
  writeFileSync(fakeDocker, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`)
  chmodSync(fakeDocker, 0o755)

  const envBefore = existsSync(join(deployDir, '.env'))
  const dataBefore = existsSync(join(deployDir, 'data'))
  const offlineBefore = existsSync(join(deployDir, 'offline'))

  const result = await run('bash', [installScript, '--dry-run'], {
    env: { PATH: `${binDir}:${process.env.PATH}`, MMBOT_DRY_RUN_MARKER: marker },
  })
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /docker build/u)
  assert.match(result.stdout, /docker save/u)
  assert.match(result.stdout, /mmbot-offline/u)
  assert.equal(existsSync(marker), false, 'dry-run must not call docker')
  if (!envBefore) assert.equal(existsSync(join(deployDir, '.env')), false, 'dry-run must not create deploy/.env')
  if (!dataBefore) assert.equal(existsSync(join(deployDir, 'data')), false, 'dry-run must not create deploy/data')
  if (!offlineBefore) assert.equal(existsSync(join(deployDir, 'offline')), false, 'dry-run must not create deploy/offline')
})

test('install.sh --dry-run load verifies the archive path without writing', async t => {
  const result = await run('bash', [installScript, 'load', '--dry-run'])
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /docker load|在 .*offline\/images 下查找/u)
})

test('compose.offline.yml only uses variables documented in .env.example', () => {
  const compose = readFileSync(composeFile, 'utf8')
  const example = readFileSync(envExample, 'utf8')
  const documented = new Set(Object.keys(parseEnvFile(example)))
  const used = new Set([...compose.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/gu)].map(match => match[1]))
  const missing = [...used].filter(name => !documented.has(name))
  assert.deepEqual(missing, [], `compose 使用但 .env.example 未说明：${missing.join(', ')}`)
})

test('compose.offline.yml never pulls images and keeps the proxy optional', () => {
  const compose = readFileSync(composeFile, 'utf8')
  assert.match(compose, /^name: mmbot$/mu)
  assert.doesNotMatch(compose, /^\s{4}build:/mu, 'offline compose 不应在离线主机上构建镜像')
  assert.match(compose, /pull_policy: never/u)
  assert.match(compose, /profiles: \["proxy"\]/u)
  assert.match(compose, /proxy_set_header|MMBOT_TLS_DIR/u)
  const proxyConfig = readFileSync(join(deployDir, 'proxy', 'nginx.conf'), 'utf8')
  assert.match(proxyConfig, /proxy_set_header Host \$host;/u)
  assert.match(proxyConfig, /proxy_buffering off;/u)
})

test('deploy READMEs cover the documented deployment topics', () => {
  const zh = readFileSync(join(deployDir, 'README.zh.md'), 'utf8')
  const en = readFileSync(join(deployDir, 'README.md'), 'utf8')
  for (const topic of ['前置条件', '离线', '模型网关', '备份', '反向代理', 'TLS', '升级', '回滚', '故障排查']) {
    assert.match(zh, new RegExp(topic, 'u'), `README.zh.md 缺少「${topic}」章节`)
  }
  assert.match(en, /Quick start/u)
  assert.match(en, /README\.zh\.md/u)
})

test('docker compose can parse compose.offline.yml when docker is available', t => {
  const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (available.status !== 0) {
    t.skip('docker compose 不可用，跳过编排解析测试')
    return
  }
  const result = spawnSync('docker', ['compose', '-f', composeFile, 'config', '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
  assert.equal(result.status, 0, result.stderr)
})
