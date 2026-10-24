#!/usr/bin/env node
// 校验 templates/ 下的行业模板：结构完整、命名唯一、引用有效。
// 用法：node scripts/check-templates.mjs [模板目录，默认 templates]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIN_INSTRUCTIONS = 120

/** @returns {string[]} 错误列表；空数组表示通过 */
export function checkTemplate(data, label = 'template') {
  const errors = []
  const at = (path) => `${label}: ${path}`
  const str = (v) => typeof v === 'string' && v.trim().length > 0

  if (!data || typeof data !== 'object' || Array.isArray(data)) return [at('应为 JSON 对象')]
  for (const field of ['name', 'industry', 'description']) {
    if (!str(data[field])) errors.push(at(`${field} 缺失或为空`))
  }
  if (!Array.isArray(data.bots) || data.bots.length === 0) {
    errors.push(at('bots 必须是非空数组'))
    return errors
  }
  if (data.bots.length > 20) errors.push(at(`bots 数量 ${data.bots.length} 超过上限 20`))

  const names = new Set()
  data.bots.forEach((bot, i) => {
    const at2 = (path) => at(`bots[${i}] ${path}`)
    if (!bot || typeof bot !== 'object') { errors.push(at2('应为对象')); return }
    if (!str(bot.name)) errors.push(at2('name 缺失或为空'))
    else if (names.has(bot.name)) errors.push(at2(`name 重复：${bot.name}`))
    else names.add(bot.name)
    if (!str(bot.role)) errors.push(at2('role 缺失或为空'))
    if (!str(bot.instructions)) errors.push(at2('instructions 缺失或为空'))
    else if (bot.instructions.trim().length < MIN_INSTRUCTIONS)
      errors.push(at2(`instructions 过短（${bot.instructions.trim().length} < ${MIN_INSTRUCTIONS} 字），应当是可直接使用的提示词`))
    if (bot.model !== undefined && !str(bot.model)) errors.push(at2('model 若提供必须是非空字符串'))
  })

  if (!Array.isArray(data.groups)) errors.push(at('groups 必须是数组'))
  else data.groups.forEach((group, i) => {
    const at2 = (path) => at(`groups[${i}] ${path}`)
    if (!group || typeof group !== 'object') { errors.push(at2('应为对象')); return }
    if (!str(group.name)) errors.push(at2('name 缺失或为空'))
    if (!str(group.purpose)) errors.push(at2('purpose 缺失或为空'))
    if (!Array.isArray(group.members) || group.members.length === 0) errors.push(at2('members 必须是非空数组'))
    else for (const m of group.members) {
      if (typeof m !== 'string') { errors.push(at2(`成员应为字符串：${JSON.stringify(m)}`)); continue }
      if (!names.has(m)) errors.push(at2(`成员 ${m} 不在 bots 里`))
    }
  })

  if (!Array.isArray(data.starterPrompts) || data.starterPrompts.length === 0) {
    errors.push(at('starterPrompts 必须是非空数组'))
  } else data.starterPrompts.forEach((p, i) => {
    if (!str(p)) errors.push(at(`starterPrompts[${i}] 为空`))
  })
  return errors
}

export function checkDirectory(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) return { files: [], errors: [`${dir}: 目录下没有模板 JSON`] }
  const errors = []
  for (const file of files) {
    const full = join(dir, file)
    let data
    try {
      data = JSON.parse(readFileSync(full, 'utf8'))
    } catch (error) {
      errors.push(`${file}: JSON 解析失败（${error.message}）`)
      continue
    }
    errors.push(...checkTemplate(data, file))
  }
  return { files, errors }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'templates'
  const { files, errors } = checkDirectory(dir)
  for (const error of errors) console.error(`✗ ${error}`)
  console.log(`templates: ${files.length} 个文件，${errors.length} 个问题`)
  process.exit(errors.length > 0 ? 1 : 0)
}
