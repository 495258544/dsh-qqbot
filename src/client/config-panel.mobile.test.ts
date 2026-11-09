/**
 * 面板移动端适配的静态断言
 * ─────────────────────────────────────────────────────────────
 * ## 这里记着一次越界（2026-11-09）
 *
 * 第一版我给面板加了一整套手机适配：分段控件改竖排、删掉滑动指示器、
 * 底栏改竖排、按钮全放大…… 用户的原话是
 * **"原先只有 nga 部分不合适，现在上面也有不合适的了"** ——
 * 他说的是"NGA 那块坏了"，我做的是"整个面板重做一遍"。
 *
 * 所以现在的断言**反过来**：除了"输入框 16px"和"二维码不溢出"这两条
 * 具体的坏，其它一律**不许**在媒体查询里出现。谁要是又往这儿加全局重排，
 * 这条测试会拦下来。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  '/root/Documents/deepseek-harness/default-workspace/dsh-qqbot/src/client/config-panel.ts',
  'utf8',
);

function mobileBlock(): string {
  const at = SRC.indexOf('@media (max-width: 560px)');
  expect(at).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}\n', at);
  return SRC.slice(at, end === -1 ? SRC.length : end);
}

describe('面板移动端适配（只修坏的，不重做设计）', () => {
  const block = mobileBlock();

  it('输入框 ≥16px（iOS 会对 <16px 输入自动放大整页）', () => {
    expect(block).toMatch(/\.imqb2-input[^{]*\{[^}]*font-size:\s*16px/);
  });

  it('二维码按容器收缩（写死 240 在老手机上横向溢出）', () => {
    expect(block).toMatch(/\.imqb2-qr-img[^}]*max-width:\s*100%/);
  });

  it('不许在媒体查询里重排全局组件（上一版越界的地方）', () => {
    // 这些 class 不是 NGA 专属，动它们就是动整个面板的观感。
    // 用户明确说过"上面也有不合适的了" —— 就是这一批造成的。
    const forbidden = [
      '.imqb2-seg',           // 分段控件：曾被改成竖排 + 删指示器
      '.imqb2-seg-indicator',
      '.imqb2-seg-tab',
      '.imqb2-footer',        // 底栏：曾被改成竖排
      '.imqb2-switch',        // 开关：曾被放大
      '.imqb2-switch-thumb',
      '.imqb2-field',         // 行间距：曾被加大
      '.imqb2-group-title',
      '.imqb2-fb-add',        // 通用按钮
      '.imqb2-save',
      '.imqb2-fb-row',        // 通用横排
      '.imqb2-fb-provider',
      '.imqb2-fb-model',
      '.imqb2-head',
      '.imqb2-note',
    ];
    for (const cls of forbidden) {
      // 允许出现在注释里，但不许出现在选择器位置（行首 + 选择器后跟 { 或 ,）
      const re = new RegExp(`^\\s*${cls.replace('.', '\\.')}[\\s,{]`, 'm');
      expect(re.test(block), `${cls} 不该出现在媒体查询里（会改动整个面板观感）`).toBe(false);
    }
  });

  it('模板字符串里不能有反引号（会提前闭合，构建直接失败）', () => {
    const start = SRC.indexOf('    style.textContent = `') + '    style.textContent = `'.length;
    const end = SRC.indexOf('\n    `;', start);
    expect(SRC.slice(start, end)).not.toContain('`');
  });
});

describe('文字按钮不能套图标按钮的 class（退出登录竖排那次）', () => {
  const src = SRC;

  it('「退出登录」用 imqb2-fb-action，不用 imqb2-fb-del', () => {
    // .imqb2-fb-del 是给 26×26 的 × 图标用的，宽度锁死 —— 文字按钮套上去，
    // 四个字被挤成一字一行。用户的原话："退出登陆竖着排了"。
    //
    // 断言方式：从 key: 'clr' 起到 '退出登录' 之间，className 必须是 fb-action。
    const keyIdx = src.indexOf("key: 'clr'");
    expect(keyIdx).toBeGreaterThan(-1);
    const loginIdx = src.indexOf("'退出登录'", keyIdx);
    expect(loginIdx).toBeGreaterThan(keyIdx);
    const seg = src.slice(keyIdx, loginIdx);
    expect(seg).toContain("className: 'imqb2-fb-action'");
    expect(seg).not.toContain("imqb2-fb-del");
  });

  it('.imqb2-fb-action 有 nowrap（文字不许折行）', () => {
    const i = src.indexOf('.imqb2-fb-action {');
    const block = src.slice(i, src.indexOf('}', i));
    expect(block).toContain('white-space: nowrap');
  });

  it('imqb2-fb-del 仍只用于 × 图标（宽度 26px 的语义不能被稀释）', () => {
    // 找到所有用 fb-del 的按钮，看它们的文案是不是 ×
    const usages = [...src.matchAll(/className: 'imqb2-fb-del'[\s\S]{0,120}?\}, '([^']*)'/g)];
    for (const m of usages) {
      expect(m[1], 'imqb2-fb-del 只该装 × 这种单字符图标').toBe('×');
    }
  });
});
