import { describe, it, expect } from 'vitest'
import { coreKeywords, refineQuery } from './surf.ts'

describe('coreKeywords · 口语化长话题提取核心词（M36）', () => {
  it('「把小事讲得很慢的散文和随笔」→ 散文 随笔（否则会搜出单字字典页）', () => {
    // 实测事故：整句拿去搜，搜索引擎拆成单字「把」，
    // 返回「把的意思,把的解释,把的拼音-汉语国学」—— 完全无关。
    expect(coreKeywords('把小事讲得很慢的散文和随笔')).toBe('散文 随笔')
  })

  it('短话题原样返回（不该动）', () => {
    for (const t of ['读书 书单', '咖啡', 'AI 技术', '游戏 新作']) {
      expect(coreKeywords(t), t).toBe(t)
    }
  })

  it('不含口语虚词的长句也不动', () => {
    const t = '机器学习模型部署与推理优化实践'
    expect(coreKeywords(t)).toBe(t)
  })

  it('空值不炸', () => {
    expect(coreKeywords('')).toBe('')
    expect(coreKeywords(undefined as unknown as string)).toBe('')
    expect(coreKeywords('   ')).toBe('')
  })

  it('refineQuery 会先过 coreKeywords（长口语句不再原样去搜）', () => {
    const q = refineQuery('把小事讲得很慢的散文和随笔')
    expect(q).not.toContain('把小事')
    expect(q).toContain('散文')
  })
})
