/**
 * 中文口语疑问句识别 · 回归测试
 * ─────────────────────────────────────────────────────────────
 * 语料分三组：
 *  1. 任务给的 7 条原始失败样例（旧正则全漏，现在必须全中）
 *  2. 口语常见问法（正反问/省略语气词/省略式"没"）
 *  3. 陈述句反例（最容易误报的：吧字祈使、呢字进行、疑问代词任指）
 */
import { describe, expect, it } from 'vitest';
import { detectQuestion, detectAddressee, classifyUtterance, isQuestion } from './question-detect.ts';

describe('detectQuestion · 原始失败样例', () => {
  it('旧正则漏掉的 7 条，现在都能识别', () => {
    for (const t of ['吃了吗', '吃饭没', '在干嘛', '睡了吗', '今天忙不忙', '明天来不来', '有空吗']) {
      const r = detectQuestion(t);
      expect(r.isQuestion, `「${t}」应判为问句`).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('detectQuestion · 正反问 A不A', () => {
  it('单字和双字谓语的 A不A 都能中', () => {
    for (const t of ['忙不忙', '来不来', '困不困', '累不累', '饿不饿', '行不行', '好不好', '是不是', '对不对']) {
      expect(isQuestion(t)).toBe(true);
    }
    for (const t of ['你困不困', '你吃不吃辣', '你累不累', '是不是你啊', '你行不行啊']) {
      expect(isQuestion(t)).toBe(true);
    }
  });

  it('"差不多/对不起/不得不"不是正反问（两侧字不同，天然不中）', () => {
    for (const t of ['差不多', '对不起', '不得不', '了不起', '忍不住']) {
      expect(isQuestion(t)).toBe(false);
    }
  });

  it('A不A 后接"都/也"是让步陈述', () => {
    expect(isQuestion('来不来都行')).toBe(false);
    expect(isQuestion('好不好都一样')).toBe(false);
  });
});

describe('detectQuestion · 省略式问句', () => {
  it('句末"没/没有"是省略式正反问', () => {
    for (const t of ['吃了没', '有空没', '睡了没', '到了没', '下班没', '你来了没有']) {
      expect(isQuestion(t)).toBe(true);
    }
    expect(isQuestion('吃了没啊')).toBe(true); // 语气词在"没"后面
  });

  it('第一人称 + 没/不 是陈述（我是回答，不是提问）', () => {
    for (const t of ['我没吃', '我不去', '我还没睡', '我也没有']) {
      expect(isQuestion(t)).toBe(false);
    }
  });

  it('句末"不"是正反问省略形式', () => {
    for (const t of ['走不', '去不', '吃不吃', '香不香']) expect(isQuestion(t)).toBe(true);
  });
});

describe('detectQuestion · 语气词', () => {
  it('吗/么 在句末是强疑问', () => {
    for (const t of ['有空吗', '睡了吗', '你在忙吗', '可以么', '是真的么']) expect(isQuestion(t)).toBe(true);
  });

  it('什么/怎么/这么/那么 里的"么"不是语气词', () => {
    for (const t of ['没什么', '不怎么样', '这么晚还不睡', '那么远']) {
      expect(isQuestion(t)).toBe(false);
    }
  });

  it('呢：代词/追问后是问句，进行体后是陈述', () => {
    expect(isQuestion('你呢')).toBe(true);
    expect(isQuestion('然后呢')).toBe(true);
    expect(isQuestion('后来呢')).toBe(true);
    expect(isQuestion('你干嘛呢')).toBe(true);
    expect(isQuestion('上课呢')).toBe(false);
    expect(isQuestion('我在吃饭呢')).toBe(false);
    expect(isQuestion('正忙呢')).toBe(false);
  });

  it('吧：祈使/弱陈述不算问，附加问和推测算问', () => {
    expect(isQuestion('走吧')).toBe(false);
    expect(isQuestion('吃吧')).toBe(false);
    expect(isQuestion('早点睡吧')).toBe(false);
    expect(isQuestion('先这样吧')).toBe(false);
    expect(isQuestion('行吧')).toBe(false);
    expect(isQuestion('好吧')).toBe(false);

    expect(isQuestion('是吧')).toBe(true);
    expect(isQuestion('对吧')).toBe(true);
    expect(isQuestion('你懂我意思吧')).toBe(true);
    expect(isQuestion('累坏了吧')).toBe(true);
    expect(isQuestion('快到了吧')).toBe(true);
  });

  it('语气词"吧"在长句中不误报（"就这样吧""我谢谢你啊"）', () => {
    for (const t of ['就这样吧', '随便吧', '看情况吧', '改天聊吧', '我谢谢你啊']) {
      expect(isQuestion(t)).toBe(false);
    }
  });
});

describe('detectQuestion · 特指问与任指', () => {
  it('疑问代词在提问', () => {
    for (const t of ['为什么', '咋了', '怎么回事', '你说啥', '谁啊', '几点', '多少', '你怎么不玩了', '你咋不睡']) {
      expect(isQuestion(t)).toBe(true);
    }
  });

  it('疑问代词表任指/否定时不误报', () => {
    for (const t of ['我谁都不认识', '谁都不认识', '我什么都不知道', '没什么', '我哪知道', '我哪儿都不去', '不咋样', '不管怎样', '他谁啊不认识']) {
      expect(isQuestion(t)).toBe(false);
    }
  });
});

describe('detectQuestion · 选择问', () => {
  it('A还是B 是问句', () => {
    for (const t of ['吃面还是吃饭', '去还是不去', '你说是吧还是我说得对']) expect(isQuestion(t)).toBe(true);
  });
  it('"不管…还是…" 不是问句', () => {
    expect(isQuestion('不管你去还是我去都行')).toBe(false);
  });
});

describe('detectQuestion · 陈述句反例', () => {
  it('常见闲聊/生活流水不该判成问句', () => {
    const negatives = [
      '我吃了', '吃过了', '我睡了', '今天很忙', '明天来', '我在呢', '不知道', '没空', '我没事',
      '好累', '睡觉了', '晚安', '我先走了', '我去吃饭', '好的', '行', '可以', '嗯', '哈哈',
      '多喝水', '注意身体', '我马上到', '刚下班', '我也是', '我也想吃', '我饿了', '困了',
      '我知道', '我明白', '随便', '都行', '不用了', '谢谢', '辛苦了', '明天见', '别熬夜',
      '我在打游戏呢', '刚刚在忙', '稍等', '明天再说', '先这样', '吃饭去', '睡了睡了',
    ];
    for (const t of negatives) expect(isQuestion(t), `「${t}」不该判为问句`).toBe(false);
  });

  it('纯答语不判为问句', () => {
    for (const t of ['没', '没有', '不是', '不', '在', '嗯', '好']) expect(isQuestion(t)).toBe(false);
  });
});

describe('detectQuestion · 脏输入', () => {
  it('@、[图片]、emoji、全角标点都能处理', () => {
    expect(isQuestion('[图片]')).toBe(false);
    expect(isQuestion('@小羽 在吗')).toBe(true);
    expect(isQuestion('在吗？')).toBe(true);
    expect(isQuestion('吃了吗？😀')).toBe(true);
    expect(isQuestion('')).toBe(false);
    expect(isQuestion('   ')).toBe(false);
  });

  it('QQ 长消息里夹一个问句也算问', () => {
    expect(isQuestion('今天好热啊。对了，你吃了吗')).toBe(true);
  });
});

describe('detectAddressee · 在跟谁说话', () => {
  it('第二人称明确指出对象', () => {
    const a = detectAddressee('你吃了吗');
    expect(a.explicit).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0.5);
  });

  it('省略主语的句子靠上下文补', () => {
    expect(detectAddressee('吃了吗').score).toBe(0); // 无上下文：不知道在问谁
    expect(detectAddressee('吃了吗', { inConversationWithMe: true }).score).toBeGreaterThan(0);
    expect(detectAddressee('吃了吗', { botSpokeLast: true }).score).toBeGreaterThan(0);
  });

  it('叫名字/称呼开头是显式', () => {
    const a = detectAddressee('小羽在吗', { names: ['小羽'] });
    expect(a.explicit).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0.5);
  });

  it('点名别人 → excluded，不再算作跟她说话', () => {
    const a = detectAddressee('老张去不去', { names: ['小羽'], otherNames: ['老张'] });
    expect(a.excluded).toBe(true);
    expect(a.explicit).toBe(false);
  });
});

describe('classifyUtterance · 接不接话', () => {
  it('明确问她 + 问句 → 接', () => {
    expect(classifyUtterance('你吃了吗').shouldReply).toBe(true);
    expect(classifyUtterance('小羽睡了吗', { names: ['小羽'] }).shouldReply).toBe(true);
  });

  it('省略主语的问句，只在对话窗口内才接', () => {
    expect(classifyUtterance('吃了吗').shouldReply).toBe(false);
    expect(classifyUtterance('吃了吗', { inConversationWithMe: true }).shouldReply).toBe(true);
  });

  it('在问别人时不抢话', () => {
    expect(
      classifyUtterance('老张吃了吗', { otherNames: ['老张'], inConversationWithMe: true }).shouldReply,
    ).toBe(false);
  });

  it('陈述句默认不接（避免变成应答器）', () => {
    expect(classifyUtterance('今天好热', { inConversationWithMe: true }).shouldReply).toBe(false);
    expect(classifyUtterance('你吃吧', { inConversationWithMe: true }).shouldReply).toBe(false);
  });
});
