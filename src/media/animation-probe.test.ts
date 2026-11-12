/**
 * 动图探测（animation-probe）回归测试
 * ─────────────────────────────────────────────────────────────
 * 这个模块的唯一职责是「零成本地判断这是不是动图」，它挂在**消息主路径**上
 * （transport/inbound.ts 的 renderMediaLine），所以两类事故必须锁死：
 *
 *   1. **静态图被误判成动图** → 她看到的每一张图都多一行噪音
 *   2. **探测抛异常** → 整条消息进不来，比看不懂动图严重得多
 *
 * 另外锁一条实测出来的事实：ffprobe 单次要 ~115ms（不是任务书里估计的
 * "毫秒级"），所以常见图片格式必须走纯 JS 容器解析，不能每条消息起子进程。
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatAnimationMeta,
  probeAnimationSync,
  resetAnimationProbeCacheForTest,
} from './animation-probe.ts';

/** 真实测试文件：334×250 / 24fps / 1.75s / 42 帧 / 937KB */
const REAL_GIF = '/root/.dsh-qqbot/media/80B572177AA4DBB8818615B006C10540_1794464867302_12875b28.gif';

function hasRealGif(): boolean {
  try {
    execFileSync('test', ['-f', REAL_GIF]);
    return true;
  } catch {
    return false;
  }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'anim-probe-'));
}

describe('真实 42 帧 GIF', () => {
  it.skipIf(!hasRealGif())('读出的元信息与 ffprobe 一致（帧数/时长/尺寸）', () => {
    resetAnimationProbeCacheForTest();
    const meta = probeAnimationSync(REAL_GIF);
    expect(meta).not.toBeNull();
    expect(meta!.frames).toBe(42);
    expect(meta!.duration).toBeCloseTo(1.75, 2);
    expect(meta!.width).toBe(334);
    expect(meta!.height).toBe(250);
    // 走的是容器解析（纯 JS），不是 ffprobe
    expect(meta!.source).toBe('container');
  });

  it.skipIf(!hasRealGif())('渲染文案带上帧数/时长/尺寸', () => {
    const meta = probeAnimationSync(REAL_GIF)!;
    expect(formatAnimationMeta(meta)).toBe('动图 42 帧 / 1.75s / 334×250');
  });

  it.skipIf(!hasRealGif())('不启动 ffprobe（否则每条带图消息 +115ms）', () => {
    resetAnimationProbeCacheForTest();
    // 注入一个只要被调用就失败的 runner：证明这条路径根本没走到子进程
    const runner = vi.fn(() => null);
    const meta = probeAnimationSync(REAL_GIF, runner as never);
    expect(meta).not.toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('静态图必须完全不受影响', () => {
  it('单帧 PNG → null（JPEG/BMP 之外也走容器解析判静态）', () => {
    const dir = tmpDir();
    try {
      // 1x1 的合法 PNG
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d494844520000000100000001080600000'
        + '01f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082',
        'hex',
      );
      const p = join(dir, 'a.png');
      writeFileSync(p, png);
      expect(probeAnimationSync(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('JPEG 连文件都不读（只看魔数就判定不可能动）', () => {
    const dir = tmpDir();
    try {
      const jpg = join(dir, 'a.jpg');
      writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]));
      resetAnimationProbeCacheForTest();
      expect(probeAnimationSync(jpg)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单帧 GIF 不算动图（1 帧 = 静态图）', () => {
    // GIF89a + 1x1 逻辑屏 + 一个图像块 + trailer
    const gif = Buffer.from(
      '47494638396101000100800000ffffff00000021f90401000000002c00000000'
      + '010001000002024401003b',
      'hex',
    );
    const dir = tmpDir();
    try {
      const p = join(dir, 'single.gif');
      writeFileSync(p, gif);
      resetAnimationProbeCacheForTest();
      expect(probeAnimationSync(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('失败必须静默降级，绝不抛异常', () => {
  it('文件不存在 → null', () => {
    expect(probeAnimationSync('/nonexistent/nope.gif')).toBeNull();
  });

  it('坏文件（内容不是任何媒体）→ null，且不抛', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'bad.gif');
      writeFileSync(p, 'definitely not a gif');
      resetAnimationProbeCacheForTest();
      expect(() => probeAnimationSync(p)).not.toThrow();
      expect(probeAnimationSync(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffprobe 不存在（runner 返回 null）→ null，不抛', () => {
    const dir = tmpDir();
    try {
      // 未知容器：走到 ffprobe 分支
      const p = join(dir, 'weird.xyz');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = vi.fn(() => null);
      expect(probeAnimationSync(p, runner as never)).toBeNull();
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffprobe 返回坏 JSON → null', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'weird2.xyz');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      expect(probeAnimationSync(p, (() => 'not json at all') as never)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空文件 → null', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'empty.gif');
      writeFileSync(p, '');
      resetAnimationProbeCacheForTest();
      expect(probeAnimationSync(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ffprobe 兜底（未知容器）', () => {
  it('ffprobe 报 42 帧 → 当作动图，source=ffprobe', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'clip.mp4');
      writeFileSync(p, Buffer.from('000000186674797069736f6d', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = () => JSON.stringify({
        streams: [{ nb_frames: '42', width: 320, height: 240, duration: '1.75' }],
        format: { duration: '1.75' },
      });
      const meta = probeAnimationSync(p, runner as never);
      expect(meta).not.toBeNull();
      expect(meta!.frames).toBe(42);
      expect(meta!.source).toBe('ffprobe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffprobe 报 1 帧（单帧图）→ null，不算动图', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'x.bin');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = () => JSON.stringify({
        streams: [{ nb_frames: '1', width: 10, height: 10 }],
      });
      expect(probeAnimationSync(p, runner as never)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffprobe 没给 nb_frames → null（不猜）', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'y.bin');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = () => JSON.stringify({ streams: [{ width: 10, height: 10 }] });
      expect(probeAnimationSync(p, runner as never)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('缓存（按 path + mtime + size）', () => {
  it('同一文件第二次不再重算', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'x.xyz');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = vi.fn(() => JSON.stringify({
        streams: [{ nb_frames: '5', width: 10, height: 10, duration: '0.2' }],
      }));
      probeAnimationSync(p, runner as never);
      probeAnimationSync(p, runner as never);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件变了（size 不同）→ 重新探测', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'x.xyz');
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
      resetAnimationProbeCacheForTest();
      const runner = vi.fn(() => JSON.stringify({
        streams: [{ nb_frames: '5', width: 10, height: 10, duration: '0.2' }],
      }));
      probeAnimationSync(p, runner as never);
      writeFileSync(p, Buffer.from('000102030405060708090a0b0c0d0e0f1011', 'hex'));
      probeAnimationSync(p, runner as never);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatAnimationMeta', () => {
  it('时长读不到时省略，不写假的 0.00s', () => {
    expect(formatAnimationMeta({ frames: 3, duration: 0, width: 10, height: 10, source: 'container' }))
      .toBe('动图 3 帧 / 10×10');
  });

  it('尺寸缺失时也不写 0×0', () => {
    expect(formatAnimationMeta({ frames: 3, duration: 1, width: 0, height: 0, source: 'container' }))
      .toBe('动图 3 帧 / 1.00s');
  });
});
