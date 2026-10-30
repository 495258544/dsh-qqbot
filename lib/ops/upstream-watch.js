/**
 * ops · 上游同步巡检（独立模块，**不受 persona 影响**）
 * ─────────────────────────────────────────────────────────────
 * 整合自已交付的 `upstream-watch/` 脚本（watch.sh / classify.sh / fetch_upstream.py /
 * report.py / should_run.sh / ack_watch.py / daemon.sh），修正其审计发现的缺陷后
 * 作为插件内定时模块运行。
 *
 * 设计约束（逐条对应上游脚本实测教训）：
 *
 * 1. **永不改工作树**。原脚本用 `git merge --no-commit` 做冲突预演，然后
 *    `git merge --abort` + `git reset --hard $SAFE` 复原。审计实测发现两处硬伤：
 *    a) 工作树脏时 `merge` 会**提前 abort**（`would be overwritten`），此时
 *       `git diff --diff-filter=U` 为空 → 脚本判定"无冲突"（误判）。原脚本用
 *       `grep 'would be overwritten'` 打补丁，但只在 `merge` 确实执行到时才生效。
 *    b) 在"预演→复原"窗口内若有别的进程提交（本容器**确实发生过**：本次审计期间
 *       HEAD 从 87ec4d8 变成 c129cf5），`reset --hard $SAFE` 会把那次提交从分支上
 *       摘掉——退化成 `git reset --hard` 永久丢提交。
 *    → 本模块改用 `git merge-tree --write-tree`（纯内存，不 checkout/不写 index），
 *      并把写出的树对象重定向到临时对象库（`GIT_OBJECT_DIRECTORY`），连 `.git/objects`
 *      都不污染。没有 abort，没有 reset，失败也不存在"复原"步骤。
 *
 * 2. **脏工作树不再降级为"只读跳过"**。既然预演本身不动工作树，脏工作树只影响
 *    "本地改动与上游改动的重叠面"这一项判断——把它并入重叠集合，结论更准。
 *    原来的 `--untracked-files=no` 漏掉未跟踪文件（实测：本地有未跟踪的
 *    `src/shared/dirs.ts`、上游也新增同名文件 → 合并报 `untracked ... would be
 *    overwritten`，而脚本因看不到未跟踪文件而仍判"干净")。本模块用 `-uall`。
 *
 * 3. **分级口径收敛**。原 classify.sh 三处缺陷：
 *    a) 末档 `MAYBE` 不在统计里 → 汇总的 "AUTO/REVIEW" 计数漏项（实测 13 个提交
 *       只统计到 12 个）。
 *    b) `feat(bind):` 这种带 scope 的前缀匹配不到 `^(feat` → 落到 UNKNOWN，
 *       结论仍是 REVIEW 但理由错标成"无法识别前缀"。
 *    c) 纯 `lib/` 产物或仅 CHANGELOG 的提交会被判 `UNKNOWN`/REVIEW，
 *       实际是"合并后 rebuild 即可"的噪声。
 *    d) 重叠只看**已提交**改动（`merge-base..HEAD`），看不到未提交的在途改动
 *       （实测：本地刚改未提交 `src/commands/help.ts`，上游同文件改动不出现在重叠里）。
 *
 * 4. **时区必须显式换算**。容器无 `/usr/share/zoneinfo`，`TZ=Asia/Shanghai` 被
 *    静默忽略、`getHours()` 返回 UTC。但 Node 的 ICU 是完整的（实测
 *    `Intl.DateTimeFormat` 带 `timeZone` 可用）→ 用 *显式 IANA 时区* 判定"北京 05:00"，
 *    不依赖宿主机时区，也不用 ±8 手工偏移。
 *
 * 5. **不补跑**。参照 `persona/own-life.ts`：statePath 持久化 `lastRunDay`，
 *    只在窗口内跑、每天最多一次；重启后不会一次补发一堆。
 *
 * 安全红线（本模块**没有**、也不应加的能力）：
 *   - 不 exec `merge`/`commit`/`reset`/`push`/`checkout`/`clean`/`stash`
 *   - 唯一的写操作是：临时对象库、state/report 文件、可选通知
 *   - 需要人做决定时只**报告**，不自动合并
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
/**
 * 默认状态目录：**绝不放被巡检仓库内部**。
 * 原因（实测）：若 state 落在 repo 里，巡检产物会自己把工作树弄脏，而"脏工作树"
 * 又是本模块要报告的信号 → 自反馈污染，且给用户 repo 留垃圾。
 */
function defaultStateDir() {
    return path.join(os.homedir(), '.dsh-qqbot', 'ops', 'upstream-watch');
}
/** 默认 5 分钟一跳（与原 daemon.sh 的 sleep 300 对齐） */
const DEFAULT_TICK_MS = 300 * 1000;
const DEFAULT_RUN_HOUR = 5;
const DEFAULT_WINDOW_MIN = 45;
/** 单次 git 调用超时；github.com 曾单次烧掉 ~27s，故给足但要有上限 */
const DEFAULT_GIT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_API_TIMEOUT_MS = 20 * 1000;
/** 锁超过这个时长视为残留（进程被杀没清锁） */
const LOCK_STALE_MS = 30 * 60 * 1000;
/**
 * churn 口径：剔除**可再生成的噪声**。
 * - `lib/`：tsc 产物（入库），合并后统一 rebuild
 * - `*.test.*`：上游测试，不增加我们维护面
 * - `CHANGELOG*`：纯文本冲突源
 * - `*.map` / lockfile：可再生成，churn 会被放大成假信号
 */
const CHURN_EXCLUDE = [/^lib\//, /\.test\./, /CHANGELOG/i, /\.map$/, /^package-lock\.json$/, /^pnpm-lock\.yaml$/];
/**
 * 重叠口径：只在**会真冲突**的文件上算重叠。
 * 比 churn 口径**更宽**（保留 lockfile / package.json）——它们冲突起来是真冲突。
 */
const OVERLAP_EXCLUDE = [/^lib\//, /\.test\./, /CHANGELOG/i];
function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
        }, (err, stdout, stderr) => {
            let code = 0;
            if (err) {
                const c = err.code;
                code = typeof c === 'number' ? c : 1;
            }
            resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}
function isNoisePath(file) {
    return CHURN_EXCLUDE.some((re) => re.test(file));
}
function isOverlapCandidate(file) {
    return !OVERLAP_EXCLUDE.some((re) => re.test(file));
}
/**
 * 北京时间分片。**显式 IANA 时区**，不依赖宿主机时区（容器无 tzdata、TZ 无效）。
 * 返回 {hour, minute, dayKey: 'YYYY-MM-DD'}。
 */
export function beijingParts(nowTs) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(nowTs));
    const pick = (t) => {
        const v = parts.find((p) => p.type === t)?.value;
        return v ? Number(v) : NaN;
    };
    let hour = pick('hour');
    // 部分实现 hour12:false 下仍可能给 24，归一到 0
    if (Number.isFinite(hour) && hour === 24)
        hour = 0;
    const month = String(pick('month')).padStart(2, '0');
    const day = String(pick('day')).padStart(2, '0');
    const year = String(pick('year'));
    return { hour, minute: pick('minute'), dayKey: `${year}-${month}-${day}` };
}
/** 解析提交信息前缀：`fix(bind): ...` → fix */
export function parseKind(subject) {
    const m = /^(fix|feat|refactor|perf|docs|chore|test|build|release|style|ci)(\s*\([^)]*\))?\s*[:：!]/.exec(subject.trim());
    if (m?.[1])
        return m[1];
    return 'none';
}
function categoryOf(kind) {
    if (kind === 'fix' || kind === 'docs' || kind === 'chore' || kind === 'test' || kind === 'release' || kind === 'style' || kind === 'ci' || kind === 'build') {
        return 'PATCH';
    }
    if (kind === 'feat' || kind === 'refactor' || kind === 'perf')
        return 'FEATURE';
    return 'UNKNOWN';
}
/**
 * 分级规则（保留已交付脚本实测标定的阈值 120 / 200 / 400，只修口径）：
 *   - 无源码改动（仅产物/测试/CHANGELOG）           → AUTO（合并后记得 rebuild）
 *   - 与本地改动重叠                                 → REVIEW（必冲突/必人工）
 *   - UNKNOWN 前缀                                   → REVIEW
 *   - FEATURE（feat/refactor/perf）                  → REVIEW
 *   - churn > 400                                    → REVIEW
 *   - PATCH 且 churn ≤ 120                           → AUTO
 *   - PATCH 且 churn ≤ 200 且有测试                   → AUTO
 *   - 其余（PATCH 但偏大且无测试）                    → REVIEW
 */
export function classifyCommit(input) {
    const kind = parseKind(input.subject);
    const category = input.files === 0 ? 'NOISE' : categoryOf(kind);
    const reasons = [];
    let verdict = 'REVIEW';
    if (category === 'NOISE') {
        verdict = 'AUTO';
        reasons.push('仅构建产物/测试/CHANGELOG 等噪声（合并后需 npm run build）');
    }
    else if (input.overlap.length > 0) {
        verdict = 'REVIEW';
        reasons.push(`与本地改动文件重叠: ${input.overlap.slice(0, 4).join(', ')}${input.overlap.length > 4 ? ' …' : ''}`);
    }
    else if (category === 'UNKNOWN') {
        verdict = 'REVIEW';
        reasons.push(`无法识别提交前缀(${kind})`);
    }
    else if (category === 'FEATURE') {
        verdict = 'REVIEW';
        reasons.push('特性/重构类，需要人看语义');
    }
    else if (input.churn > 400) {
        verdict = 'REVIEW';
        reasons.push(`改动过大 churn=${input.churn}>400`);
    }
    else if (input.churn <= 120) {
        verdict = 'AUTO';
        reasons.push(`小修复 churn=${input.churn}≤120`);
    }
    else if (input.tests > 0 && input.churn <= 200) {
        verdict = 'AUTO';
        reasons.push(`有测试覆盖 churn=${input.churn}≤200`);
    }
    else {
        verdict = 'REVIEW';
        reasons.push(`改动 churn=${input.churn}>120 且无测试覆盖`);
    }
    return {
        sha: input.sha,
        short: input.sha.slice(0, 7),
        subject: input.subject,
        kind,
        category,
        verdict,
        churn: input.churn,
        files: input.files,
        tests: input.tests,
        overlap: input.overlap,
        reasons,
    };
}
// ── 主模块 ──────────────────────────────────────────────────────
export function createUpstreamWatch(opts) {
    const { repo, enabled = true, stateDir = defaultStateDir(), remote = 'upstream', upstreamBranch = 'main', apiRepo = '', runHour = DEFAULT_RUN_HOUR, windowMinutes = DEFAULT_WINDOW_MIN, tickIntervalMs = DEFAULT_TICK_MS, apiTimeoutMs = DEFAULT_API_TIMEOUT_MS, gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS, apiToken = '', notify, log = (m) => console.log('[upstream-watch]', m), now = () => Date.now(), } = opts;
    const upstreamRef = `refs/remotes/${remote}/${upstreamBranch}`;
    const statePath = path.join(stateDir, 'state.json');
    const reportPath = path.join(stateDir, 'report.md');
    const lockPath = path.join(stateDir, '.lock');
    let timer = null;
    let busy = false;
    let last;
    // ── state：每次现读，多进程（插件 + profile.d 兜底）共享同一份 ──
    function loadState() {
        const fresh = { lastRunAt: 0, lastRunDay: '', attemptsToday: 0, lastTip: '', lastBehind: 0 };
        try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
            if (raw && typeof raw === 'object')
                Object.assign(fresh, raw);
        }
        catch {
            /* 第一次跑没文件正常 */
        }
        return fresh;
    }
    function saveState(s) {
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(s, null, 2), 'utf8');
        }
        catch (e) {
            log(`状态写不进去（忽略）: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    /** 原子锁：mkdir 是原子的；跨进程（插件 / profile.d 兜底）共享。残留锁按 mtime 判死。 */
    function tryLock() {
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            try {
                const st = fs.statSync(lockPath);
                if (now() - st.mtimeMs > LOCK_STALE_MS) {
                    fs.rmSync(lockPath, { force: true, recursive: true });
                    log('清理残留锁（超时）');
                }
            }
            catch {
                /* 没锁文件，正常 */
            }
            fs.mkdirSync(lockPath);
            return true;
        }
        catch {
            return false;
        }
    }
    function unlock() {
        try {
            fs.rmSync(lockPath, { force: true, recursive: true });
        }
        catch {
            /* 忽略 */
        }
    }
    async function git(args, env) {
        return run('git', ['-C', repo, ...args], { timeoutMs: gitTimeoutMs, env });
    }
    // ── 1. 抓上游（API 主通道；对象缺失才走 git 传输） ──
    async function fetchTip() {
        let apiTip;
        let apiDetail = '';
        let rateLimited = false;
        if (apiRepo) {
            try {
                const j = await apiGet(`https://api.github.com/repos/${apiRepo}/commits?per_page=1`, apiTimeoutMs, apiToken);
                const arr = Array.isArray(j) ? j : [];
                const first = arr[0];
                const sha = first && typeof first.sha === 'string' ? first.sha : undefined;
                if (sha) {
                    apiTip = sha;
                    apiDetail = `API ok tip=${sha.slice(0, 8)}`;
                }
                else {
                    apiDetail = 'API 返回空列表';
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                rateLimited = /HTTP 403|rate limit/i.test(msg);
                apiDetail = rateLimited
                    ? `API 限流(未认证 60/h 已用尽；可配 GITHUB_TOKEN 提高额度)`
                    : `API 失败(${msg.slice(0, 120)})`;
            }
        }
        else {
            apiDetail = '未配置 apiRepo，跳过 API';
        }
        // 本地已有对象？→ 直接推进 ref，零传输
        const hasObject = async (sha) => (await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0;
        if (apiTip && (await hasObject(apiTip))) {
            const u = await git(['update-ref', upstreamRef, apiTip]);
            if (u.code !== 0)
                log(`update-ref 失败: ${u.stderr.trim().slice(0, 120)}`);
            return { tip: apiTip, haveTip: true, channel: 'local', freshness: 'fresh', detail: `${apiDetail} · 本地已有对象，跳过传输` };
        }
        // 需要传输：git fetch（github.com 间歇不可达，失败不致命；带低速熔断豁免）
        if (apiTip) {
            const f = await git([
                '-c', 'http.version=HTTP/1.1',
                '-c', 'http.lowSpeedLimit=0',
                '-c', 'http.lowSpeedTime=999',
                'fetch', '--no-tags', remote, upstreamBranch,
            ]);
            if (f.code === 0 && (await hasObject(apiTip))) {
                return { tip: apiTip, haveTip: true, channel: 'git', freshness: 'fresh', detail: `${apiDetail} · git fetch ok` };
            }
            return {
                tip: apiTip,
                haveTip: false,
                channel: 'api',
                freshness: 'fresh',
                detail: `${apiDetail} · git fetch 失败(${f.stderr.trim().slice(0, 120) || 'exit ' + f.code}) → 只有 tip，缺对象`,
            };
        }
        // API 不可用：退回本地 ref，但**显式标记 stale**，不做"无更新"断言
        const r = await git(['rev-parse', '--verify', upstreamRef]);
        if (r.code === 0) {
            const sha = r.stdout.trim();
            return {
                tip: sha,
                haveTip: true,
                channel: 'stale',
                freshness: 'stale',
                rateLimited,
                detail: `${apiDetail} · 用本地已有 ref ${sha.slice(0, 8)}（可能是旧值，不能据此断言"无更新"）`,
            };
        }
        return { tip: undefined, haveTip: false, channel: 'none', freshness: 'stale', rateLimited, detail: `${apiDetail} · 无本地 ref` };
    }
    // ── 2. 本地改动集合（已提交 + 在途，均剔除噪声） ──
    async function localTouchedFiles() {
        const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const baseRes = await git(['merge-base', 'HEAD', upstreamRef]);
        const mergeBase = baseRes.code === 0 ? baseRes.stdout.trim() : '';
        const committed = mergeBase
            ? (await git(['diff', '--name-only', `${mergeBase}..HEAD`])).stdout.split('\n')
            : [];
        // -uall：把未跟踪文件也算进来。原脚本用 -u no 漏掉未跟踪文件（实测漏判）
        const statusOut = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
        // 自家 stateDir 若被自定义到 repo 内，要把它剔掉，否则巡检产物会伪装成"用户改动"
        const stateRel = path.relative(repo, stateDir);
        const selfArtifacts = stateRel && !stateRel.startsWith('..') && !path.isAbsolute(stateRel)
            ? stateRel.split(path.sep).join('/')
            : '';
        const statusLines = statusOut
            .split('\n')
            .filter(Boolean)
            .filter((l) => !(selfArtifacts && l.slice(3).trim().startsWith(selfArtifacts)));
        const inFlight = [];
        for (const line of statusLines) {
            // XY <path>；重命名是 "R  old -> new"
            const raw = line.slice(3).trim();
            const arrow = raw.indexOf(' -> ');
            const p = (arrow >= 0 ? raw.slice(arrow + 4) : raw).replace(/^"(.*)"$/, '$1');
            if (p)
                inFlight.push(p);
        }
        const all = new Set();
        for (const f of [...committed, ...inFlight]) {
            if (f && isOverlapCandidate(f))
                all.add(f);
        }
        return {
            files: [...all],
            dirtyFiles: statusLines.length,
            sample: statusLines.slice(0, 5),
            head,
            mergeBase,
        };
    }
    // ── 3. 逐 commit 分级 ──
    async function classifyRange(range, localFiles) {
        const list = (await git(['rev-list', '--no-merges', range])).stdout.split('\n').filter(Boolean);
        const out = [];
        for (const sha of list) {
            const subject = (await git(['log', '-1', '--format=%s', sha])).stdout.trim();
            // numstat：单纯名称列表（重命名会给两行，按路径计入）
            const numstat = (await git(['show', '--numstat', '--format=', sha])).stdout;
            let additions = 0;
            let deletions = 0;
            let files = 0;
            const touched = [];
            let tests = 0;
            for (const line of numstat.split('\n')) {
                if (!line.trim())
                    continue;
                const cols = line.split('\t');
                const p = cols[2];
                if (!p)
                    continue;
                const isTest = /\.test\./.test(p);
                if (isTest)
                    tests += 1;
                if (isNoisePath(p))
                    continue;
                const a = Number(cols[0]);
                const d = Number(cols[1]);
                if (Number.isFinite(a))
                    additions += a;
                if (Number.isFinite(d))
                    deletions += d;
                files += 1;
                touched.push(p);
            }
            const overlap = [];
            for (const f of touched) {
                if (localFiles.has(f))
                    overlap.push(f);
            }
            out.push(classifyCommit({
                sha,
                subject,
                churn: additions + deletions,
                files,
                tests,
                overlap,
            }));
        }
        return out;
    }
    // ── 4. 冲突预演：纯内存，绝不 checkout / merge / reset ──
    async function previewConflicts() {
        // 把写出的树对象丢进临时对象库，连 .git/objects 都不落地
        const objDir = path.join(stateDir, 'tmp-objects');
        const gitDirRes = await git(['rev-parse', '--git-dir']);
        if (gitDirRes.code !== 0)
            return { ok: false, conflicts: [], note: '读不到 git-dir' };
        const realObjects = path.resolve(repo, gitDirRes.stdout.trim(), 'objects');
        try {
            fs.rmSync(objDir, { force: true, recursive: true });
            fs.mkdirSync(objDir, { recursive: true });
            const env = {
                ...process.env,
                GIT_OBJECT_DIRECTORY: objDir,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects,
            };
            const r = await git(['merge-tree', '--write-tree', '--no-messages', '--name-only', 'HEAD', upstreamRef], env);
            if (r.code === 0)
                return { ok: true, conflicts: [] };
            if (r.code === 1) {
                const lines = r.stdout.split('\n').filter(Boolean);
                // 首行是 tree oid，其余是冲突文件
                const files = lines.slice(1).map((s) => s.trim()).filter((s) => s && !/^[0-9a-f]{40}$/.test(s));
                return { ok: true, conflicts: files };
            }
            return { ok: false, conflicts: [], note: `merge-tree exit=${r.code} ${r.stderr.trim().slice(0, 160)}` };
        }
        catch (e) {
            return { ok: false, conflicts: [], note: e instanceof Error ? e.message : String(e) };
        }
        finally {
            try {
                fs.rmSync(objDir, { force: true, recursive: true });
            }
            catch {
                /* 忽略 */
            }
        }
    }
    // ── 5. 主流程 ──
    async function runOnce(trigger) {
        const startedAt = now();
        const status = {
            ok: false,
            trigger,
            startedAt,
            finishedAt: 0,
            head: '',
            upstreamRef,
            fetch: { haveTip: false, channel: 'none', freshness: 'stale', detail: '' },
            behind: undefined,
            ahead: undefined,
            dirtyFiles: 0,
            dirtySample: [],
            hasUpdates: undefined,
            classified: [],
            autoCount: 0,
            reviewCount: 0,
            conflicts: { ok: false, conflicts: [] },
            needsAction: false,
        };
        const locals = await localTouchedFiles();
        status.head = locals.head;
        status.dirtyFiles = locals.dirtyFiles;
        status.dirtySample = locals.sample;
        status.fetch = await fetchTip();
        if (locals.mergeBase && status.fetch.haveTip) {
            const behind = await git(['rev-list', '--count', `HEAD..${upstreamRef}`]);
            const ahead = await git(['rev-list', '--count', `${upstreamRef}..HEAD`]);
            status.behind = behind.code === 0 ? Number(behind.stdout.trim()) : undefined;
            status.ahead = ahead.code === 0 ? Number(ahead.stdout.trim()) : undefined;
        }
        // 分级与"有没有更新"的判定要区分**证据强度**：
        //  - behind > 0 是可证明的事实（本地确实缺这些提交），stale 也不影响结论
        //  - behind == 0 只有在 tip **新鲜**时才是"无更新"；stale 时只能说"没发现"
        if (status.fetch.tip && status.fetch.haveTip && status.behind !== undefined) {
            status.hasUpdates = status.behind > 0 ? true : status.fetch.freshness === 'fresh' ? false : undefined;
        }
        if (status.hasUpdates) {
            const localSet = new Set(locals.files);
            status.classified = await classifyRange(`HEAD..${upstreamRef}`, localSet);
            status.autoCount = status.classified.filter((c) => c.verdict === 'AUTO').length;
            status.reviewCount = status.classified.length - status.autoCount;
            status.conflicts = await previewConflicts();
            status.needsAction = status.reviewCount > 0 || status.conflicts.conflicts.length > 0 || (status.conflicts.ok === false && status.conflicts.note !== undefined);
        }
        status.ok = true;
        status.finishedAt = now();
        // 报告落盘（始终写，便于事后追溯）
        const md = renderReport(status, { repo, runHour, windowMinutes });
        status.reportPath = reportPath;
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(reportPath, md, 'utf8');
        }
        catch (e) {
            log(`报告写不进去（忽略）: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 持久化
        const st = loadState();
        st.lastRunAt = status.finishedAt;
        st.lastTip = status.fetch.tip ?? st.lastTip;
        st.lastBehind = status.behind ?? st.lastBehind;
        if (trigger === 'schedule') {
            st.lastRunDay = beijingParts(status.finishedAt).dayKey;
        }
        saveState(st);
        // 只在"需要人拍板"时打扰
        if (status.needsAction && notify) {
            const title = `上游更新 ${status.behind} 个提交，${status.reviewCount} 个需人工`;
            const body = [
                `可自动合并 ${status.autoCount} / 需人工 ${status.reviewCount}`,
                status.conflicts.ok ? (status.conflicts.conflicts.length ? `冲突预演: ${status.conflicts.conflicts.join(' ')}` : '冲突预演: 无冲突') : `冲突预演未完成: ${status.conflicts.note ?? ''}`,
                `工作树未提交 ${status.dirtyFiles} 个文件`,
            ].join('\n');
            try {
                status.notified = await notify({ title, text: body, level: 'action' });
                log(`通知投递: ${status.notified ? '成功' : '未送达'}`);
            }
            catch (e) {
                status.notified = false;
                log(`通知失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        last = status;
        log(`巡检完成 trigger=${trigger} head=${status.head.slice(0, 7)} tip=${status.fetch.tip?.slice(0, 7) ?? '?'} ` +
            `behind=${status.behind ?? '?'} dirty=${status.dirtyFiles} auto=${status.autoCount} review=${status.reviewCount} ` +
            `conflicts=${status.conflicts.ok ? (status.conflicts.conflicts.length || '无') : '未预演'}`);
        return status;
    }
    async function tick(nowTs = now()) {
        if (!enabled)
            return { ran: false, skipped: 'disabled' };
        const st = loadState();
        const parts = beijingParts(nowTs);
        const inWindow = parts.hour === runHour && parts.minute < windowMinutes;
        if (!inWindow)
            return { ran: false, skipped: `not-window(北京 ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')})` };
        if (st.lastRunDay === parts.dayKey)
            return { ran: false, skipped: 'already-ran-today' };
        if (busy)
            return { ran: false, skipped: 'busy' };
        if (!tryLock())
            return { ran: false, skipped: 'locked' };
        busy = true;
        try {
            await runOnce('schedule');
            return { ran: true };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`巡检异常: ${msg}`);
            const s2 = loadState();
            s2.attemptsToday = (s2.attemptsToday ?? 0) + 1;
            saveState(s2);
            return { ran: false, skipped: `error:${msg}` };
        }
        finally {
            busy = false;
            unlock();
        }
    }
    async function runNow() {
        if (!tryLock()) {
            // 手动触发也尊重锁；但把"被占用"如实抛给调用方
            throw new Error('另一个巡检正在进行（锁被占用）');
        }
        busy = true;
        try {
            return await runOnce('manual');
        }
        finally {
            busy = false;
            unlock();
        }
    }
    function start() {
        if (timer)
            return;
        timer = setInterval(() => {
            void tick().catch(() => { });
        }, tickIntervalMs);
        timer.unref?.();
        log(`已武装 · 每 ${Math.round(tickIntervalMs / 60000)}min 检查窗口 · 北京 ${String(runHour).padStart(2, '0')}:00–` +
            `${String(runHour).padStart(2, '0')}:${String(windowMinutes).padStart(2, '0')} · repo=${repo}`);
        setTimeout(() => {
            void tick().catch(() => { });
        }, 60 * 1000).unref?.();
    }
    function stop() {
        if (timer)
            clearInterval(timer);
        timer = null;
        log('已停止');
    }
    return {
        start,
        stop,
        tick,
        runNow,
        snapshot: () => {
            const st = loadState();
            const parts = beijingParts(now());
            return {
                ...st,
                enabled,
                inWindow: parts.hour === runHour && parts.minute < windowMinutes,
                dayKey: parts.dayKey,
            };
        },
        lastStatus: () => last,
    };
}
// ── API ─────────────────────────────────────────────────────────
/**
 * API 主通道（api.github.com 稳定；github.com:443 间歇不可达）。
 * 每次调用独立超时——单次 fetch 不能因为 API 慢就把整轮拖死。
 */
function apiGet(url, timeoutMs, token = '') {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'dsh-upstream-watch',
                Accept: 'application/vnd.github+json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                }
                catch (e) {
                    reject(e instanceof Error ? e : new Error(String(e)));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('API timeout'));
        });
        req.on('error', reject);
    });
}
// ── 报告渲染 ─────────────────────────────────────────────────────
export function renderReport(s, ctx) {
    const bj = beijingParts(s.finishedAt || s.startedAt);
    const lines = [];
    lines.push(`# 上游同步巡检 ${bj.dayKey} 北京 ${String(bj.hour).padStart(2, '0')}:${String(bj.minute).padStart(2, '0')}`);
    lines.push('');
    lines.push(`- 触发: ${s.trigger === 'manual' ? '手动' : `定时窗口 ${ctx.runHour}:00–${ctx.runHour}:${String(ctx.windowMinutes).padStart(2, '0')}`}`);
    lines.push(`- 仓库: \`${ctx.repo}\``);
    lines.push(`- HEAD: \`${s.head.slice(0, 10)}\`  上游: \`${s.fetch.tip?.slice(0, 10) ?? '未知'}\` (${s.fetch.channel})`);
    lines.push(`- 差距: 落后 ${s.behind ?? '?'} / 领先 ${s.ahead ?? '?'}`);
    lines.push(`- 抓取: ${s.fetch.detail}`);
    lines.push(`- 工作树未提交改动: ${s.dirtyFiles} 个${s.dirtyFiles ? `（${s.dirtySample.join(' | ')}）` : ''}`);
    lines.push('');
    lines.push('## 冲突预演');
    if (!s.conflicts.ok) {
        lines.push(`未完成（结论不可信）: ${s.conflicts.note ?? ''}`);
    }
    else if (s.conflicts.conflicts.length === 0) {
        lines.push('无冲突 ✓（merge-tree 纯内存预演，未改动工作树）');
    }
    else {
        lines.push(`冲突文件 ${s.conflicts.conflicts.length} 个:`);
        for (const f of s.conflicts.conflicts)
            lines.push(`- ${f}`);
    }
    lines.push('');
    if (s.hasUpdates === undefined) {
        lines.push('## 无法判定是否有更新');
        if (s.behind === 0) {
            lines.push(`本轮探测没发现落后提交，但上游 tip 来源是 **${s.fetch.channel}**（可能是旧值）→ 不做"无更新"断言。`);
        }
        else {
            lines.push('tip 或对象缺失（API/git 均未拿到）→ 本次不做"无更新"断言。');
        }
        lines.push('');
        lines.push(`可用：落后 ${s.behind ?? '?'} / 领先 ${s.ahead ?? '?'}${s.behind ? '（已是可信下界）' : ''}`);
    }
    else if (!s.hasUpdates) {
        lines.push('## 无上游更新');
    }
    else {
        lines.push(`## 分级：可自动合并 ${s.autoCount} / 需人工 ${s.reviewCount}`);
        lines.push('');
        lines.push('| 判定 | 类型 | churn | 文件 | 测试 | 提交 |');
        lines.push('|---|---|---|---|---|---|');
        for (const c of s.classified) {
            lines.push(`| ${c.verdict} | ${c.category}/${c.kind} | ${c.churn} | ${c.files} | ${c.tests} | \`${c.short}\` ${c.subject} |`);
        }
        lines.push('');
        lines.push('### 逐条依据');
        for (const c of s.classified) {
            lines.push(`- \`${c.short}\` **${c.verdict}** — ${c.reasons.join('；')}`);
        }
    }
    lines.push('');
    lines.push('> 本次为只读巡检：未执行 merge / commit / reset / checkout / push，工作树未改动。');
    if (s.hasUpdates)
        lines.push('> 合并后必须 `npm run build`（`lib/` 是入库构建产物）。');
    lines.push('');
    return lines.join('\n');
}
// ── 默认通知：走 DSHA 3090 桥（不依赖 curl，诚实报告送达情况） ─
export function makeBridgeNotifier(bridge = { base: 'http://127.0.0.1:3090', headersFile: '/root/.dsh/.bridge_headers' }) {
    return async (n) => {
        let authHeaders = {};
        try {
            const raw = fs.readFileSync(bridge.headersFile, 'utf8');
            for (const line of raw.split('\n')) {
                const i = line.indexOf(':');
                if (i > 0)
                    authHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
        }
        catch {
            return false; // 没凭据就不假装发过了
        }
        const qs = `title=${encodeURIComponent(n.title)}&text=${encodeURIComponent(n.text)}`;
        return new Promise((resolve) => {
            const req = http.get(`${bridge.base}/app/notify?${qs}`, { headers: authHeaders, timeout: 10 * 1000 }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    // 桥对不是前台场景会回 FOREGROUND_SKIP：如实判为未送达
                    const delivered = !/FOREGROUND_SKIP|NOT_FOUND|DISABLED/.test(body);
                    resolve(delivered);
                });
            });
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.on('error', () => resolve(false));
        });
    };
}
//# sourceMappingURL=upstream-watch.js.map