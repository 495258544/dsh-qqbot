/**
 * ego 浏览器（agent 浏览器）的定位 —— 可选依赖，缺失时优雅降级
 * ─────────────────────────────────────────────────────────────
 * ## 为什么单独一个文件
 *
 * `surf.ts` 里原来把 ego 的路径**硬编码**成
 *   `/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs`
 * 这在本机能跑，但它是**部署位置的快照**，不是依赖声明：
 * profile 名一改（web → headless / desktop）、换个 DSH_HOME、或者别人装了这个插件，
 * 这行路径就指向不存在的文件，而且是**静默失败**（`existsSync` 为 false → 功能消失）。
 *
 * 实测（2026-11-09）：`dsh-ego-browser` **从本插件包自身解析不到**
 * （`require.resolve` → MODULE_NOT_FOUND），只能从 **profile** 解析到。
 * 因为它是装进 profile 的宿主插件，与我们是平级邻居，不是我们的依赖。
 *
 * 所以正确做法是：
 *   1. 用本仓库既有的 `getProfileDir()` 找到 profile 目录；
 *   2. 从 profile 的 `package.json` 起 `createRequire` 解析包的真实路径
 *      （用模块解析而不是拼 `node_modules/...`，pnp / 软链 / 嵌套布局都能过）；
 *   3. 拿不到就返回 `undefined`，让调用方自己决定降级行为。
 *
 * ## 这个包是**可选**的
 *
 * `dsh-ego-browser` 只是一个「agent 浏览器」实现。没有它，
 * 插件的主体（聊天、日记、记忆、NGA 读帖、Steam/Dota）全都照常工作 ——
 * 受影响只有两处：深度抓正文（surf Layer 2）和 NGA 登录页（要浏览器登录）。
 * 所以它在 package.json 里是 `peerDependenciesMeta.optional: true`，
 * **不能写成硬依赖**：写硬依赖会让没装 ego 的用户直接在安装阶段失败。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProfileDir } from '../shared/index.ts';

/** 定位到的 ego 资源 */
export interface EgoPaths {
  /** ego-browser 入口（.mjs，package.json 无 bin 字段，只能按文件路径走） */
  bin: string;
  /** root 下必须用的 chrome wrapper（否则 --no-sandbox 缺失会假装 DevTools 超时） */
  chrome: string;
  /** 解析到它的包目录（诊断/日志用） */
  root: string;
}

/** 包内的两个关键文件（相对包根） */
const BIN_REL = 'runtime/ego-linux/bin/ego-browser.mjs';
const CHROME_REL = 'bin/ego-chrome-wrapper.sh';

/** 进程内缓存：解析一次就够了，profile 不会在运行期搬家 */
let cached: EgoPaths | null | undefined;

/**
 * 找到 ego 浏览器。
 *
 * @param opts.profileDir 指定 profile（测试用）；缺省走 `getProfileDir()`
 * @param opts.fresh  true = 不走缓存
 * @returns 找不到时返回 `undefined`（**不是抛错** —— 这是可选能力）
 */
export function locateEgo(opts: { profileDir?: string; fresh?: boolean } = {}): EgoPaths | undefined {
  if (!opts.fresh && cached !== undefined) return cached ?? undefined;

  const found = doLocate(opts.profileDir);
  cached = found ?? null;
  return found;
}

/** 清空缓存（测试/诊断用；也用于 profile 切换后重新探测） */
export function resetEgoCache(): void {
  cached = undefined;
}

function doLocate(explicitProfileDir?: string): EgoPaths | undefined {
  const profileDir = explicitProfileDir ?? getProfileDir();
  if (!profileDir) return undefined;

  // 从 profile 的 package.json 起解析 —— profile 可能没有 package.json（全新），
  // 那就退回用 profile 目录本身当基准，node 也会从 node_modules 往上找
  const anchor = existsSync(resolve(profileDir, 'package.json'))
    ? resolve(profileDir, 'package.json')
    : profileDir;

  let pkgJson: string;
  try {
    const req = createRequire(anchor);
    pkgJson = req.resolve('dsh-ego-browser/package.json');
  } catch {
    return undefined;
  }

  // pkgJson = <root>/package.json，求包根
  const root = resolve(pkgJson, '..');
  const bin = resolve(root, BIN_REL);
  const chrome = resolve(root, CHROME_REL);

  // 两个文件都必须真实存在：只有 package.json 存在但 runtime 没下载下来（
  // 有的版本 runtime 是首次运行时才铺）也算没装好，早失败比跑到一半报错好
  if (!existsSync(bin) || !existsSync(chrome)) return undefined;

  return { bin, chrome, root };
}

/**
 * 人类可读的"为什么没有" —— 让上层报错能说清是"没装"还是"没配"，
 * 而不是甩一句 `ENOENT` 让用户猜。
 */
export function egoUnavailableHint(): string {
  return '没找到 dsh-ego-browser（agent 浏览器）。它在这个插件里是**可选**依赖：'
    + '装上它（在 profile 里 `dsh plugin add dsh-ego-browser`）之后这两个功能才可用；'
    + '不装也不影响聊天、日记、记忆、NGA 读帖与 Steam/Dota 查询。';
}
