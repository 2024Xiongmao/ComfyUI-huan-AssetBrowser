import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "huan_AssetBrowser";
const HTML_URL = new URL("../asset_browser.html?embed=1&v=20261119-1", import.meta.url).href;
const STYLE_ID = "huan-asset-browser-style";
const ORIGIN = window.location.origin;

const syncWaiters = new Set();
const perImageNodes = new Set();
const runnerBars = new Map();
let queueGuardInstalled = false;
let perImageRunning = false;

// 续跑：一次只提交一张，等这一张跑完再提交下一张；
// 等待期间新放进文件夹（并同步进节点）的图片会追加到队尾。
const RUNNER_IDLE_WAIT = 2000;
const RUNNER_TASK_TIMEOUT = 60 * 60 * 1000;

const runner = {
    active: false,
    cancelled: false,
    node: null,
    lastNode: null,
    queue: [],
    seen: new Set(),
    done: new Set(),
    total: 0,
    finished: 0,
    failed: 0,
    current: null,
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function entryKey(entry) {
    if (!entry) return "";
    const origin = entry.origin || entry.source || entry.path || "";
    if (!origin) return "";
    return `${origin}|${entry.size ?? ""}|${entry.mtime ?? ""}`;
}

function postToNode(node, payload) {
    try {
        node?.huanAssetBrowser?.iframe?.contentWindow?.postMessage(payload, ORIGIN);
    } catch (error) {
        // ignore
    }
}

function runnerSnapshot() {
    const remaining = Math.max(0, runner.total - runner.finished - runner.failed);
    return {
        active: runner.active,
        node: runner.active ? runner.node : null,
        lastNode: runner.lastNode,
        total: runner.total,
        finished: runner.finished,
        failed: runner.failed,
        remaining,
        currentName: runner.current?.entry?.name || "",
        currentOrigin: runner.current?.entry?.origin || "",
        waiting: runner.active && !runner.current && !runner.queue.length,
    };
}

function broadcastRunner() {
    const snap = runnerSnapshot();
    for (const update of runnerBars.values()) {
        try {
            update(snap);
        } catch (error) {
            // ignore
        }
    }
    if (runner.node) {
        postToNode(runner.node, {
            type: "HUAN_ASSET_RUN_STATUS",
            active: snap.active,
            done: Array.from(runner.done),
            current: snap.currentOrigin,
            finished: snap.finished,
            total: snap.total,
        });
    }
}

/** 把新同步进来的图片追加到续跑队列，返回实际加入的张数。 */
function runnerOfferEntries(entries) {
    if (!runner.active || !Array.isArray(entries) || !entries.length) return 0;
    let added = 0;
    for (const entry of entries) {
        if (!entry || !entry.path) continue;
        const key = entryKey(entry);
        if (!key || runner.seen.has(key)) continue;
        runner.queue.push({ key, entry });
        runner.seen.add(key);
        added += 1;
    }
    if (added) {
        runner.total += added;
        broadcastRunner();
    }
    return added;
}

function extractPromptId(result) {
    if (!result || typeof result !== "object") return "";
    const candidates = [
        result.prompt_id,
        result.promptId,
        result?.data?.prompt_id,
        result?.response?.prompt_id,
    ];
    for (const value of candidates) {
        if (value) return String(value);
    }
    return "";
}

async function promptStillQueued(promptId) {
    try {
        const response = await api.fetchApi("/queue");
        if (!response?.ok) return null;
        const data = await response.json().catch(() => null);
        if (!data) return null;
        const all = [
            ...(Array.isArray(data.queue_running) ? data.queue_running : []),
            ...(Array.isArray(data.queue_pending) ? data.queue_pending : []),
        ];
        return all.some((item) => Array.isArray(item) && String(item[1]) === promptId);
    } catch (error) {
        return null;
    }
}

/** 等一个任务真正执行结束（优先用 /history，拿不到 prompt_id 时退回队列计数）。 */
async function waitPromptFinished(promptId) {
    const deadline = Date.now() + RUNNER_TASK_TIMEOUT;
    let missing = 0;
    while (!runner.cancelled && Date.now() < deadline) {
        if (promptId) {
            try {
                const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
                if (response?.ok) {
                    const data = await response.json().catch(() => null);
                    if (data && data[promptId]) return true;
                }
            } catch (error) {
                // 网络抖动时继续等
            }
            const queued = await promptStillQueued(promptId);
            if (queued === false) {
                missing += 1;
                if (missing >= 3) return false;
            } else {
                missing = 0;
            }
        } else {
            const remaining = typeof api.getQueueRemaining === "function" ? api.getQueueRemaining() : 0;
            if (!remaining) {
                missing += 1;
                if (missing >= 2) return true;
            } else {
                missing = 0;
            }
        }
        await sleep(1200);
    }
    return false;
}

function stopRunner() {
    if (!runner.active) return;
    runner.cancelled = true;
    runner.queue = [];
    broadcastRunner();
    showToastMessage("正在停止续跑：当前这一张跑完后结束。", "info");
}

function startRunner(job, originalQueuePrompt, context, args) {
    runner.active = true;
    runner.cancelled = false;
    runner.node = job.node;
    runner.lastNode = job.node;
    runner.queue = [];
    runner.seen.clear();
    runner.done.clear();
    runner.total = 0;
    runner.finished = 0;
    runner.failed = 0;
    runner.current = null;

    void runRunnerLoop(job, originalQueuePrompt, context, args);
    return true;
}

async function runRunnerLoop(job, originalQueuePrompt, context, args) {
    const currentEntries = () => {
        const stored = job.node?.huanAppliedEntries;
        return Array.isArray(stored) && stored.length ? stored : job.entries;
    };
    const restoreWidget = () => {
        let changed = false;
        try {
            const full = JSON.stringify(currentEntries());
            if (job.widget.value !== full) {
                job.widget.value = full;
                changed = true;
            }
        } catch (error) {
            // ignore
        }
        if (changed) {
            try {
                job.node?.setDirtyCanvas?.(true, true);
            } catch (error) {
                // ignore
            }
        }
    };

    postToNode(job.node, { type: "HUAN_ASSET_RUNNER", active: true });
    runnerOfferEntries(currentEntries());
    broadcastRunner();

    let aborted = false;
    try {
        while (!runner.cancelled) {
            if (!runner.queue.length) {
                runner.current = null;
                restoreWidget();
                runnerOfferEntries(currentEntries());
                if (!runner.queue.length) {
                    broadcastRunner();
                    await sleep(RUNNER_IDLE_WAIT);
                    continue;
                }
            }

            const item = runner.queue.shift();
            runner.current = item;
            job.widget.value = JSON.stringify([item.entry]);
            broadcastRunner();

            let result = null;
            try {
                result = await originalQueuePrompt.apply(context, args);
            } catch (error) {
                console.error("[huan AssetBrowser] runner submit failed", error);
                showToastMessage(`提交任务失败：${error?.message || error}`);
                aborted = true;
                break;
            }
            if (result === false) {
                runner.failed += 1;
                aborted = true;
                break;
            }

            const promptId = extractPromptId(result);
            const ok = await waitPromptFinished(promptId);
            if (runner.cancelled) break;
            if (!ok) {
                // 任务被取消或长时间没有结果：停下来，避免继续盲跑后面的图。
                runner.failed += 1;
                aborted = true;
                restoreWidget();
                broadcastRunner();
                break;
            }
            runner.done.add(item.key);
            runner.finished += 1;
            restoreWidget();
            broadcastRunner();
        }
    } catch (error) {
        console.error("[huan AssetBrowser] runner failed", error);
        showToastMessage(`续跑中断：${error?.message || error}`);
        aborted = true;
    } finally {
        const finished = runner.finished;
        const failed = runner.failed;
        runner.active = false;
        runner.current = null;
        runner.queue = [];
        runner.seen.clear();
        restoreWidget();
        postToNode(job.node, { type: "HUAN_ASSET_RUNNER", active: false });
        broadcastRunner();
        if (finished || failed) {
            if (aborted) {
                showToastMessage(`续跑已停止：已跑 ${finished} 张，${failed} 张未完成。`, "warn");
            } else {
                showToastMessage(
                    `续跑结束：共跑 ${finished} 张${failed ? `，${failed} 张未完成` : ""}。`,
                    "success"
                );
            }
        }
    }
}

function showToastMessage(message, severity = "error") {
    try {
        const toast = app.extensionManager?.toast;
        if (toast?.add) {
            toast.add({
                severity,
                summary: "huan 素材浏览器",
                detail: message,
                life: severity === "error" ? 6000 : 4000,
            });
            return;
        }
    } catch (error) {
        // fall through to console
    }
    console.warn("[huan AssetBrowser]", message);
}

function collectPerImageJobs() {
    const jobs = [];
    for (const node of perImageNodes) {
        if (!node || !node.properties) continue;
        if (!node.properties.huan_per_image && !node.properties.huan_auto_continue) continue;
        const widget = node.widgets?.find((item) => item.name === "images_data");
        if (!widget) continue;
        let entries = [];
        try {
            const parsed = JSON.parse(widget.value || "[]");
            entries = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            entries = [];
        }
        if (entries.length) jobs.push({ node, widget, entries });
    }
    return jobs;
}

/**
 * 逐张运行：把每个选中的图片分别作为一次任务的输入，按顺序提交到队列。
 * 返回 null 表示不需要逐张（交给原始 queuePrompt），否则返回是否成功提交。
 */
async function queuePerImage(originalQueuePrompt, context, args) {
    const jobs = collectPerImageJobs();

    if (runner.active) {
        // 续跑中再点运行：把当前新选中的图片补进队列即可，不重复起一轮。
        const primary = jobs.length
            ? jobs.reduce((a, b) => (b.entries.length > a.entries.length ? b : a), jobs[0])
            : null;
        const added = primary
            ? runnerOfferEntries(primary.node?.huanAppliedEntries || primary.entries)
            : 0;
        showToastMessage(
            added
                ? `已把 ${added} 张新图片加入续跑队列，等当前这张跑完就接着跑。`
                : "续跑进行中：队列里的图片跑完会继续等新图，点节点上的「停止」可结束。",
            added ? "success" : "info"
        );
        return false;
    }

    if (!jobs.length) return null;

    const auto = jobs.some((job) => job.node?.properties?.huan_auto_continue);
    const primary = jobs.reduce((a, b) => (b.entries.length > a.entries.length ? b : a), jobs[0]);
    if (auto) {
        if (!primary.entries.length) return null;
        return startRunner(primary, originalQueuePrompt, context, args);
    }

    const total = Math.max(...jobs.map((job) => job.entries.length));
    if (total < 2) return null;

    if (perImageRunning) {
        showToastMessage("正在按顺序提交任务，请稍候…");
        return false;
    }

    perImageRunning = true;
    let submitted = 0;
    try {
        for (let index = 0; index < total; index += 1) {
            for (const job of jobs) {
                const entry = job.entries[index % job.entries.length];
                job.widget.value = JSON.stringify([entry]);
            }
            const result = await originalQueuePrompt.apply(context, args);
            if (result === false) break;
            submitted += 1;
        }
    } catch (error) {
        console.error("[huan AssetBrowser] per-image queue failed", error);
        showToastMessage(`逐张提交中断：${error?.message || error}`);
    } finally {
        for (const job of jobs) {
            job.widget.value = JSON.stringify(job.entries);
            try {
                job.node.setDirtyCanvas?.(true, true);
            } catch (error) {
                // ignore
            }
        }
        perImageRunning = false;
    }

    if (submitted > 0) {
        showToastMessage(`已按顺序提交 ${submitted} 个任务，每张图片跑一次完整工作流。`, "success");
    }
    return submitted > 0;
}

function installQueueGuard() {
    if (queueGuardInstalled || typeof app.queuePrompt !== "function") return;
    const originalQueuePrompt = app.queuePrompt;
    app.queuePrompt = async function (...args) {
        if (syncWaiters.size) {
            const waiters = Array.from(syncWaiters);
            const results = await Promise.all(waiters.map((waiter) => {
                try {
                    return Promise.resolve(waiter());
                } catch (error) {
                    console.warn("[huan AssetBrowser] sync waiter failed", error);
                    return true;
                }
            }));
            if (results.some((ok) => ok === false)) {
                showToastMessage("自动同步失败，队列未提交，请重新选择图片后重试。");
                return false;
            }
        }
        const perImage = await queuePerImage(originalQueuePrompt, this, args);
        if (perImage !== null) return perImage;
        return originalQueuePrompt.apply(this, args);
    };
    queueGuardInstalled = true;
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .huan-ab-shell {
            width: 100%;
            height: 100%;
            min-height: 560px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid #2d2d32;
            border-radius: 10px;
            background: #0f0f11;
        }
        .huan-ab-bar {
            flex: none;
            height: 34px;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 10px;
            border-bottom: 1px solid #29292e;
            background: #18181b;
            color: #8c8b92;
            font: 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif;
            user-select: none;
        }
        .huan-ab-dot {
            width: 6px;
            height: 6px;
            flex: none;
            border-radius: 50%;
            background: #696971;
            box-shadow: 0 0 0 3px rgba(255,255,255,.03);
        }
        .huan-ab-bar.pending .huan-ab-dot {
            background: #d2b477;
            box-shadow: 0 0 0 3px rgba(210,180,119,.1);
        }
        .huan-ab-bar.applied .huan-ab-dot {
            background: #8fa47d;
            box-shadow: 0 0 0 3px rgba(143,164,125,.1);
        }
        .huan-ab-bar.error .huan-ab-dot {
            background: #d1847c;
            box-shadow: 0 0 0 3px rgba(209,132,124,.1);
        }
        .huan-ab-status {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .huan-ab-count {
            flex: none;
            height: 20px;
            display: inline-flex;
            align-items: center;
            padding: 0 7px;
            border: 1px solid #313137;
            border-radius: 999px;
            background: #1d1d21;
            color: #7e7e86;
            font: 10px/1 ui-monospace, SFMono-Regular, Consolas, "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace;
            white-space: nowrap;
        }
        .huan-ab-bar.applied .huan-ab-count {
            border-color: #3e4939;
            background: #232820;
            color: #aebfa0;
        }
        .huan-ab-bar.pending .huan-ab-count {
            border-color: #4a4232;
            background: #29251d;
            color: #c6b082;
        }
        .huan-ab-bar.error .huan-ab-count {
            border-color: #4d3836;
            background: #2b2020;
            color: #d19a94;
        }
        .huan-ab-toggle {
            flex: none;
            height: 20px;
            display: inline-flex;
            align-items: center;
            padding: 0 8px;
            border: 1px solid #313137;
            border-radius: 999px;
            background: #1d1d21;
            color: #7e7e86;
            font: 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif;
            white-space: nowrap;
            cursor: pointer;
            transition: background .15s, color .15s, border-color .15s;
        }
        .huan-ab-toggle:hover:not(:disabled) {
            background: #24242a;
            border-color: #3d3d45;
            color: #cfcdc6;
        }
        .huan-ab-toggle.on {
            border-color: #4a4232;
            background: #29251d;
            color: #d2b477;
        }
        .huan-ab-toggle:disabled {
            opacity: .45;
            cursor: default;
        }
        .huan-ab-frame {
            position: relative;
            flex: 1;
            min-height: 0;
            background: #0f0f11;
        }
        .huan-ab-frame iframe {
            width: 100%;
            height: 100%;
            min-height: 520px;
            border: 0;
            display: block;
            background: #0f0f11;
        }
    `;
    document.head.appendChild(style);
}

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function hideImagesDataWidget(node) {
    const widget = getWidget(node, "images_data");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.label = "";
    widget.computeSize = () => [0, -4];
}

function parseApplied(value) {
    try {
        const entries = JSON.parse(value || "[]");
        return Array.isArray(entries) ? entries : [];
    } catch (error) {
        return [];
    }
}

app.registerExtension({
    name: "huan.assetbrowser",

    async setup() {
        installQueueGuard();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;
            injectStyles();

            const dataWidget = getWidget(node, "images_data");
            hideImagesDataWidget(node);
            let appliedEntries = parseApplied(dataWidget?.value);
            let appliedCount = appliedEntries.length;
            let selectionCount = 0;
            let selectionSignature = "";
            let uploading = false;
            let syncWaitPromise = null;
            let syncWaitResolve = null;

            const shell = document.createElement("div");
            shell.className = "huan-ab-shell";

            const bar = document.createElement("div");
            bar.className = "huan-ab-bar";
            const dot = document.createElement("span");
            dot.className = "huan-ab-dot";
            const statusText = document.createElement("span");
            statusText.className = "huan-ab-status";
            statusText.textContent = "正在加载素材浏览器…";
            const countChip = document.createElement("span");
            countChip.className = "huan-ab-count";
            countChip.textContent = appliedCount ? `已同步 ${appliedCount} 张` : "未同步";
            const perImageBtn = document.createElement("button");
            perImageBtn.type = "button";
            perImageBtn.className = "huan-ab-toggle";
            perImageBtn.textContent = "逐张";
            const autoBtn = document.createElement("button");
            autoBtn.type = "button";
            autoBtn.className = "huan-ab-toggle";
            autoBtn.textContent = "续跑";
            bar.append(dot, statusText, perImageBtn, autoBtn, countChip);
            shell.appendChild(bar);

            const frame = document.createElement("div");
            frame.className = "huan-ab-frame";
            const iframe = document.createElement("iframe");
            iframe.src = HTML_URL;
            iframe.allow = "clipboard-read; clipboard-write";
            iframe.setAttribute("tabindex", "0");
            frame.appendChild(iframe);
            shell.appendChild(frame);

            try {
                if (typeof node.addDOMWidget === "function") {
                    node.addDOMWidget("huan_asset_browser", "HUAN_ASSET_BROWSER", shell, {
                        getValue() { return ""; },
                        setValue() { },
                        hideOnZoom: false,
                        serialize: false,
                        computeSize: (width) => [Math.max(720, width), 560],
                    });
                }
            } catch (error) {
                console.error("[huan AssetBrowser] failed to add DOM widget", error);
            }

            node.huanAssetBrowser = { shell, bar, iframe };

            const setBar = (state, message, chip) => {
                bar.classList.remove("pending", "applied", "error");
                if (state) bar.classList.add(state);
                statusText.textContent = message;
                if (chip !== undefined) countChip.textContent = chip;
            };

            const idleMessage = () => {
                if (appliedCount > 0) {
                    setBar(
                        "applied",
                        `已自动同步 ${appliedCount} 张图片 · 连接标准预览图像节点直接运行`,
                        `已同步 ${appliedCount} 张`
                    );
                } else {
                    setBar("", "在下方选择图片，连接标准预览图像节点后直接运行", "未同步");
                }
            };

            const refreshAppliedFromWidget = () => {
                appliedEntries = parseApplied(getWidget(node, "images_data")?.value);
                appliedCount = appliedEntries.length;
                node.huanAppliedEntries = appliedEntries;
                idleMessage();
                refreshPerImage();
            };

            const setPerImage = (on) => {
                node.properties = node.properties || {};
                node.properties.huan_per_image = Boolean(on);
                const enabled = Boolean(on);
                perImageBtn.classList.toggle("on", enabled);
                perImageBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
                perImageBtn.textContent = enabled ? `逐张 · ${appliedCount || 0}` : "逐张";
                perImageBtn.disabled = !appliedCount;
                perImageBtn.title = enabled
                    ? `点运行会按顺序提交 ${appliedCount || 0} 个任务，每张图片单独跑一次完整工作流；点击关闭`
                    : "开启后点运行会按顺序一张一张跑完整工作流（每张图片单独一次任务）";
            };

            const refreshPerImage = () => setPerImage(Boolean(node.properties?.huan_per_image));

            const setAutoContinue = (on) => {
                node.properties = node.properties || {};
                node.properties.huan_auto_continue = Boolean(on);
                const enabled = Boolean(on);
                autoBtn.classList.toggle("on", enabled);
                autoBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
                autoBtn.textContent = "续跑";
                autoBtn.title = enabled
                    ? "已开启续跑：点运行后一张一张跑，跑完会继续等新图（点「停止」结束）"
                    : "开启后：点运行按顺序一张一张跑，跑完自动等新放进文件夹的图片接着跑";
            };

            const refreshAutoContinue = () => setAutoContinue(Boolean(node.properties?.huan_auto_continue));

            perImageBtn.addEventListener("click", () => {
                if (runner.active && runner.node === node) {
                    showToastMessage("续跑进行中，先点「停止」再改逐张设置。", "info");
                    return;
                }
                const next = !node.properties?.huan_per_image;
                setPerImage(next);
                if (!next && node.properties?.huan_auto_continue) setAutoContinue(false);
            });

            autoBtn.addEventListener("click", () => {
                if (runner.active && runner.node === node) {
                    stopRunner();
                    return;
                }
                const next = !node.properties?.huan_auto_continue;
                setAutoContinue(next);
                if (next && !node.properties?.huan_per_image) setPerImage(true);
            });

            perImageNodes.add(node);

            runnerBars.set(node, (snap) => {
                if (snap.active) {
                    if (snap.node !== node) return;
                    autoBtn.classList.add("on");
                    autoBtn.textContent = "停止";
                    autoBtn.title = "点这里结束续跑（当前这一张会跑完）";
                    if (snap.waiting) {
                        setBar(
                            "applied",
                            `续跑待机 · 已完成 ${snap.finished} 张 · 等新图片放进来（点「停止」结束）`,
                            `已跑 ${snap.finished}`
                        );
                    } else {
                        setBar(
                            "pending",
                            `续跑中 ${snap.finished}/${snap.total} · ${snap.currentName || "准备中"}`,
                            `待跑 ${snap.remaining}`
                        );
                    }
                    return;
                }
                refreshAutoContinue();
                refreshPerImage();
                if (snap.lastNode !== node) return;
                if (snap.finished || snap.failed) {
                    setBar(
                        snap.failed ? "error" : "applied",
                        `续跑结束 · 已跑 ${snap.finished} 张${snap.failed ? ` · ${snap.failed} 张未完成` : ""}`,
                        `已跑 ${snap.finished}`
                    );
                } else {
                    idleMessage();
                }
            });

            const sendToIframe = (payload) => {
                try {
                    iframe.contentWindow?.postMessage(payload, ORIGIN);
                } catch (error) {
                    console.warn("[huan AssetBrowser] sendToIframe failed", error);
                }
            };

            const ensureSyncWait = () => {
                if (!syncWaitPromise) {
                    syncWaitPromise = new Promise((resolve) => {
                        syncWaitResolve = resolve;
                    });
                }
            };

            const finishSyncWait = (ok) => {
                const resolve = syncWaitResolve;
                syncWaitResolve = null;
                syncWaitPromise = null;
                if (resolve) resolve(ok);
            };

            const waitForSync = () => syncWaitPromise || Promise.resolve(true);
            syncWaiters.add(waitForSync);

            const uploadSelection = async (data) => {
                if (uploading) return;
                const requestId = String(data.requestId || "");
                const incoming = Array.isArray(data.files) ? data.files : [];
                if (!requestId || !incoming.length) {
                    sendToIframe({
                        type: "HUAN_ASSET_ERROR",
                        requestId,
                        message: "没有收到可同步的图片。",
                    });
                    return;
                }

                uploading = true;
                if (!(runner.active && runner.node === node)) {
                    setBar(
                        "pending",
                        `正在自动同步 ${incoming.length} 张图片…`,
                        "同步中"
                    );
                }

                try {
                    // 已经同步过、且内容没变的图片直接复用服务器上的副本，
                    // 只上传新增/改动过的文件（实时监听时会反复同步）。
                    const known = new Map();
                    for (const entry of appliedEntries) {
                        const key = entry?.origin || entry?.source;
                        if (key) known.set(key, entry);
                    }

                    const plan = [];
                    const form = new FormData();
                    const paths = [];
                    for (const item of incoming) {
                        const file = item?.file;
                        if (!file || typeof file.size !== "number") continue;
                        const source = item.path || item.name || file.name || `image_${plan.length + 1}`;
                        const previous = known.get(source);
                        const reusable = Boolean(
                            previous
                            && previous.path
                            && previous.size === file.size
                            && (previous.mtime === undefined || previous.mtime === file.lastModified)
                        );
                        plan.push({ item, file, source, previous, reusable });
                        if (!reusable) {
                            form.append("files", file, item.name || file.name || `image_${paths.length + 1}`);
                            paths.push(source);
                        }
                    }
                    if (!plan.length) throw new Error("没有可上传的图片数据。");

                    let uploadedFiles = [];
                    if (paths.length) {
                        form.append("paths", JSON.stringify(paths));
                        const response = await api.fetchApi("/huan_asset_browser/upload", {
                            method: "POST",
                            body: form,
                        });
                        let payload = null;
                        try {
                            payload = await response.json();
                        } catch (error) {
                            payload = null;
                        }
                        if (!response.ok || !payload?.ok) {
                            if (response.status === 413) {
                                throw new Error(
                                    "单次同步体积超过 ComfyUI 上传上限（--max-upload-size，默认 100MB）。请减少一次选择的图片数量，或启动 ComfyUI 时调大该值。"
                                );
                            }
                            throw new Error(payload?.error || `上传失败（HTTP ${response.status}）`);
                        }
                        uploadedFiles = Array.isArray(payload.files) ? payload.files : [];
                        if (uploadedFiles.length !== paths.length) {
                            throw new Error("ComfyUI 返回的图片数量与上传数量不一致，请重试。");
                        }
                    }

                    let cursor = 0;
                    const entries = plan.map(({ item, file, source, previous, reusable }) => {
                        if (reusable) {
                            return {
                                ...previous,
                                name: item.name || previous.name,
                                origin: source,
                                mtime: file.lastModified,
                            };
                        }
                        const saved = uploadedFiles[cursor];
                        cursor += 1;
                        if (!saved) return null;
                        return {
                            path: saved.path,
                            name: saved.name,
                            width: saved.width,
                            height: saved.height,
                            source: saved.source || source,
                            origin: source,
                            size: saved.size,
                            mtime: file.lastModified,
                        };
                    }).filter(Boolean);
                    if (!entries.length) throw new Error("ComfyUI 没有返回已保存的图片。");

                    const widget = getWidget(node, "images_data");
                    const runnerOwnsWidget = runner.active && runner.node === node;
                    // 续跑时会临时把 images_data 换成单张再提交，
                    // 这里不要再回写整批，否则可能把正在提交的任务改成整批。
                    if (widget && !runnerOwnsWidget) widget.value = JSON.stringify(entries);
                    appliedEntries = entries;
                    appliedCount = entries.length;
                    node.huanAppliedEntries = entries;
                    node.properties = node.properties || {};
                    node.properties.huan_applied_count = appliedCount;
                    node.properties.huan_applied_at = Date.now();
                    refreshPerImage();
                    if (runner.active && runner.node === node) {
                        const added = runnerOfferEntries(entries);
                        if (added) {
                            showToastMessage(`新增 ${added} 张图片已加入续跑队列。`, "success");
                        }
                    }
                    node.setDirtyCanvas(true, true);
                    app.graph.setDirtyCanvas(true, true);

                    const latestSelection = !data.signature || !selectionSignature || data.signature === selectionSignature;
                    if (latestSelection) {
                        selectionCount = incoming.length;
                        if (runner.active && runner.node === node) {
                            broadcastRunner();
                        } else {
                            setBar(
                                "applied",
                                `已自动同步 ${appliedCount} 张图片 · 连接标准预览图像节点直接运行`,
                                `已同步 ${appliedCount} 张`
                            );
                        }
                        finishSyncWait(true);
                    } else {
                        setBar("pending", `已选择新图片 · 正在自动同步…`, "同步中");
                    }
                    sendToIframe({
                        type: "HUAN_ASSET_APPLIED",
                        requestId,
                        count: appliedCount,
                        signature: data.signature || "",
                    });
                } catch (error) {
                    console.error("[huan AssetBrowser] auto sync failed", error);
                    setBar("error", error.message || "自动同步失败", "失败");
                    finishSyncWait(false);
                    sendToIframe({
                        type: "HUAN_ASSET_ERROR",
                        requestId,
                        message: error.message || "自动同步失败，请重试。",
                    });
                } finally {
                    uploading = false;
                }
            };

            const onMessage = (event) => {
                if (event.source !== iframe.contentWindow) return;
                if (event.origin && event.origin !== ORIGIN) return;
                const data = event.data || {};
                if (data.type === "HUAN_ASSET_FRAME_READY") {
                    idleMessage();
                    return;
                }
                if (data.type === "HUAN_ASSET_SELECTION") {
                    selectionCount = Number(data.count) || 0;
                    selectionSignature = String(data.signature || "");
                    if (selectionCount > 0 && !data.applied) {
                        ensureSyncWait();
                        setBar(
                            "pending",
                            `已选 ${selectionCount} 张 · 正在自动同步…`,
                            "同步中"
                        );
                    } else {
                        if (data.applied) finishSyncWait(true);
                        idleMessage();
                    }
                    return;
                }
                if (data.type === "HUAN_ASSET_APPLY") {
                    uploadSelection(data);
                    return;
                }
                if (data.type === "HUAN_ASSET_CLEAR") {
                    const widget = getWidget(node, "images_data");
                    if (widget && !(runner.active && runner.node === node)) widget.value = "[]";
                    appliedEntries = [];
                    appliedCount = 0;
                    node.huanAppliedEntries = [];
                    selectionCount = 0;
                    selectionSignature = "";
                    node.properties = node.properties || {};
                    node.properties.huan_applied_count = 0;
                    node.properties.huan_applied_at = Date.now();
                    node.setDirtyCanvas(true, true);
                    app.graph.setDirtyCanvas(true, true);
                    finishSyncWait(true);
                    idleMessage();
                    refreshPerImage();
                }
            };

            window.addEventListener("message", onMessage);

            iframe.addEventListener("load", () => {
                setTimeout(() => {
                    try {
                        iframe.contentWindow?.postMessage({ type: "HUAN_ASSET_PING" }, ORIGIN);
                    } catch (error) {
                        // ignore
                    }
                }, 250);
            });

            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                const configured = onConfigure?.apply(this, arguments);
                hideImagesDataWidget(node);
                window.setTimeout(refreshAppliedFromWidget, 0);
                return configured;
            };

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                window.removeEventListener("message", onMessage);
                syncWaiters.delete(waitForSync);
                perImageNodes.delete(node);
                runnerBars.delete(node);
                if (runner.active && runner.node === node) {
                    runner.cancelled = true;
                    runner.queue = [];
                    runner.seen.clear();
                }
                finishSyncWait(true);
                try { iframe.src = "about:blank"; } catch (error) { /* ignore */ }
                onRemoved?.apply(this, arguments);
            };

            node.setSize([1120, 760]);
            node.huanAppliedEntries = appliedEntries;
            idleMessage();
            refreshPerImage();
            refreshAutoContinue();

            return result;
        };
    },
});
