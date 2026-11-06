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
  type ModelOptionWire,
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
function SelectRow({ label, help, value, options, allowCustom, placeholder, onChange }: {
  label: string; help?: string; value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  allowCustom?: boolean; placeholder?: string;
  onChange: (next: string) => void;
}): ReactNode {
  const known = options.some((o) => o.value === value);
  const isCustom = allowCustom === true && value !== '' && !known;
  // 当前值不在列表里（或为空）→ 显示自定义输入；否则下拉
  if (isCustom || (options.length === 0 && allowCustom === true)) {
    return createElement('div', { className: 'imqb2-field' },
      createElement('div', { className: 'imqb2-head' },
        createElement('span', { className: 'imqb2-label' }, label),
        options.length > 0
          ? createElement('button', {
              type: 'button', className: 'imqb2-link', style: { flex: 'none' },
              onClick: () => { onChange(''); },
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
            onClick: () => { onChange(value === '' ? ' ' : value); },
          }, '手动输入')
        : null,
    ),
    createElement('select', {
      className: 'imqb2-input imqb2-select', value,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => { onChange(event.currentTarget.value); },
    },
      createElement('option', { value: '' }, placeholder ?? '（继承宿主默认）'),
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
  const update = (i: number, key: 'provider' | 'model', v: string): void => {
    const next = routes.map((r, idx) => idx === i ? { ...r, [key]: v } : r);
    onChange(next);
  };
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, '备用模型通道'),
    routes.length === 0
      ? createElement('p', { className: 'imqb2-hint' }, '未启用（主通道不可用时也不会切换）')
      : routes.map((r, i) => createElement('div', { key: i, className: 'imqb2-fb-row' },
          createElement('input', {
            className: 'imqb2-input imqb2-fb-provider', value: r.provider,
            placeholder: 'provider', list: `imqb2-dl-provider-${i}`, spellCheck: false,
            onChange: (e: ChangeEvent<HTMLInputElement>) => { update(i, 'provider', e.currentTarget.value); },
          }),
          createElement('datalist', { id: `imqb2-dl-provider-${i}` },
            [...byProvider.keys()].map((p) => createElement('option', { key: p, value: p }))),
          createElement('input', {
            className: 'imqb2-input imqb2-fb-model', value: r.model,
            placeholder: 'model', spellCheck: false,
            onChange: (e: ChangeEvent<HTMLInputElement>) => { update(i, 'model', e.currentTarget.value); },
          }),
          createElement('button', {
            type: 'button', className: 'imqb2-fb-del', 'aria-label': `删除第${i + 1}条备用通道`,
            onClick: () => { onChange(routes.filter((_, idx) => idx !== i)); },
          }, '×'),
        )),
    createElement('button', {
      type: 'button', className: 'imqb2-fb-add',
      onClick: () => { onChange([...routes, { provider: '', model: '' }]); },
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
    })();
  }, []);
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

  const patch = useCallback(<K extends keyof ConfigWire>(key: K, value: ConfigWire[K]): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
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
          createElement(StatusRow, {
            key: 'route', label: '备用通道',
            value: (status.fallbackRoutes?.length ?? 0) > 0 ? status.fallbackRoutes!.join(' → ') : '未配置',
          }),
        ],

    createElement('div', { className: 'imqb2-group-title' }, '模型'),
    createElement(SelectRow, {
      label: 'Provider',
      value: form.provider ?? '',
      options: [...new Set(models.map((m) => m.provider))].map((p) => ({ value: p, label: p })),
      allowCustom: true,
      placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('provider', v.trim() === '' ? '' : v); },
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
      onChange: (next) => { patch('fallbackRoutes', next.filter((r) => r.provider.trim() !== '' && r.model.trim() !== '')); },
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
            key: 'keywords', label: '兴趣关键词（命中更容易接话）', rows: 2,
            value: (personaRt.keywords ?? []).join('\n'),
            onChange: (v) => { setPersonaRt({ ...personaRt, keywords: v.split('\n').map((x) => x.trim()) }); setPersonaRtDirty(true); },
          }),
          createElement(AreaRow, {
            key: 'other', label: '别人的称呼（用于判断"在叫谁"，一行一个）', rows: 2,
            value: (personaRt.otherNames ?? []).join('\n'),
            onChange: (v) => { setPersonaRt({ ...personaRt, otherNames: v.split('\n').map((x) => x.trim()) }); setPersonaRtDirty(true); },
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
                body: JSON.stringify({
                  names: personaRt.names ?? [],
                  keywords: personaRt.keywords ?? [],
                  otherNames: personaRt.otherNames ?? [],
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
