/**
 * QQ 机器人配置面板 — 必要配置的 UI 编辑
 *
 * UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
 * 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
 * Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
 * 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
 * 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
 *
 * 数据流：GET /qqbot/im-qqbot/config 回显当前生效配置（appSecret
 * 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
 * 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
 *
 * 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
 * 类字段走 profile patch / 环境变量。
 */
import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import {
  BIND_CONFIG_PATH,
  BIND_MODELS_PATH,
  BIND_PERSONA_PATH,
  BIND_PRESETS_PATH,
  BIND_STATUS_PATH,
  NGA_CAPTURE_PATH,
  NGA_CLEAR_PATH,
  NGA_OPEN_PATH,
  NGA_STATUS_PATH,
  type ModelOptionWire,
  type NgaStatusWire,
} from '../shared/bind-protocol.ts';

/** 访问控制配置（与 src/config.ts 的 AccessControlConfig 对应的局部投影） */
interface AccessControlWire {
  c2cMode: 'open' | 'allowlist' | 'disabled';
  c2cAllow: string[];
  groupMode: 'open' | 'allowlist' | 'disabled';
  groupAllow: string[];
}

/** GET 回显的生效配置（appSecret 已剔除） */
type ConfigWire = {
  requireMention?: boolean;
  streaming?: boolean;
  showToolResults?: boolean;
  debug?: boolean;
  provider?: string;
  model?: string;
  preset?: string;
  groupPrompt?: string;
  directPrompt?: string;
  access?: AccessControlWire;
  cwd?: string;
  fallbackRoutes?: Array<{ provider: string; model: string }>;
};

/** 状态快照（GET /status 返回的只读事实） */
interface StatusWire {
  qqConnected?: boolean;
  appId?: string;
  activeSessions?: number;
  webSearchAvailable?: boolean;
  fallbackRoutes?: string[];
  notifyOwnerOnFailover?: boolean;
  [k: string]: unknown;
}

/** 人格热区（runtime.json 四件套） */
interface PersonaRuntimeWire {
  names?: string[];
  keywords?: string[];
  otherNames?: string[];
  selfIds?: string[];
}

/** 样式注入标记（幂等） */
const STYLE_ID = 'im-qqbot-config-panel-styles';

/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
function useConfigPanelStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-select { appearance: auto; }
.imqb2-link {
  border: 0; background: none; padding: 2px 6px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-brand-primary); cursor: pointer; border-radius: 6px;
}
.imqb2-link:hover { background: var(--dsw-alias-fill-l1, rgba(128,128,128,.1)); }
.imqb2-fb-row { display: flex; gap: 6px; align-items: center; }
.imqb2-fb-provider { flex: 2; min-width: 0; }
.imqb2-fb-model { flex: 3; min-width: 0; }
.imqb2-fb-del {
  flex: none; width: 26px; height: 26px; border: 0; border-radius: 6px;
  background: var(--dsw-alias-fill-l1, rgba(128,128,128,.12));
  color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer;
}
.imqb2-fb-del:hover { color: var(--dsw-alias-label-primary); }
.imqb2-fb-add {
  align-self: flex-start; border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: transparent; padding: 5px 12px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer;
}
.imqb2-fb-add:hover { background: var(--dsw-alias-fill-l1, rgba(128,128,128,.1)); }
.imqb2-fb-add:disabled { opacity: .5; cursor: default; }
/* 普通文字按钮（次要动作，如「退出登录」）。
 *
 * 为什么单独一个：不能复用 .imqb2-fb-del —— 那是给 26×26 的 × 图标用的，
 * 宽度锁死在 26px。文字按钮套上去，四个字被挤成一个字一行，竖着排。
 * 这是我加 NGA 面板时选错了 class 造成的，别再犯。 */
.imqb2-fb-action {
  align-self: flex-start; border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: transparent; padding: 5px 12px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; white-space: nowrap;
}
.imqb2-fb-action:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-fill-l1, rgba(128,128,128,.1)); }
.imqb2-fb-action:disabled { opacity: .5; cursor: default; }
.imqb2-status-val { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }

/* ── 手机适配（最小化，2026-11-09 重做）─────────────────────────
 *
 * ## 上一版我改错了，教训记在这里
 *
 * 第一版我按"手机版应该长什么样"重做了整个面板：分段控件从横排改成竖排、
 * 删掉滑动指示器、底栏改竖排、按钮全放大到 40px…… 结果用户反馈
 * **"原先只有 nga 部分不合适，现在上面也有不合适的了"** ——
 * 我修一个局部问题，顺手把全局观感重做了一遍。这是越界。
 *
 * ## 这一版的原则：只修"会坏"的，不动"好看不好看"
 *
 * 下面每一条都对应一个**具体的坏**（点不中 / 溢出 / 被 iOS 放大），
 * 没有一条是"我觉得手机上这样更好看"。凡是能不改的一律不改。
 */
@media (max-width: 560px) {
  /* ① 输入框字号必须 ≥16px。
   *
   * 这不是审美问题：iOS Safari 会对 <16px 的输入框**自动放大整页**，
   * 用户点一下输入框，整个面板变成放大的、要手动缩回去 —— 这是坏。
   * 只改 font-size，不动高度/内边距，视觉几乎不变。
   */
  .imqb2-input, .imqb2-textarea { font-size: 16px; }

  /* ② 二维码按窄屏收缩。
   *
   * 写死 240px 在 320~360px 的老手机上会左右溢出一两个像素，
   * 出现横向滚动条。只约束这一个元素，其余尺寸不碰。
   */
  .imqb2-qr-img { max-width: 100%; height: auto; }
}
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);
}

/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
function Switch({ checked, label, onChange }: {
  checked: boolean; label: string; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: 'imqb2-switch',
    onClick: () => { onChange(!checked); },
  }, createElement('span', { className: 'imqb2-switch-thumb' }));
}

/** 访问模式分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
function Segmented({ value, options, onChange, label }: {
  value: AccessMode; options: ReadonlyArray<{ value: AccessMode; label: string }>;
  onChange: (next: AccessMode) => void; label: string;
}): ReactNode {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const trackStyle = {
    '--imqb2-seg-count': options.length,
    '--imqb2-seg-index': index,
  } as CSSProperties;
  return createElement('div', { className: 'imqb2-seg', role: 'tablist', 'aria-label': label, style: trackStyle },
    createElement('span', { className: 'imqb2-seg-indicator' }),
    options.map((o) => createElement('button', {
      key: o.value, type: 'button', role: 'tab', 'aria-selected': o.value === value,
      className: 'imqb2-seg-tab', onClick: () => { onChange(o.value); },
    }, o.label)),
  );
}

/** 开关行（label 左 + Switch 右 + 可选 help） */
function SwitchRow({ label, help, checked, onChange }: {
  label: string; help?: string; checked: boolean; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Switch, { checked, label, onChange }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-help' }, help),
  );
}

/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
function FieldRow({ label, help, value, placeholder, onChange }: {
  label: string; help?: string; value: string; placeholder?: string; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('input', {
      className: 'imqb2-input', value, placeholder, spellCheck: false,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 多行文本行 */
function AreaRow({ label, help, value, rows, onChange }: {
  label: string; help?: string; value: string; rows?: number; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('textarea', {
      className: 'imqb2-input imqb2-textarea', value, rows: rows ?? 3,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 下拉选择行（数据源来自 /models、/presets；含"自定义"手输兜底） */
/**
 * 下拉选择行（可切换"手动输入"）。
 *
 * ## 模式切换是显式的（2026-11-06 修）
 *
 * 旧版根据"当前值是否在候选里"自动决定显示下拉还是输入框 —— 用户切换
 * Provider 后原 Model 不在新候选里，控件会**自动跳成输入框**，视觉上像
 * 同时出现两个控件（用户反馈"显示了两个"）。
 * 新版：模式由用户点按钮显式切换，值的归属不改变控件形态。
 * 值不在候选里时下拉会显示为空选中态，但值仍保留、提交不受影响。
 */
function SelectRow({ label, help, value, options, allowCustom, placeholder, onChange }: {
  label: string; help?: string; value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  allowCustom?: boolean; placeholder?: string;
  onChange: (next: string) => void;
}): ReactNode {
  const [custom, setCustom] = useState(false);
  const known = options.some((o) => o.value === value);
  // 空值 + 有候选 → 下拉（继承默认是合法选择）；显式点过"手动输入"→ 输入框
  const showInput = custom || (allowCustom === true && options.length === 0);
  if (showInput) {
    return createElement('div', { className: 'imqb2-field' },
      createElement('div', { className: 'imqb2-head' },
        createElement('span', { className: 'imqb2-label' }, label),
        options.length > 0
          ? createElement('button', {
              type: 'button', className: 'imqb2-link', style: { flex: 'none' },
              onClick: () => { setCustom(false); onChange(''); },
            }, '改用下拉选择')
          : null,
      ),
      createElement('input', {
        className: 'imqb2-input', value, placeholder: placeholder ?? '留空继承宿主默认', spellCheck: false,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
      }),
      help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
    );
  }
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      allowCustom === true
        ? createElement('button', {
            type: 'button', className: 'imqb2-link', style: { flex: 'none' },
            onClick: () => { setCustom(true); },
          }, '手动输入')
        : null,
    ),
    createElement('select', {
      className: 'imqb2-input imqb2-select', value: known ? value : '',
      onChange: (event: ChangeEvent<HTMLSelectElement>) => { onChange(event.currentTarget.value); },
    },
      createElement('option', { value: '' }, known && value !== '' ? `（当前：${value}）` : placeholder ?? '（继承宿主默认）'),
      options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 备用模型列表（可增删的多行条目） */
function FallbackRoutes({ routes, models, onChange }: {
  routes: Array<{ provider: string; model: string }>;
  models: ReadonlyArray<ModelOptionWire>;
  onChange: (next: Array<{ provider: string; model: string }>) => void;
}): ReactNode {
  const byProvider = new Map<string, ModelOptionWire[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  // 一次改多个字段：必须在**同一次** onChange 里完成。连续两次调用 update
  // 会有 stale-props 问题 —— 第二次拿到的 routes 还是本次 render 的旧值，
  // 会把第一次的修改覆盖掉（React 状态更新不是同步可见的）。
  const update = (i: number, patchItem: Partial<{ provider: string; model: string }>): void => {
    const next = routes.map((r, idx) => idx === i ? { ...r, ...patchItem } : r);
    onChange(next);
  };
  const providers = [...byProvider.keys()];
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, '备用模型通道'),
    routes.length === 0
      ? createElement('p', { className: 'imqb2-hint' }, '未启用（主通道不可用时也不会切换）')
      : routes.map((r, i) => createElement('div', { key: i, className: 'imqb2-fb-row' },
          // provider 下拉（候选来自 /models 的实际 provider），换 provider 清 model
          createElement('select', {
            className: 'imqb2-input imqb2-fb-provider',
            value: providers.includes(r.provider) ? r.provider : '',
            onChange: (e: ChangeEvent<HTMLSelectElement>) => {
              const nextProvider = e.currentTarget.value;
              // provider 变了，model 大概率不属于新 provider → 一并清掉（一次 setState）
              const keepModel = byProvider.get(nextProvider)?.some((m) => m.id === r.model) === true;
              update(i, keepModel ? { provider: nextProvider } : { provider: nextProvider, model: '' });
            },
          },
            createElement('option', { value: '' }, r.provider === '' ? '选择 provider' : `（自定义：${r.provider}）`),
            providers.map((p) => createElement('option', { key: p, value: p }, p)),
          ),
          createElement('input', {
            className: 'imqb2-input imqb2-fb-model', value: r.model,
            placeholder: 'model', list: `imqb2-dl-model-${i}`, spellCheck: false,
            onChange: (e: ChangeEvent<HTMLInputElement>) => { update(i, { model: e.currentTarget.value }); },
          }),
          // model 用 datalist：既可下拉选也可手输（model 多，纯下拉太长）
          createElement('datalist', { id: `imqb2-dl-model-${i}` },
            (byProvider.get(r.provider) ?? []).map((m) => createElement('option', { key: m.id, value: m.id }))),
          createElement('button', {
            type: 'button', className: 'imqb2-fb-del', 'aria-label': `删除第${i + 1}条备用通道`,
            onClick: () => { onChange(routes.filter((_, idx) => idx !== i)); },
          }, '×'),
        )),
    createElement('button', {
      type: 'button', className: 'imqb2-fb-add',
      onClick: () => { onChange([...routes, { provider: providers[0] ?? '', model: '' }]); },
    }, '+ 添加备用通道'),
    createElement('p', { className: 'imqb2-hint' },
      '主通道限流/不可用时按顺序自动切换。切换时会私聊告知你（可关）。'),
  );
}

/** 状态总览行（只读） */
function StatusRow({ label, value }: { label: string; value: string }): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement('span', { className: 'imqb2-status-val' }, value),
    ),
  );
}

/** 访问模式分段选择行 */
function SegmentedRow({ label, help, value, options, onChange }: {
  label: string; help?: string; value: AccessMode;
  options: ReadonlyArray<{ value: AccessMode; label: string }>; onChange: (next: AccessMode) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Segmented, { value, options, onChange, label }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

type AccessMode = AccessControlWire['c2cMode'];

const MODE_OPTIONS: ReadonlyArray<{ value: AccessMode; label: string }> = [
  { value: 'open', label: '所有人' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
];

/** 深比较（表单值与初始回显值的 dirty 判断） */
function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 配置面板主体。
 *
 * 保存仅提交变更键（服务端按白名单合并），保存成功后提示
 * HMR 重载语义（进行中的机器人会话将重置）。
 */
export function ConfigPanel(props?: { bindPhase?: string }): ReactNode {
  useConfigPanelStyles();
  const [initial, setInitial] = useState<ConfigWire | null>(null);
  const [form, setForm] = useState<ConfigWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // 模型/预置下拉数据源（加载失败不阻塞面板，只是退化为手输）
  const [models, setModels] = useState<ReadonlyArray<ModelOptionWire>>([]);
  const [presets, setPresets] = useState<ReadonlyArray<{ id: string; name?: string }>>([]);
  const [status, setStatus] = useState<StatusWire | null>(null);
  const [personaRt, setPersonaRt] = useState<PersonaRuntimeWire | null>(null);
  const [personaRtDirty, setPersonaRtDirty] = useState(false);
  const [personaRtBusy, setPersonaRtBusy] = useState(false);
  const [personaRtMsg, setPersonaRtMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // NGA 凭证（只关心「有没有登录」+ 浏览器能不能连）
  const [nga, setNga] = useState<NgaStatusWire | null>(null);
  const [ngaMsg, setNgaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ngaBusy, setNgaBusy] = useState(false);
  // 扫码流程：二维码 data URL + 轮询状态
  const [ngaQr, setNgaQr] = useState<{ dataUrl: string; expiresInSec: number } | null>(null);
  const [ngaPoll, setNgaPoll] = useState<NgaPollWire | null>(null);

  /** 读 NGA 凭证状态（三个按钮都靠它刷新） */
  const refreshNga = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(NGA_STATUS_PATH, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean } & Partial<NgaStatusWire>;
      if (res.ok && body.ok === true) {
        setNga({
          authenticated: body.authenticated === true,
          path: body.path ?? '',
          browserAvailable: body.browserAvailable === true,
          ...(body.uid ? { uid: body.uid } : {}),
          ...(body.browserHint ? { browserHint: body.browserHint } : {}),
        });
        return;
      }
      setNga(null);
    } catch {
      setNga(null); // 状态区隐藏，不阻塞面板
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(BIND_MODELS_PATH, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; models?: ModelOptionWire[] };
        if (res.ok && body.ok === true && Array.isArray(body.models)) setModels(body.models);
      } catch { /* 下拉退化手输 */ }
      try {
        const res = await fetch(BIND_PRESETS_PATH, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; presets?: Array<{ id: string; name?: string }> };
        if (res.ok && body.ok === true && Array.isArray(body.presets)) setPresets(body.presets);
      } catch { /* 同上 */ }
      try {
        const res = await fetch(BIND_STATUS_PATH, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: StatusWire };
        if (res.ok && body.ok === true && body.status) setStatus(body.status);
      } catch { /* 状态区隐藏 */ }
      try {
        const res = await fetch(BIND_PERSONA_PATH, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; runtime?: PersonaRuntimeWire };
        if (res.ok && body.ok === true && body.runtime) setPersonaRt(body.runtime);
      } catch { /* 人格区隐藏 */ }
      await refreshNga();
    })();
  }, []);
  // 二维码出现后每 2 秒轮询一次扫码结果。
  //
  // 为什么是 2 秒：NGA 那边扫码确认后 cookie 立刻就能用，
  // 2 秒的延迟人感知不到；再快只是白打服务端。
  // 一旦 success 或 expired 就停 —— 不能对着死码一直抡。
  useEffect(() => {
    if (ngaQr === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch(NGA_QR_POLL_PATH, { method: 'POST' });
        const body = (await res.json().catch(() => ({ status: 'pending', message: '解析失败' }))) as NgaPollWire;
        if (stopped) return;
        setNgaPoll(body);
        if (body.status === 'success') {
          stopped = true;
          setNgaQr(null);
          await refreshNga();
          return;
        }
        if (body.status === 'expired') {
          stopped = true;
          return;
        }
      } catch {
        // 网络抖动：继续轮询，不要因为一次失败就停掉整条流程
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ngaQr, refreshNga]);

  const [loadError, setLoadError] = useState<string | null>(null);
  // 绑定相位变化时重拉配置（扫码落库的白名单等新值）
  const bindPhase = props?.bindPhase;

  useEffect(() => {
    let stopped = false;
    void fetch(BIND_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: ConfigWire };
        if (stopped) return;
        setInitial(body.config);
        setForm(body.config);
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { stopped = true; };
  }, [bindPhase]);

  const patch = useCallback(<K extends keyof ConfigWire>(key: K, value: ConfigWire[K], extra?: Partial<ConfigWire>): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value, ...extra });
    setResult(null);
  }, []);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || initial === null || form === null) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(form) as Array<keyof ConfigWire>) {
      if (!shallowEqual(form[key], initial[key])) {
        changed[key] = form[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    // 白名单编辑期间保留原始换行/空行（textarea 可正常回车），提交时才规范化
    if (changed.access !== undefined) {
      const a = changed.access as AccessControlWire;
      changed.access = {
        ...a,
        c2cAllow: a.c2cAllow.map((s) => s.trim()).filter(Boolean),
        groupAllow: a.groupAllow.map((s) => s.trim()).filter(Boolean),
      };
    }
    // 备用通道同样：编辑态保留未填完的行，提交时才丢掉不完整条目
    // （后端校验也会拒绝 provider/model 为空的条目，这里提前清洗给更好的体验）
    if (changed.fallbackRoutes !== undefined) {
      changed.fallbackRoutes = (changed.fallbackRoutes as Array<{ provider: string; model: string }>)
        .filter((r) => r.provider.trim() !== '' && r.model.trim() !== '');
      if (changed.fallbackRoutes.length === 0) changed.fallbackRoutes = [];
    }

    setBusy(true);
    void fetch(BIND_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setResult({ ok: true, message: body.message ?? '配置已保存，插件将自动重载' });
          setInitial(form);
          return;
        }
        setResult({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [busy, form, initial]);

  if (loadError !== null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } },
      `配置加载失败：${loadError}`);
  }
  if (initial === null || form === null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } }, '正在加载配置…');
  }

  const dirty = (Object.keys(form) as Array<keyof ConfigWire>).some((key) => !shallowEqual(form[key], initial[key]));
  const access: AccessControlWire = form.access ?? { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] };

  return createElement('form', { className: 'imqb2-form', onSubmit: submit },
    createElement('div', { className: 'imqb2-group-title' }, '服务范围'),
    createElement(SegmentedRow, {
      label: '私聊', value: access.c2cMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, c2cMode: v }); },
    }),
    access.c2cMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '私聊白名单', help: '请输入用户 openid，多个请换行输入', rows: 3,
          value: access.c2cAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, c2cAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,
    createElement(SegmentedRow, {
      label: '群聊', value: access.groupMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, groupMode: v }); },
    }),
    access.groupMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '群聊白名单', help: '请输入群 openid，多个请换行输入', rows: 3,
          value: access.groupAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, groupAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,

    createElement('div', { className: 'imqb2-group-title' }, '基础设置'),
    createElement(SwitchRow, {
      label: '群聊仅回复 @机器人的消息', checked: form.requireMention ?? true,
      help: '开启后，机器人仅可回复 @机器人的群聊消息',
      onChange: (v) => { patch('requireMention', v); },
    }),
    createElement(SwitchRow, {
      label: '流式输出', checked: form.streaming ?? true,
      help: '回复内容分段实时推送到聊天',
      onChange: (v) => { patch('streaming', v); },
    }),
    createElement(SwitchRow, {
      label: '显示工具调用结果', checked: form.showToolResults ?? false,
      help: '在聊天中展示 agent 工具调用的结构化结果',
      onChange: (v) => { patch('showToolResults', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '状态'),
    status === null
      ? createElement('p', { className: 'imqb2-hint' }, '运行状态不可用（网关未启动或服务未就绪）')
      : [
          createElement(StatusRow, { key: 'qq', label: 'QQ 连接', value: status.qqConnected === true ? '已连接' : '未连接' }),
          createElement(StatusRow, { key: 'sess', label: '活跃会话', value: String(status.activeSessions ?? 0) }),
          createElement(StatusRow, {
            key: 'web', label: '联网搜索',
            value: status.webSearchAvailable === true ? '可用（宿主 web 通道）' : '不可用（走 Bing RSS 兜底）',
          }),
        ],

    createElement('div', { className: 'imqb2-group-title' }, '模型'),
    createElement(SelectRow, {
      label: 'Provider',
      value: form.provider ?? '',
      options: [...new Set(models.map((m) => m.provider))].map((p) => ({ value: p, label: p })),
      allowCustom: true,
      placeholder: '留空继承宿主默认',
      onChange: (v) => {
        const next = v.trim();
        // 换 Provider 后，原 Model 多半不属于新 Provider 的候选 —— 留着会让
        // Model 下拉跳进"自定义"模式，看起来像出现两个控件。换就一起清掉，
        // 让 Model 回到"继承宿主默认"，选了新 Provider 再选 Model。
        patch('provider', next,
          // patch 的第二参：provider 变化时同时重置 model（见下方 patch 签名扩展）
          next !== (form.provider ?? '') ? { model: '' } : undefined);
      },
    }),
    // Model 下拉的候选随 Provider 过滤
    createElement(SelectRow, {
      label: 'Model',
      value: form.model ?? '',
      options: models
        .filter((m) => form.provider === undefined || form.provider === '' || m.provider === form.provider)
        .map((m) => ({ value: m.id, label: m.name !== undefined && m.name !== m.id ? `${m.name}（${m.id}）` : m.id })),
      allowCustom: true,
      placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('model', v.trim() === '' ? '' : v); },
    }),
    createElement(SelectRow, {
      label: 'Preset',
      value: form.preset ?? '',
      options: presets.map((p) => ({ value: p.id, label: p.name !== undefined && p.name !== p.id ? `${p.name}（${p.id}）` : p.id })),
      allowCustom: true,
      placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('preset', v.trim() === '' ? '' : v); },
    }),
    createElement(FallbackRoutes, {
      routes: form.fallbackRoutes ?? [],
      models,
      // 编辑态不过滤：空行是"正在填"的合法中间态，滤了会出现两个 bug——
      // ①「添加」push 的是空行，立即被滤 → 界面无反应；②填了一半的行消失。
      // 清洗放在 submit（与 access 白名单"编辑保留空行、提交才规范化"同一模式）。
      onChange: (next) => { patch('fallbackRoutes', next); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '个性化提示词'),
    createElement(AreaRow, {
      label: '群聊额外 system prompt', value: form.groupPrompt ?? '',
      onChange: (v) => { patch('groupPrompt', v); },
    }),
    createElement(AreaRow, {
      label: '私聊额外 system prompt', value: form.directPrompt ?? '',
      onChange: (v) => { patch('directPrompt', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '人格热区（改完立即生效，不用重启）'),
    personaRt === null
      ? createElement('p', { className: 'imqb2-hint' }, '人格热区不可用（persona 未启用或网关未启动）')
      : [
          createElement(AreaRow, {
            key: 'names', label: '唤醒名（叫这些名字会醒）', rows: 2,
            value: (personaRt.names ?? []).join('\n'),
            onChange: (v) => { setPersonaRt({ ...personaRt, names: v.split('\n').map((x) => x.trim()) }); setPersonaRtDirty(true); },
          }),
          createElement(AreaRow, {
            key: 'self', label: '自己人的 openid（小号/备用号，这些 id 不算"别人"）', rows: 2,
            value: (personaRt.selfIds ?? []).join('\n'),
            onChange: (v) => { setPersonaRt({ ...personaRt, selfIds: v.split('\n').map((x) => x.trim()) }); setPersonaRtDirty(true); },
          }),
          createElement('button', {
            key: 'save-rt', type: 'button', className: 'imqb2-fb-add',
            disabled: personaRtBusy || !personaRtDirty,
            style: personaRtDirty ? undefined : { opacity: 0.5, cursor: 'default' },
            onClick: () => {
              if (personaRtBusy || !personaRtDirty) return;
              setPersonaRtBusy(true);
              setPersonaRtMsg(null);
              void fetch(BIND_PERSONA_PATH, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                // 只提交面板上有的两键；keywords/otherNames 不在面板上，
                // 不提交（后端语义：undefined = 保持不动，不会清空线上值）
                body: JSON.stringify({
                  names: personaRt.names ?? [],
                  selfIds: personaRt.selfIds ?? [],
                }),
              }).then(async (res) => {
                const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
                setPersonaRtMsg(res.ok && body.ok === true
                  ? { ok: true, text: body.message ?? '已保存，热生效' }
                  : { ok: false, text: body.error ?? `保存失败（HTTP ${res.status}）` });
                if (res.ok && body.ok === true) setPersonaRtDirty(false);
              }).catch((err: unknown) => {
                setPersonaRtMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
              }).finally(() => { setPersonaRtBusy(false); });
            },
          }, personaRtBusy ? '保存中…' : personaRtDirty ? '保存人格热区' : '已保存'),
          personaRtMsg !== null
            ? createElement('p', {
                key: 'rt-msg',
                className: `imqb2-note${personaRtMsg.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}`,
              }, (personaRtMsg.ok ? '' : '⚠️ ') + personaRtMsg.text)
            : null,
          createElement('p', { key: 'rt-hint', className: 'imqb2-hint' },
            '这几项存在 runtime.json，保存后立即生效，不重启插件、不断会话。'),
        ],

    createElement('div', { className: 'imqb2-group-title' }, 'NGA（艾泽拉斯国家地理）'),
    nga === null
      ? createElement('p', { className: 'imqb2-hint' }, 'NGA 服务不可用（网关未启动）')
      : [
          // 登录态 —— 总是显示，改完立即能看见
          createElement('p', { key: 'nga-state', className: 'imqb2-hint' },
            nga.authenticated
              ? `✅ 已登录${nga.uid ? `（uid=${nga.uid}）` : ''} —— 可以搜索、看收藏。`
              : '⭕ 游客态 —— 能列版面、读帖子；**搜索需要登录**。'),
          createElement('div', { key: 'nga-btns', className: 'imqb2-fb-row' },
            // 生成二维码（内联显示，不用弹窗）
            createElement('button', {
              key: 'qr', type: 'button', className: 'imqb2-fb-add',
              disabled: ngaBusy,
              onClick: () => {
                if (ngaBusy) return;
                setNgaBusy(true); setNgaMsg(null); setNgaPoll(null); setNgaQr(null);
                void fetch(NGA_QR_PATH, { method: 'POST' })
                  .then(async (res) => {
                    const body = (await res.json().catch(() => ({}))) as NgaQrWire & { message?: string };
                    if (res.ok && body.ok === true && body.qrDataUrl) {
                      setNgaQr({ dataUrl: body.qrDataUrl, expiresInSec: body.expiresInSec ?? 120 });
                    } else {
                      setNgaMsg({ ok: false, text: body.message ?? `生成失败（HTTP ${res.status}）` });
                    }
                  })
                  .catch((err: unknown) => setNgaMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }))
                  .finally(() => setNgaBusy(false));
              },
            }, '生成登录二维码'),
            createElement('button', {
              key: 'clr', type: 'button', className: 'imqb2-fb-action',
              disabled: ngaBusy || !nga.authenticated,
              style: nga.authenticated ? undefined : { opacity: 0.5, cursor: 'default' },
              onClick: () => {
                if (ngaBusy || !nga.authenticated) return;
                setNgaBusy(true); setNgaMsg(null);
                void fetch(NGA_CLEAR_PATH, { method: 'POST' })
                  .then(async (res) => {
                    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
                    setNgaMsg({ ok: res.ok && body.ok === true, text: body.message ?? '已退出' });
                    setNgaQr(null); setNgaPoll(null);
                    await refreshNga();
                  })
                  .catch((err: unknown) => setNgaMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }))
                  .finally(() => setNgaBusy(false));
              },
            }, '退出登录'),
          ),
          // 二维码内联展开 —— 不弹浮层：手机上浮层要处理 z-index/点外面关，
          // 内联就长在面板里，滚动到这儿直接扫，最省事
          ngaQr !== null
            ? createElement('div', { key: 'nga-qr-box', className: 'imqb2-hint imqb2-qr-box', style: { textAlign: 'center' as const } }, [
                createElement('img', {
                  key: 'img', src: ngaQr.dataUrl, alt: 'NGA 登录二维码',
                  // 用 maxWidth 而不是写死 width：窄屏自动收缩，宽屏仍是 240
                  width: 240, height: 240,
                  className: 'imqb2-qr-img',
                  style: { display: 'block' as const, margin: '8px auto', maxWidth: '100%', height: 'auto' as const },
                }),
                createElement('p', { key: 'tip', className: 'imqb2-hint' },
                  '手机 NGA App → 左上角菜单 → 扫一扫。'
                  + `二维码约 ${ngaQr.expiresInSec} 秒有效，过期就再点一次「生成」。`),
                createElement('p', { key: 'poll', className: 'imqb2-note' },
                  ngaPoll === null ? '⏳ 等待扫码…'
                    : ngaPoll.status === 'success' ? `✅ ${ngaPoll.message}，正在刷新状态…`
                      : ngaPoll.status === 'expired' ? `⚠️ ${ngaPoll.message}`
                        : `⏳ ${ngaPoll.message}`),
              ])
            : null,
          ngaMsg !== null
            ? createElement('p', {
                key: 'nga-msg',
                className: `imqb2-note${ngaMsg.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}`,
              }, (ngaMsg.ok ? '' : '⚠️ ') + ngaMsg.text)
            : null,
          createElement('p', { key: 'nga-path', className: 'imqb2-hint' },
            `凭证存在 ${nga.path}（只含 uid 和登录 token，不含密码）。重新登录后立即生效，不用重启。`),
        ],

    form.cwd !== undefined
      ? createElement('div', { className: 'imqb2-field' },
          createElement('div', { className: 'imqb2-head' },
            createElement('span', { className: 'imqb2-label' }, 'Agent 工作目录'),
            createElement('span', { className: 'imqb2-hint' }, '只读'),
          ),
          createElement('p', { className: 'imqb2-readonly' }, form.cwd),
        )
      : null,

    createElement('div', { className: 'imqb2-footer' },
      result !== null
        ? createElement('p', { className: `imqb2-note${result.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}` },
            (result.ok ? '' : '⚠️ ') + result.message)
        : dirty
          ? createElement('p', { className: 'imqb2-note' }, '保存后插件将重载，进行中的机器人会话将重置')
          : createElement('p', { className: 'imqb2-note' }),
      createElement('button', { className: 'imqb2-save', type: 'submit', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),
  );
}
