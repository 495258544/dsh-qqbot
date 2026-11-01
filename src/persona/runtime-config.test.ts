/**
 * 运行时配置的热生效：
 *   文件改了（另一个进程 / 对话里改的）→ 下一次读取必须拿到新值，不用重启。
 * 用户要求：后续更新尽量不重启，直接对话就生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeConfig } from './runtime-config.ts'

let dir: string
let file: string
let logs: string[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cfg-'))
  file = path.join(dir, 'runtime.json')
  logs = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const make = () => new RuntimeConfig(file, (m) => logs.push(m))

/** 写文件并把 mtime 明确往前推，避免 Windows 上同毫秒导致不触发重读 */
function writeExternal(content: string): void {
  fs.writeFileSync(file, content, 'utf8')
  const future = new Date(Date.now() + 1000)
  fs.utimesSync(file, future, future)
}

describe('RuntimeConfig · 基础读取', () => {
  it('文件不存在时全空，不抛错', () => {
    const cfg = make()
    expect(cfg.names()).toEqual([])
    expect(cfg.keywords()).toEqual([])
    expect(cfg.otherNames()).toEqual([])
  })

  it('读到三份列表并去重、去空、trim', () => {
    writeExternal(JSON.stringify({
      names: ['小深', ' 小深 ', '', '阿深'],
      keywords: ['打刀'],
      otherNames: ['刘宗锴'],
    }))
    const cfg = make()
    expect(cfg.names()).toEqual(['小深', '阿深'])
    expect(cfg.keywords()).toEqual(['打刀'])
    expect(cfg.otherNames()).toEqual(['刘宗锴'])
  })

  it('写坏了只降级为空，不抛错，并且记一条日志', () => {
    writeExternal('{ 坏掉的 json')
    const cfg = make()
    expect(() => cfg.get()).not.toThrow()
    expect(cfg.names()).toEqual([])
    expect(logs.some((m) => m.includes('解析失败'))).toBe(true)
  })
})

describe('RuntimeConfig · 热生效', () => {
  it('外部改了文件，同一个实例下次读就拿到新值（核心：不用重启）', () => {
    writeExternal(JSON.stringify({ otherNames: ['刘宗锴'] }))
    const cfg = make()
    expect(cfg.otherNames()).toEqual(['刘宗锴'])

    // 模拟"对话里又加了一个人"
    writeExternal(JSON.stringify({ otherNames: ['刘宗锴', '周星宇'] }))
    expect(cfg.otherNames()).toEqual(['刘宗锴', '周星宇'])
  })

  it('文件被删 → 回到空配置，不抱旧值', () => {
    writeExternal(JSON.stringify({ names: ['小深'] }))
    const cfg = make()
    expect(cfg.names()).toEqual(['小深'])

    fs.rmSync(file)
    expect(cfg.names()).toEqual([])
  })

  it('update() 落盘后立刻读到，别的实例也读得到', () => {
    const cfg = make()
    cfg.update({ keywords: ['开黑'] })
    expect(cfg.keywords()).toEqual(['开黑'])
    // 另一个实例（相当于重启后 / 另一个进程）读到同样的值
    expect(make().keywords()).toEqual(['开黑'])
  })

  it('update() 只改传进来的那份，其余保留', () => {
    writeExternal(JSON.stringify({ names: ['小深'], otherNames: ['刘宗锴'] }))
    const cfg = make()
    cfg.update({ keywords: ['打刀'] })
    expect(cfg.names()).toEqual(['小深'])
    expect(cfg.otherNames()).toEqual(['刘宗锴'])
    expect(cfg.keywords()).toEqual(['打刀'])
  })
})
