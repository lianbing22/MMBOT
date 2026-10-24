import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkTemplate, checkDirectory } from './check-templates.mjs'

const good = {
  name: '演示团队', industry: '制造', description: '用于测试的完整模板',
  bots: [{ name: '主管', role: '协调', instructions: 'x'.repeat(200) }],
  groups: [{ name: '总群', members: ['主管'], purpose: '日常协同' }],
  starterPrompts: ['开始干活'],
}

test('完整模板通过校验', () => {
  assert.deepEqual(checkTemplate(good), [])
})

test('缺失必填字段被逐项指出', () => {
  const errors = checkTemplate({ bots: [] }, 'bad.json')
  assert.ok(errors.some((e) => e.includes('name 缺失')))
  assert.ok(errors.some((e) => e.includes('industry 缺失')))
  assert.ok(errors.some((e) => e.includes('bots 必须是非空数组')))
})

test('Bot 重名、instructions 过短、可选 model 校验', () => {
  const errors = checkTemplate({
    ...good,
    bots: [
      { name: '主管', role: 'a', instructions: '太短' },
      { name: '主管', role: 'b', instructions: 'y'.repeat(200), model: ' ' },
    ],
  }, 'bad.json')
  assert.ok(errors.some((e) => e.includes('name 重复')))
  assert.ok(errors.some((e) => e.includes('instructions 过短')))
  assert.ok(errors.some((e) => e.includes('model 若提供')))
})

test('群成员引用不存在的 Bot 会被指出', () => {
  const errors = checkTemplate({
    ...good,
    groups: [{ name: '总群', members: ['主管', '幽灵'], purpose: 'x' }],
  }, 'bad.json')
  assert.ok(errors.some((e) => e.includes('成员 幽灵 不在 bots 里')))
})

test('starterPrompts 为空被拒绝', () => {
  const errors = checkTemplate({ ...good, starterPrompts: [] }, 'bad.json')
  assert.ok(errors.some((e) => e.includes('starterPrompts')))
})

test('checkDirectory 汇总文件与错误，坏 JSON 不中断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'))
  try {
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(good))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...good, bots: [{ name: '', role: 'x', instructions: 'y'.repeat(200) }] }))
    const { files, errors } = checkDirectory(dir)
    assert.equal(files.length, 3)
    assert.ok(errors.some((e) => e.includes('JSON 解析失败')))
    assert.ok(errors.some((e) => e.includes('bots[0] name 缺失')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('仓库自带模板全部通过', () => {
  const { errors } = checkDirectory(new URL('../templates/', import.meta.url).pathname)
  assert.deepEqual(errors, [])
})
