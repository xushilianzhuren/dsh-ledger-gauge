/**
 * 读数台 · 插件（Host 侧，零依赖，无构建）
 *
 * 管"读数从哪来"：每个数要带出处、日期、复验命令；三层读数（实测＞估算＞未知）。
 *
 * 为什么原生读账：度量族的主力件（RSI成本账/E17价值凝固/存在面采集器）都写死
 * <workspace> 跑不动，但台账本身还在盘（47 本 jsonl）。所以直接扫台账，
 * 给一屏"哪本账有几条、最后一条什么时候、多大"，再按名字查某本账的末几条。
 *
 * @module dsh-ledger-gauge
 */

import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { readFile, stat, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ql-gauge'

export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:gauge'

const DEFAULTS = Object.freeze({ order: 120, tool: true, enabled: true })

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('ql-gauge: config.enabled must be a boolean')
  }
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') {
    throw new Error('ql-gauge: config.tool must be a boolean')
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    throw new Error('ql-gauge: config.order must be a finite number')
  }
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) {
    throw new Error('ql-gauge: config.root must be a non-empty path string')
  }
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    root: raw.root === undefined ? undefined : raw.root.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

function isWorkspace(dir) {
  try {
    return existsSync(join(dir, 'AGENTS.md'))
      && existsSync(join(dir, 'scripts'))
      && (existsSync(join(dir, 'SOUL.md')) || existsSync(join(dir, 'USER.md')))
  } catch {
    return false
  }
}

function findRoot(configured) {
  const candidates = []
  if (configured !== undefined) candidates.push(configured)
  try {
    candidates.push(dirname(dirname(fileURLToPath(import.meta.url))))
  } catch {
    /* 非文件装法 */
  }
  let dir = process.cwd()
  for (let hop = 0; hop < 6; hop += 1) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push('~//Smart Agentharness')
  for (const candidate of candidates) {
    if (isWorkspace(candidate)) return candidate
  }
  return candidates[0]
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

const TIME_KEYS = ['时', '时间', 'ts', 't', '日期', 'date', 'time']

function stampOf(row) {
  if (row === null || typeof row !== 'object') return ''
  for (const key of TIME_KEYS) {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  }
  return ''
}

async function readLedger(path) {
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n').filter(line => line.trim() !== '')
  let last = ''
  for (let i = lines.length - 1; i >= 0 && last === ''; i -= 1) {
    try {
      last = stampOf(JSON.parse(lines[i]))
    } catch {
      last = ''
    }
  }
  return { count: lines.length, last, lines }
}

async function atlas(root) {
  const dirs = [join(root, 'scripts'), join(root, 'scripts', '裁撤归置'), root]
  const seen = new Set()
  const rows = []
  for (const dir of dirs) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      if (seen.has(path)) continue
      seen.add(path)
      try {
        const info = await stat(path)
        const { count, last } = await readLedger(path)
        rows.push({
          ledger: relative(root, path),
          count,
          last: last === '' ? new Date(info.mtimeMs).toISOString().slice(0, 19) : last,
          kb: Math.round(info.size / 102.4) / 10,
        })
      } catch {
        /* 单本读不出不影响全局 */
      }
    }
  }
  rows.sort((a, b) => String(b.last).localeCompare(String(a.last)))
  const totalRows = rows.reduce((sum, row) => sum + row.count, 0)
  const lines = ['【台账面】', `台账 ${rows.length} 本 · 合计 ${totalRows} 条 · 按最后一条时间倒序（示前 25）：`]
  for (const row of rows.slice(0, 25)) {
    lines.push(`  ${row.last} ｜ ${String(row.count).padStart(5)} 条 ｜ ${String(row.kb).padStart(7)} KB ｜ ${row.ledger}`)
  }
  return lines.join('\n')
}

async function lookup(root, query) {
  const dirs = [join(root, 'scripts'), join(root, 'scripts', '裁撤归置'), root]
  const seen = new Set()
  const hits = []
  for (const dir of dirs) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !name.includes(query)) continue
      const path = join(dir, name)
      if (seen.has(path)) continue
      seen.add(path)
      try {
        const { count, lines } = await readLedger(path)
        hits.push({ ledger: relative(root, path), count, tail: lines.slice(-3) })
      } catch {
        /* 跳过 */
      }
    }
  }
  if (hits.length === 0) return `【台账查「${query}」】零命中（台账名不含该词；零命中≠没有这本账，换词再查）。`
  const out = [`【台账查「${query}」】命中 ${hits.length} 本：`]
  for (const hit of hits) {
    out.push(`  ${hit.ledger}｜${hit.count} 条｜末三条：`)
    for (const line of hit.tail) {
      let rendered = clip(line, 160)
      try {
        rendered = clip(JSON.stringify(JSON.parse(line), null, 0), 160)
      } catch {
        /* 保持原文 */
      }
      out.push(`    · ${rendered}`)
    }
  }
  return out.join('\n')
}

/** 体量年龄：四文件字节→估算 token→跑上下文人生等效计算器（月测令执行件）。 */
function runFile(cmd, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, code: error === null ? 0 : 1, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

async function ageOf(root) {
  let total = 0
  const per = []
  for (const name of ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']) {
    try {
      const info = await stat(join(root, name))
      total += info.size
      per.push(`${name} ${(info.size / 1024).toFixed(0)}KB`)
    } catch {
      per.push(`${name} 缺件`)
    }
  }
  // 口径：中文约 3 字节/字 ≈ 1 token（与启动预算门禁同口径，属估算）
  const tokens = Math.round(total / 3)
  const result = await runFile('python3', ['scripts/上下文人生等效计算器.py', String(tokens)], root, 30000)
  const lines = [
    '【体量年龄·月测】',
    per.join(' · '),
    `四文件合计 ${(total / 1048576).toFixed(2)} MB → 估算 ${tokens} token（口径：3 字节/字·估算非实测）`,
    result.ok ? result.out : `计算器跑挂（exit ${result.code}）：${result.out.slice(0, 200)}`,
  ]
  return lines.join('\n')
}

function renderSection() {
  return [
    '## 读数台令 · 常驻（每个数都要有出处、日期、复验命令）',
    '',
    '**读数是论断的骨头**。没有读数的判断叫感觉，没有出处的读数叫传言。',
    '',
    '**一、三层读数，禁混用**',
    '实测（有复现命令·可重跑）＞估算（必须标明估算说法与假设）＞未知（只答"不知道＋下一步取证"）。'
      + '把估算说成实测＝造假；把未知说成经验＝吹牛。',
    '',
    '**二、读数四件套**',
    '每个重要数字带四件：值／出处（文件或命令）／时点／复验命令。缺任一件＝半份读数，'
      + '对外报数前补齐。',
    '',
    '**三、账本即读数**（月测另跑 ql_gauge 体量年龄：四文件→等效年龄，冻结线进度条）',
    '台账在盘就能读（ql_gauge 台账面／台账查）：条数、最后一条时间、体量。'
      + '账本久不增＝该动作没在跑；账本只增不查＝记了白记。',
    '',
    '**四、过期即腐**',
    '读数是快照不是永恒：过期读数按过期处理（标日期+复验），旧结论与现况冲突以实测为准，'
      + '并回写"旧读数已过期"的痕迹。',
    '',
    '**判据**：报数之前自问"这个数我能不能当场重跑一遍得出它"——答不能＝降级为估算或标明未知。',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-gauge：主开关关着，未挂载')
    return
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(),
  }), 'ql-gauge.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_gauge',
      description: '读数台：台账面（scripts 与根目录全部 jsonl 台账的条数/最后一条时间/体量，按时间倒序）'
        + '与台账查（按台账名关键词，出条数与末三条）。只读，不写任何文件。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['台账面', '台账查', '体量年龄'],
            description: '要执行的动作。',
          },
          query: { type: 'string', description: '台账名关键词（action=台账查 时必填）。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const root = findRoot(cfg.root)
        const action = typeof args?.action === 'string' ? args.action : '台账面'
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        try {
          if (action === '体量年龄') return { report: await ageOf(root) }
          if (action === '台账查') {
            if (query === '') return { report: '台账查需要 query（台账名关键词）。' }
            return { report: await lookup(root, query) }
          }
          return { report: await atlas(root) }
        } catch (error) {
          return { report: `读数台内部错：${clip(error?.message ?? error, 200)}` }
        }
      },
    }), 'ql-gauge.tool()')
  }

  ctx.logger?.info?.('ql-gauge：区块 %s 已注册（order=%d）', SECTION_NAME, cfg.order)
}
