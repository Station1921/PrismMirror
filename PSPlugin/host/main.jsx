#target photoshop

/* =========================================================
 * 棱镜 (Prism) · Photoshop 推送预览插件 — ExtendScript 核心
 * 职责: 将当前活动文档/画板/选区导出为 PNG, 写入 mirror_server
 *       的 watch 目录, 由服务端自动发布, 手机端「棱镜」实时刷新。
 *
 * 导出策略 (零闪屏硬指标: 推送路径上永不建副本、永不切 activeDocument、永不改文档结构):
 *   - 当前画板   : 面板默认项(自适应)—— 有画板推活动图层所属画板、无画板自动退整画布;
 *   - 当前选区   : 只推选区矩形;
 *   - 整个画布   : 面板已不再暴露该选项, 但 mode="canvas" 分支**必须保留** ——
 *                  旧版客户端与外部的 prismExternalPush 仍可能传 "canvas", 照旧整画布推送;
 *   - 上述三者都只直导原文档的**整画布**帧, 同时把"本轮要显示的区域"相对
 *                  画布的像素矩形经 POST /api/view 上报, 由服务端收帧后用 Pillow
 *                  裁一刀再发布(见 server/mirror_server.py 的 view_crop_frame);
 *   - 倍率/降采样: PS 侧交给 Save for Web 的输出缩放(width/height), 服务端侧交给
 *                  shrink_frame。★清晰度定案: 两端默认都不缩放, 帧按设计稿原始
 *                  像素 1:1 传输; PUSH_MAX_AUTO_EDGE / FRAME_MAX_EDGE(4096) 只是
 *                  防超大画布拖死链路的"安全阀", 两值必须保持一致。
 * 为什么裁剪必须放在服务端: 在 PS 侧无论"建副本再删其余画板 / 去画板化 / 打组 /
 * 加蒙版 / crop"还是"直接在活动文档上 crop", 都要改动文档结构或开合文档窗口 ——
 * 跟随帧每帧一次, 现场就是持续闪屏 + 卡操作。裁剪放服务端对 PS 零副作用, 是本
 * 插件"零闪屏"能成立的前提。
 *
 * 临时文件删除职责 (与 server/mirror_server.py 对齐, 避免两边都不删或抢删):
 *   - 成功帧: 插件**不删**。导出成功后文件留在 watch 目录, 由服务端 run_watch
 *             读取并发布进内存后立即 unlink —— 服务端删, 插件不抢删;
 *   - 失败半成品: 插件删。导出失败/中断留下的 0 字节或半截 PNG,
 *             由本侧在 prismPush 的 finally 里清掉, 绝不留给服务端当新帧推送;
 *   - 历史残片: 导出前先清同名旧文件与目录内过期临时文件(clearWatchResidue);
 *   - 异常退出/崩溃遗留: 服务端删。服务端在启动 / 源离线 / 宿主(PS)退出
 *             三个时机统一调用 cleanup_watch_dir() 兜底清理。
 * 本侧清理只删文件, 不删 watch 目录本身, 不动目录外任何内容, 全程容错。
 * ========================================================= */

/* ---------- 路径推导: 数据一律跟随插件安装目录 ----------
 * 全部落点都在 CEP 扩展目录内(本机 = %APPDATA%\Adobe\CEP\extensions\com.prism.mirror.ps):
 *     <ext>\host\main.jsx             本脚本
 *     <ext>\server\MirrorServer.exe   安装器释放的免 Python 服务端
 *     <ext>\data\watch\               帧图中转目录(服务端发布后即删)
 *     <ext>\data\host.beat            宿主(PS)存活租约文件
 * 扩展目录在运行时确定, 不写死任何绝对路径:
 *   1) 面板(client/js/index.js)用 CSInterface.getSystemPath(SystemPath.EXTENSION)
 *      取得扩展目录, 在注入本脚本前写入 PRISM_EXT_ROOT —— 首选;
 *   2) 由本脚本自身位置($.fileName)推导: <ext>\host\xxx.jsx -> <ext>;
 *   3) 兜底: 按 CEP 约定的标准扩展目录拼装。
 * 服务端(mirror_server.py / MirrorServer.exe)按"自身位于 server 子目录"推出同一
 * 根目录, 插件拉起它时再把下面推导出的实际路径显式传入, 两端恒定一致。 */
function prismSlash(p) { return ("" + p).replace(/\\/g, "/").replace(/\/+$/, ""); }

function prismResolveExtRoot() {
    try {
        if (typeof PRISM_EXT_ROOT !== "undefined" && PRISM_EXT_ROOT) {
            return prismSlash(PRISM_EXT_ROOT);
        }
    } catch (e1) {}
    try {
        var me = prismSlash($.fileName);
        if (/\/host\/[^\/]+$/i.test(me)) return me.replace(/\/host\/[^\/]+$/i, "");
    } catch (e2) {}
    try {
        var appdata = $.getenv("APPDATA");
        if (appdata) {
            return prismSlash(appdata) + "/Adobe/CEP/extensions/com.prism.mirror.ps";
        }
    } catch (e3) {}
    return "";
}

/* 构建指纹: 用于确认 PS 里跑的到底是哪一版宿主脚本。
   ★故障史(2026-09-12): 版本号只在 sched_probe.log / tick.log 被引用、却没有定义,
   拼接字符串时直接抛 ReferenceError, 整个诊断写入被吞 —— 表现就是日志"停在旧时间,
   不再新增"。此处定义, 且所有引用统一走 prismBuildTag(): 将来定义再丢也只退化成
   占位文本, 不会打断日志写入。 */
var PRISM_BUILD = "2026-09-15 R9 pycom-gate";

function prismBuildTag() {
    try {
        return (typeof PRISM_BUILD !== "undefined" && PRISM_BUILD) ? ("" + PRISM_BUILD) : "(build 未定义)";
    } catch (e) { return "(build 未定义)"; }
}

var PRISM_ROOT = prismResolveExtRoot();
var PRISM_HOME = PRISM_ROOT + "/data";
var SERVER_DIR = PRISM_ROOT + "/server";
var WATCH_DIR = Folder(PRISM_HOME + "/watch");

/* ---------- 宿主存活心跳 (host lease) ----------
 * 服务端(mirror_server)以"PS 是宿主"为前提: 宿主不在, 服务端不该继续跑。
 * 本脚本运行在 PS 进程内, 每 2s 刷新 <ext>\data\host.beat,
 * PS 退出后脚本随宿主消失、心跳自然停更, 服务端租约超时即自行退出并停发
 * UDP beacon, 手机端"找到设备源"中的本机源随之消失。
 * 因此无需任何 PS 退出钩子 —— 宿主没了, 心跳就没了。
 */
var HOST_BEAT_FILE = new File(PRISM_HOME + "/host.beat");
var HOST_BEAT_MS = 2000;              // 刷新间隔(服务端租约超时 10s)
var HOST_BEAT_TASK_ID = "prismHostBeat";        // 定时任务名(重复注册防护用)
var HOST_BEAT_TASK_CODE = "$.global.PRISM_BEAT()"; // 定时任务脚本串(经全局对象调用, 见文件末挂载)

/* ---------- PS 主机调度器能力探测 ----------
 * 宿主侧所有"自定时"能力都建立在 app.scheduleTask 上。本机 PS 实测该方法并不
 * 存在(日志: 引用错误: app.scheduleTask 不是函数), 此时宿主无法自调度, 统一降级
 * 为"面板驱动": 由 CEP 面板按同一个 PUSH_TICK_MS 节拍 evalScript 触发
 * prismHostTick()。心跳保活、令牌比对、导出等全部逻辑仍留在宿主, 面板只提供
 * 节拍源, 并关闭自己的 autoFollowCheck(两条通道同频导出会叠加成卡顿与闪烁)。
 */
function prismHasScheduler() {
    try { return (typeof app.scheduleTask === "function"); } catch (e) { return false; }
}

/* ---------- 诊断落盘通道 ----------
 * 面板折叠后浏览器日志区不可见/不可靠, 关键事实改为写进 <ext>\data\*.log 事后读:
 *     sched_probe.log  调度器能力实测过程与结论
 *     tick.log         宿主巡检流水(时间 + tick 数 + 节拍来源), 可看出折叠期间节拍是否断过
 * 单文件超过 200KB 即清空重写, 防无限增长; 任何异常都吞掉, 绝不影响推送主链路。 */
var PRISM_DIAG_MAX = 200000;

function prismDiagAppend(name, line) {
    try {
        prismEnsureDir(PRISM_HOME);
        var f = new File(PRISM_HOME + "/" + name);
        var old = "";
        try {
            if (f.exists && f.length < PRISM_DIAG_MAX) {
                f.encoding = "UTF-8";
                if (f.open("r")) { old = f.read(); f.close(); }
            }
        } catch (eR) { old = ""; }
        f.encoding = "UTF-8";
        if (!f.open("w")) return;
        try { f.write(old + line + "\n"); } finally { try { f.close(); } catch (eC) {} }
    } catch (e) {}
}

function prismDiagTime() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + ((d.getMilliseconds() + 1000) + "").substring(1);
}

/* 面板侧诊断代写: 面板折叠时自己的日志区会整段停摆(看不到也没法留证),
   关键判定交给宿主写进 data\panel.log, 展开后可事后核对折叠期间发生了什么。 */
function prismPanelDiag(msg) {
    prismDiagAppend("panel.log", prismDiagTime() + " " + msg);
    return jsonOut(true, "");
}

/* ---------- 调度器能力实测探针 ----------
 * 不再只靠 typeof 下结论: ExtendScript 对宿主内置方法的探测并不可靠, 而历史上正是
 * 一句"app.scheduleTask 不是函数"把整条链路判成"无调度器", 节拍只能落在面板上,
 * 面板一折叠就断。这里直接注册一个 800ms 后写标记文件的一次性任务, 以"标记文件
 * 是否出现"作为唯一判据, 并把原始探测值一并落盘。
 * ★本机实测结论(PS 27.9.1 / 2026, 见 sched_probe.log): app.scheduleTask 根本不存在,
 *  "宿主自调度"在本机是死路, 不要再往这个方向改。折叠期唯一可行的外部节拍在服务端:
 *  服务端经 COM 直接驱动宿主跑一次巡检(server 侧 run_com_driver)。
 *  本探针与 prismSchedProbeCheck 保留, 作用已从"争取自调度"变成"留证" —— 将来换
 *  PS 版本若真支持了 scheduleTask, 它会自己在日志里昭示出来。 */
function prismSchedProbe() {
    var lines = [];
    lines.push("=== sched probe @ " + (new Date()).toString() + " | build " + prismBuildTag() + " ===");
    lines.push("server_build = " + prismCheckServerBuild());
    try { lines.push("typeof app.scheduleTask = " + (typeof app.scheduleTask)); } catch (e1) { lines.push("typeof ERR: " + e1); }
    try { lines.push("(scheduleTask in app) = " + ("scheduleTask" in app)); } catch (e2) { lines.push("in ERR: " + e2); }
    try { lines.push("typeof app.cancelTask = " + (typeof app.cancelTask)); } catch (e3) { lines.push("cancelTask typeof ERR: " + e3); }
    try { lines.push("String(app.scheduleTask) = " + ("" + app.scheduleTask).substring(0, 160)); } catch (e4) { lines.push("String ERR: " + e4); }
    try { lines.push("app.version = " + app.version); } catch (e5) {}

    var mark = PRISM_HOME + "/sched_probe.txt";
    try { var mf = new File(mark); if (mf.exists) mf.remove(); } catch (e6) {}
    try {
        var code = "try{var f=new File(" + jsxJson(mark) + ");f.encoding='UTF-8';" +
                   "if(f.open('w')){f.write('SCHED OK '+(new Date()).getTime());f.close();}}catch(e){}";
        var id = app.scheduleTask(code, 800, false);
        lines.push("scheduleTask(code,800,false) => " + id + " (typeof " + (typeof id) + ")");
    } catch (e7) {
        lines.push("scheduleTask(code,800,false) THREW: " + (e7 && e7.message ? e7.message : e7));
    }
    prismDiagAppend("sched_probe.log", lines.join("\n"));
    return jsonOut(true, "", { probe: true });
}

/* 探针回读: 1.8s 后由面板调用。标记文件出现 = 调度器真的能定时执行脚本。
   结论为可用时, 立刻用原参数重启推送会话(切 host 自调度), 无需用户任何操作。 */
/* 读服务端落盘的构建号, 判断 8765 端口上跑的到底是哪一版服务端。
   现场反复吃亏: 旧打包 exe 占着端口时, 服务端新加的"折叠期 COM 外部节拍"与
   com_drive.log 全都不存在, 从插件外部却完全看不出来, 于是把折叠不刷新误判成
   面板侧的问题。server_build.txt 由 py 版服务端启动时写, 缺失即等于"跑的是旧 exe"。 */
function prismCheckServerBuild() {
    var txt = "";
    try {
        var f = new File(PRISM_HOME + "/server_build.txt");
        if (f.exists) {
            f.open("r");
            txt = "" + f.read();
            f.close();
        }
    } catch (eRd) { txt = ""; }
    txt = txt.replace(/[\r\n]+/g, " ").substring(0, 80);
    var msg = txt || "(缺失 = 端口上是旧打包 exe, 折叠期没有外部节拍可用)";
    prismDiagAppend("sched_probe.log", prismDiagTime() + " server_build = " + msg);
    return msg;
}

function prismSchedProbeCheck() {
    var ok = false;
    try { ok = !!new File(PRISM_HOME + "/sched_probe.txt").exists; } catch (e) {}
    PRISM_SCHED_OK = ok;
    prismDiagAppend("sched_probe.log",
        "check -> " + (ok ? "SCHEDULER OK (标记文件已出现, 可自定时)" : "SCHEDULER DEAD (标记文件未出现)") +
        " @" + prismDiagTime() + " [build " + prismBuildTag() + "]");
    if (ok) {
        var wasOn = PRISM_PUSH_ON;
        try {
            if (wasOn) {
                /* 重新开启 = 撤销旧任务 + 用现在的参数重启全程; 之后节拍由 PS 提供 */
                prismPushStart(PRISM_PUSH_MODE, PRISM_PUSH_SCALE);
            } else {
                /* 会话未开也把宿主心跳挂上调度器: 面板折叠时宿主租约仍能续期 */
                if (prismHasScheduler()) {
                    try { prismStartHostBeat(); } catch (eB) {}
                }
            }
        } catch (eR) {}
    }
    return jsonOut(ok, ok ? "scheduler ok" : "scheduler dead", {
        schedulerOk: ok,
        driven: ("" + PRISM_PUSH_DRIVEN),
        on: PRISM_PUSH_ON
    });
}

/* ---------- 事件驱动跟随(与调度器、面板都无关) ----------
 * 跟随的本质是"画布变了就推一帧", 那么最合适的驱动力是 PS 自己的事件:
 * 用户在画布上每做一次操作都会生成历史状态, 这里把 historyStateChanged 等事件
 * 挂到 data\prism_notify.jsx, 事件一到 PS 就去执行该脚本里的 PRISM_TICK() ——
 * 不依赖 app.scheduleTask、不依赖面板可见性, 折叠着画图也照样实时推送。
 * 事件名逐个尝试(不同版本支持集不同), 成功的记入诊断日志, 全部失败则静默跳过。 */
var PRISM_NOTIFY_NAMES = ["historyStateChanged", "select", "documentChanged", "paint"];
/* 事件驱动注册状态。加 typeof 守卫(与本文件其它会话状态一致): main.jsx 每次被面板
   全文重新注入执行, 直接赋值会把正在运行的注册/重试节奏打回初值。 */
if (typeof PRISM_NOTIFY_TRIED === "undefined") PRISM_NOTIFY_TRIED = false;      // 是否已尝试过注册
if (typeof PRISM_NOTIFY_LAST_TRY === "undefined") PRISM_NOTIFY_LAST_TRY = 0;    // 上次尝试注册时刻(毫秒)
if (typeof PRISM_NOTIFY_OK_COUNT === "undefined") PRISM_NOTIFY_OK_COUNT = 0;    // 上次成功注册的事件数
var PRISM_NOTIFY_RETRY_MS = 600000;     // 未装成功时的最小重试间隔(避免每次轮询都写盘)
var PRISM_NOTIFY_RECHECK_MS = 300000;  // 已装成功后的复核间隔(5min): 集合被 PS 清掉时补挂
var PRISM_SCHED_OK = null;        // 调度器实测结论: null=未测 | true=可用 | false=不可用

/* ---------- notifier 注册辅助 ----------
 * ★历史故障(本机 PS 27 实测): 旧实现"先 app.notifiers.remove(event, File) 再 add",
 *   两个调用都包在空 catch 里。实测 remove(event, File) 这个签名在本机摘不掉旧注册、
 *   add 又因"同名同文件已注册"抛错 —— 异常全被吞掉, 净效果是旧注册被摘、新注册挂不上,
 *   日志只剩一句 "notifier installed: NONE", 且 prismEnsureNotifier 一次即弃,
 *   事件驱动永远挂不上, 面板一折叠推帧即断。
 * 现改为: ①直接遍历 app.notifiers(length + 下标)按 .event / .object 精确匹配;
 *        ②add 前先判"是否已存在", 已存在视为安装成功, 不报 NONE;
 *        ③remove / add 的真实异常文本全部落盘 sched_probe.log, 分类可辨:
 *            <event>:exists(kept)        已在集合中, 视为成功
 *            <event>:add ok              新注册成功
 *            <event>:add ERR <文本>      注册抛错(附真实错误文本)
 *            <event>:legacy-remove ERR <文本>  旧签名移除抛错(仅诊断, 不致命)
 *            <event>:prune ok / ERR <文本>     清理多余重复注册
 *            tick-global:remounted       $.global.PRISM_TICK 缺失时就地补挂
 */

/* ExtendScript 抛出的对象各版本形态不一, 统一取可读文本, 绝不空手吞掉 */
function prismErrText(e) {
    try {
        if (!e) return "unknown";
        if (e.message) return "" + e.message;
        return "" + e;
    } catch (x) { return "unprintable"; }
}

/* 路径归一(反斜杠/正斜杠、重复斜杠、大小写), 用于比对 Notifier.object */
function prismPathNorm(p) {
    try {
        return ("" + p).replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
    } catch (e) { return ""; }
}

/* Notifier 对象 -> 它挂的目标脚本路径(取不到即返回空串 = 不匹配)
   ★字段名随 PS 版本而异: 官方 Notifier 暴露 event / object / eventClass / eventFile,
     其中"挂在哪个脚本文件上"是 **eventFile**, 而 object 是事件描述符
     (ActionDescriptor, 通常为 null)。
     旧实现只读 object -> 恒为 null -> 判为"不匹配" -> 统计数恒为 0 -> 于是反复去 add,
     每次都只是换回一句"已安装通知程序"(PS 对已挂过的事件统一回这句)。
     现场日志因此长期是 "installed: NONE", 上层以为事件通道从未挂上。
     这里按 eventFile -> object 两级取, 兼容不同版本。 */
function prismNotifierFile(n) {
    var cand = null;
    try { cand = n.eventFile; } catch (e0) { cand = null; }
    if (!cand) { try { cand = n.object; } catch (e1) { cand = null; } }
    if (!cand) return "";
    try { return (typeof cand === "string") ? cand : ("" + cand.fsName); } catch (e2) {}
    try { return "" + cand; } catch (e3) {}
    return "";
}

/* PS 关于"该事件已经挂过"的本地化提示判定。
   ★用码点构造中文, 不受脚本文件编码/控制台转码影响 —— 直接在源码里写这几个汉字,
     一旦宿主脚本以非 UTF-8 方式被注入, 匹配就永远不成立, 这个判据会静默失效。 */
function prismIsAlreadyInstalled(txt) {
    try {
        var s = "" + txt;
        if (!s) return false;
        if (s.indexOf(String.fromCharCode(0x5DF2, 0x5B89, 0x88C5)) !== -1) return true;  // "已安装"
        if (/already\s*installed|already\s*registered|duplicate/i.test(s)) return true;
    } catch (e) {}
    return false;
}

/* 统计"目标事件 + 目标脚本"的现有注册数; 集合不可枚举时返回 -1 */
function prismNotifyCount(evName, wantNorm) {
    var total = 0, hit = 0, i;
    try { total = app.notifiers.length; } catch (eL) { return -1; }
    for (i = 0; i < total; i++) {
        var nit = null;
        try { nit = app.notifiers[i]; } catch (eI) { continue; }
        if (!nit) continue;
        var ev = "";
        try { ev = "" + nit.event; } catch (eE) { ev = ""; }
        if (ev !== evName) continue;
        if (prismPathNorm(prismNotifierFile(nit)) !== wantNorm) continue;
        hit++;
    }
    return hit;
}

/* 摘掉多余的同名同文件注册(只动匹配项, 其它 notifier 一律不碰), 返回剩余数 */
function prismPruneNotifier(evName, jsxPath, wantNorm, notes) {
    var guard = 0, cur = prismNotifyCount(evName, wantNorm);
    while (cur > 1 && guard < 10) {
        guard++;
        try {
            app.notifiers.remove(evName, new File(jsxPath));
            notes.push(evName + ":prune ok");
        } catch (ePr) {
            notes.push(evName + ":prune ERR " + prismErrText(ePr));
            break;
        }
        var next = prismNotifyCount(evName, wantNorm);
        if (next >= cur) break;   // 摘不掉: 不再空转
        cur = next;
    }
    return cur;
}

function prismInstallNotifier() {
    var jsxPath = PRISM_HOME + "/prism_notify.jsx";
    var installed = [];
    var notes = [];
    try {
        prismEnsureDir(PRISM_HOME);
    } catch (eD) {}

    /* prism_notify.jsx 内容固定: 已存在且带新版标记(PRISM_NOTIFY_N)就不再重写。
       缺标记(旧版脚本/热修后)必须重写, 否则新节流与计数逻辑不生效。 */
    var needWrite = true;
    try {
        var chk = new File(jsxPath);
        if (chk.exists) {
            chk.encoding = "UTF-8";
            if (chk.open("r")) {
                var curSrc = "";
                try { curSrc = chk.read(); } finally { try { chk.close(); } catch (eC) {} }
                if (curSrc && curSrc.indexOf("PRISM_NOTIFY_N") !== -1) needWrite = false;
            }
        }
    } catch (eChk) { needWrite = true; }

    if (needWrite) {
        try {
            var f = new File(jsxPath);
            f.encoding = "UTF-8";
            if (f.open("w")) {
                /* 节流 900ms: notifier 在每次历史状态变化时都触发(拖动笔刷一次可触发几十次),
                   不节流就是导出风暴(PS 卡顿 + 服务端被刷)。窗口取 900ms, 与面板节拍同量级,
                   两者任一存活都能维持 ~1s 一拍; 时间戳存在 $.global 上跨次执行保留。
                   计数每 50 拍补一条日志, 便于事后确认"事件确实一直在触发"。 */
                f.write(
                    "try{\n" +
                    "  var __t = (new Date()).getTime();\n" +
                    "  if (!$.global.PRISM_NOTIFY_LAST || __t - $.global.PRISM_NOTIFY_LAST >= 900) {\n" +
                    "    $.global.PRISM_NOTIFY_LAST = __t;\n" +
                    "    $.global.PRISM_NOTIFY_N = ($.global.PRISM_NOTIFY_N || 0) + 1;\n" +
                    "    if (!$.global.PRISM_NOTIFY_LOG || ($.global.PRISM_NOTIFY_N % 50) === 1) {\n" +
                    "      $.global.PRISM_NOTIFY_LOG = 1;\n" +
                    "      try { var __lf = new File(" + jsxJson(PRISM_HOME + "/notify.log") + "); __lf.encoding = 'UTF-8';\n" +
                    "        if (__lf.open('a')) { __lf.write('PS notify tick #' + $.global.PRISM_NOTIFY_N + ' @ ' + (new Date()).toString() + '\\n'); __lf.close(); } } catch (e2) {}\n" +
                    "    }\n" +
                    "    if ($.global.PRISM_TICK) $.global.PRISM_TICK();\n" +
                    "  }\n" +
                    "}catch(e){}\n");
                f.close();
                notes.push("jsx:written");
            } else {
                prismDiagAppend("sched_probe.log",
                    "notifier: jsx write FAILED " + jsxPath + " @" + prismDiagTime());
                return [];
            }
        } catch (e0) {
            prismDiagAppend("sched_probe.log",
                "notifier: jsx write ERR " + prismErrText(e0) + " @" + prismDiagTime());
            return [];
        }
    }

    /* 事件入口必须挂在 $.global(notifier 脚本只认全局函数)。缺了就补挂,
       避免"事件装上了却调不到 PRISM_TICK"这条静默失效链 ——
       推帧链路本身(prismPushTick -> Socket 心跳 + PNG 落盘)完全在 PS 侧完成,
       不经面板 evalScript 返回值, 也不依赖任何面板侧回调。 */
    try {
        if (typeof $.global.PRISM_TICK !== "function") {
            $.global.PRISM_TICK = function () { prismPushTick(); };
            notes.push("tick-global:remounted");
        }
    } catch (eG) { notes.push("tick-global ERR " + prismErrText(eG)); }

    var wantNorm = prismPathNorm(jsxPath);
    for (var i = 0; i < PRISM_NOTIFY_NAMES.length; i++) {
        var name = PRISM_NOTIFY_NAMES[i];
        /* 1) 集合里已有"同事件 + 同文件"注册: 直接视为安装成功, 不再 add */
        var have = prismNotifyCount(name, wantNorm);
        if (have < 0) { notes.push(name + ":enum ERR"); continue; }
        if (have > 1) have = prismPruneNotifier(name, jsxPath, wantNorm, notes);
        if (have >= 1) {
            installed.push(name);
            notes.push(name + ":exists(kept)");
            continue;
        }
        /* 2) 没有: 先用旧签名尽力摘一次(签名不兼容会抛错, 只记文本, 不致命) */
        try {
            app.notifiers.remove(name, new File(jsxPath));
            notes.push(name + ":legacy-remove ok");
        } catch (eRm) {
            notes.push(name + ":legacy-remove ERR " + prismErrText(eRm));
        }
        /* 3) 再注册; add 抛错后复核集合 —— 部分版本"已存在"也抛错,
              此时集合里其实已有, 属成功而非失败。 */
        try {
            app.notifiers.add(name, new File(jsxPath));
            installed.push(name);
            notes.push(name + ":add ok");
        } catch (eN) {
            /* ★add 抛错 ≠ 失败: PS 对"该事件已经挂过"统一回一句"已安装通知程序"
               (本机 27.9.1 实测, 四个事件全部回这句)。此时事件其实早就挂上了,
               旧实现把它当失败 -> installed 恒为 NONE -> 上层认为事件通道从未通,
               折叠期就没人再去补挂。这里明确把"已安装"认作成功。 */
            var et = prismErrText(eN);
            if (prismNotifyCount(name, wantNorm) >= 1 || prismIsAlreadyInstalled(et)) {
                installed.push(name);
                notes.push(name + ":add ERR(" + et + ") -> treated as installed");
            } else {
                notes.push(name + ":add ERR " + et);
            }
        }
    }
    prismDiagAppend("sched_probe.log",
        "notifier installed: " + (installed.length ? installed.join(",") : "NONE") +
        " @" + prismDiagTime() + " [" + notes.join(" | ") + "]");
    /* 集合快照: 把 PS 当前 notifier 集合的总数与前若干条事件名落盘。
       这是事后判断"事件是我们挂上的、还是被别的扩展占了"的唯一凭据 ——
       只有 total 与实际条目都在, 才谈得上"事件通道可用"。 */
    try {
        var dump = [], tot = -1, di;
        try { tot = app.notifiers.length; } catch (eDT) { tot = -1; }
        for (di = 0; di < tot && di < 12; di++) {
            try { dump.push("" + app.notifiers[di].event); } catch (eDD) { dump.push("?"); }
        }
        prismDiagAppend("sched_probe.log",
            "notifier enum: total=" + tot + " [" + dump.join(",") + "] @" + prismDiagTime());
    } catch (eDump) {}
    return installed;
}

/* 幂等补装(可重试): 会话已常驻运行时不再经过 prismPushStart, 若那次注册失败
   (例如面板重开、宿主脚本被重新注入导致 $.global 上的 notifier 丢失), 事件驱动
   就永远不会挂上 —— 只剩面板节拍一条路, 折叠即断。prismPushState 每次被面板轮询
   都会走这里补一次。
   ★历史缺陷: 原实现用 PRISM_NOTIFY_TRIED 做"一次即弃", 首次失败(本机实测为
   remove/add 签名不兼容)后就永久不再尝试, 事件驱动再也没机会挂上。现改为:
     · 未装成功 -> 每 PRISM_NOTIFY_RETRY_MS(15s) 重试一次, 不会每次轮询都写盘;
     · 已装成功 -> 每 PRISM_NOTIFY_RECHECK_MS(5min) 复核一次集合是否被清掉。 */
function prismEnsureNotifier() {
    var now = (new Date()).getTime();
    var allOk = (PRISM_NOTIFY_OK_COUNT >= PRISM_NOTIFY_NAMES.length);
    var gap = allOk ? PRISM_NOTIFY_RECHECK_MS : PRISM_NOTIFY_RETRY_MS;
    if (PRISM_NOTIFY_LAST_TRY && (now - PRISM_NOTIFY_LAST_TRY) < gap) return;
    PRISM_NOTIFY_LAST_TRY = now;
    PRISM_NOTIFY_TRIED = true;
    var r = [];
    try { r = prismInstallNotifier(); }
    catch (e) { prismDiagAppend("sched_probe.log", "ensureNotifier ERR: " + prismErrText(e)); }
    try { PRISM_NOTIFY_OK_COUNT = (r && r.length) ? r.length : 0; } catch (eC) { PRISM_NOTIFY_OK_COUNT = 0; }
}

/* 逐级创建目录并返回是否可用。
   ExtendScript 的 Folder.create() 只建最后一级, 而扩展目录下 server\ / data\watch\
   在全新安装时并不存在(服务端与数据目录都按需自建), 故这里逐段创建。
   任何异常只返回 false, 不向调用方抛出。 */
function prismEnsureDir(fullPath) {
    var p = ("" + fullPath).replace(/\\/g, "/");
    var parts = p.split("/"), cur = "", i;
    for (i = 0; i < parts.length; i++) {
        if (i === 0) { cur = parts[0]; continue; }   // 盘符, 如 "D:"
        if (!parts[i]) continue;
        cur += "/" + parts[i];
        try {
            var f = new Folder(cur);
            if (!f.exists) f.create();
        } catch (e) { return false; }
    }
    try { return new Folder(p).exists; } catch (e2) { return false; }
}

/* 单次刷新心跳文件: 写入当前时间戳(毫秒)。
   全程容错 —— 任何目录/文件异常都吞掉, 绝不影响 PS 宿主。 */
function prismHostBeatTick() {
    try {
        prismEnsureDir(PRISM_HOME);
        if (!HOST_BEAT_FILE.open("w")) return;
        try {
            HOST_BEAT_FILE.write("" + (new Date()).getTime());
        } finally {
            try { HOST_BEAT_FILE.close(); } catch (eClose) {}
        }
    } catch (e) {}
}

/* 启动/续期宿主心跳任务: 立即写一次, 再每 2s 由 PS 调度器刷新。
   重复注册防护: 面板每次注入 main.jsx 都会调用本函数, 若只注册不撤销,
   多个循环任务会叠加。这里先撤销同名/同脚本的旧任务再注册, 保证只有一个。 */
function prismStartHostBeat() {
    prismHostBeatTick();   // 首次心跳: 让服务端在启动宽限期内即确认宿主存在

    /* 先撤销旧任务(可能不存在, 异常忽略): 兼容不同 PS 版本的任务标识方式 */
    try { app.cancelTask(HOST_BEAT_TASK_ID); } catch (e0) {}
    try { app.cancelTask(HOST_BEAT_TASK_CODE); } catch (e0b) {}

    try {
        /* 官方签名: app.scheduleTask(task, delay, repeat) -> 返回任务 ID(理由同
           下方推送任务: 4 参重载在 PS 上不存在, 先传任务名只会让脚本串空转) */
        HOST_BEAT_TASK_ID = app.scheduleTask(HOST_BEAT_TASK_CODE, HOST_BEAT_MS, true);
    } catch (e1) {
        try {
            /* 少数版本才支持带任务名的 4 参签名, 作为兜底 */
            app.scheduleTask(HOST_BEAT_TASK_ID, HOST_BEAT_TASK_CODE, HOST_BEAT_MS, true);
        } catch (e2) {
            return jsonOut(false, "宿主心跳任务注册失败: " + e2);
        }
    }
    return jsonOut(true, "host beat on", {
        file: HOST_BEAT_FILE.fsName,
        intervalMs: HOST_BEAT_MS
    });
}

/* ---------- 小工具 ---------- */
/* ExtendScript(ES3) 无原生 JSON 对象, 自实现轻量序列化 */
function jsxEscape(s) {
    return ("" + s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
function jsxJson(o) {
    var i, parts = [], k;
    if (o === null || o === undefined) return "null";
    var t = typeof o;
    if (t === "string") return '"' + jsxEscape(o) + '"';
    if (t === "number" || t === "boolean") return "" + o;
    if (Object.prototype.toString.call(o) === "[object Array]") {
        for (i = 0; i < o.length; i++) parts.push(jsxJson(o[i]));
        return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
        for (k in o) {
            if (Object.prototype.hasOwnProperty.call(o, k)) parts.push('"' + k + '":' + jsxJson(o[k]));
        }
        return "{" + parts.join(",") + "}";
    }
    return "null";
}

function jsonOut(ok, msg, extra) {
    var o = { ok: ok, msg: msg || "" };
    if (extra) {
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
        }
    }
    return jsxJson(o);
}

function timestamp() {
    var d = new Date();
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + "_" + d.getMilliseconds();
}

/* bounds(UnitValue 数组) -> 像素数值数组 [l,t,r,b] */
function boundsPx(b) {
    if (!b || b.length < 4) return null;
    try {
        return [
            parseFloat(b[0].as("px")),
            parseFloat(b[1].as("px")),
            parseFloat(b[2].as("px")),
            parseFloat(b[3].as("px"))
        ];
    } catch (e) { return null; }
}

/* ======================= 画板(Artboard)支持 =======================
 * ★历史缺陷根因(本次修复对象): 旧实现用 `cur.kind == LayerKind.ARTBOARD` 判画板, 但
 *   ExtendScript 的 LayerKind 枚举里【根本没有 ARTBOARD 这个常量】(取值为 undefined),
 *   画板在 DOM 里只是一个普通图层组 —— 于是 `数字 == undefined` 恒为 false,
 *   findActiveArtboard() 永远返回 null: 选「当前画板」必然被拦下并报
 *   "当前图层不在画板内"。也就是说画板识别从上线起就没生效过(是枚举写错, 不是没做)。
 * 权威判法(与 PS 自带 Presets/Scripts/ArtboardExport.inc 完全一致): 走 Action Manager,
 *   读图层属性 artboardEnabled(布尔) + artboard.artboardRect(像素矩形) + 背景类型。
 * ================================================================= */
function prismIsArtboard(layer) {
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("artboardEnabled"));
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        return !!executeActionGet(ref).getBoolean(stringIDToTypeID("artboardEnabled"));
    } catch (e) {
        return false;   // 取不到该属性 = 非画板(普通图层/图层组没有这个键)
    }
}

/* ---------- 标尺单位临时锁定为像素 ----------
 * artboardRect 的数值单位跟随"标尺单位"(PS 自带 ArtboardExport.inc 一上来就把 rulerUnits
 * 设成 PIXELS 就是这个原因); 而本次所有几何都按像素算, 不锁就会在非像素标尺下裁错位置。
 * 用深度计数保证只改一次, 读完立刻还原原值, 不改动用户设置。 */
var PRISM_RU_DEPTH = 0;
var PRISM_RU_SAVE = null;
function prismRUPush() {
    try {
        if (PRISM_RU_DEPTH === 0) {
            var cur = app.preferences.rulerUnits;
            if (cur !== Units.PIXELS) { PRISM_RU_SAVE = cur; app.preferences.rulerUnits = Units.PIXELS; }
            else { PRISM_RU_SAVE = null; }
        }
        PRISM_RU_DEPTH++;
    } catch (e) { PRISM_RU_SAVE = null; }
}
function prismRUPop() {
    try {
        PRISM_RU_DEPTH--;
        if (PRISM_RU_DEPTH <= 0) {
            PRISM_RU_DEPTH = 0;
            if (PRISM_RU_SAVE !== null) { app.preferences.rulerUnits = PRISM_RU_SAVE; PRISM_RU_SAVE = null; }
        }
    } catch (e) { PRISM_RU_DEPTH = 0; PRISM_RU_SAVE = null; }
}

/* 画板几何与底色: {rect:[l,t,r,b](px), bgType:1白/2黑/3透明/4自定, bgColor:[r,g,b]} */
function prismArtboardInfo(layer) {
    prismRUPush();
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("artboard"));
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        var ab = executeActionGet(ref).getObjectValue(stringIDToTypeID("artboard"));
        var r = ab.getObjectValue(stringIDToTypeID("artboardRect"));
        var out = {
            rect: [
                r.getUnitDoubleValue(charIDToTypeID("Left")),
                r.getUnitDoubleValue(charIDToTypeID("Top ")),
                r.getUnitDoubleValue(charIDToTypeID("Rght")),
                r.getUnitDoubleValue(charIDToTypeID("Btom"))
            ],
            bgType: 3,
            bgColor: [255, 255, 255]
        };
        try { out.bgType = ab.getInteger(stringIDToTypeID("artboardBackgroundType")); } catch (eT) {}
        try {
            var c = ab.getObjectValue(charIDToTypeID("Clr "));
            out.bgColor = [
                c.getDouble(charIDToTypeID("Rd  ")),
                c.getDouble(charIDToTypeID("Grn ")),
                c.getDouble(charIDToTypeID("Bl  "))
            ];
        } catch (eC) {}
        return out;
    } catch (e) { return null; }
    finally { prismRUPop(); }
}

/* 文档顶层画板清单(画板必定是顶层图层). -> [{layer,id,name,rect,bgType,bgColor}] */
function prismListArtboards(doc) {
    var out = [];
    prismRUPush();      // 整批扫描只切一次标尺单位(画板矩形单位跟随标尺)
    try {
        var layers = doc.layers;
        for (var i = 0; i < layers.length; i++) {
            try {
                var L = layers[i];
                if (!prismIsArtboard(L)) continue;
                var info = prismArtboardInfo(L);
                if (!info || !info.rect) continue;
                out.push({
                    layer: L, id: L.id, name: L.name, rect: info.rect,
                    bgType: info.bgType, bgColor: info.bgColor
                });
            } catch (eL) {}
        }
    } catch (e) {} finally { prismRUPop(); }
    return out;
}

/* 当前活动画板: 从 activeLayer 逐级向上找最近的画板;
   文档里只有一个画板时无歧义, 直接用它(多画板文档才需要"当前"这个语义) */
function findActiveArtboard(doc) {
    var all = prismListArtboards(doc);
    if (!all.length) return null;
    var cur = null, depth = 0;
    try { cur = doc.activeLayer; } catch (e) { cur = null; }
    while (cur && depth < 20) {
        try {
            if (cur === doc) break;
            for (var i = 0; i < all.length; i++) {
                if (all[i].id === cur.id) return all[i];
            }
            cur = cur.parent;
        } catch (e2) { break; }
        depth++;
    }
    return (all.length === 1) ? all[0] : null;
}

/* ---------- Action Manager 图层操作 ----------
 * ★致命注意: executeAction 只作用于【当前活动文档】, 而副本与用户原稿的图层 ID 完全相同,
 *   所以这些函数一律先确认"活动文档就是 doc", 否则立即放弃 —— 绝不能让删/改落到原稿上。 */
function prismFocusIs(doc) {
    try { return String(app.activeDocument.name) === String(doc.name); } catch (e) { return false; }
}

function prismAMSelectLayer(doc, id) {
    if (!prismFocusIs(doc)) return false;
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putEnumerated(stringIDToTypeID("selectionModifier"),
            stringIDToTypeID("selectionModifierType"), stringIDToTypeID("replaceSelection"));
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

function prismAMUnlockLayer(doc, id) {
    if (!prismFocusIs(doc)) return false;
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        var dUnlock = new ActionDescriptor();
        dUnlock.putBoolean(stringIDToTypeID("protectNone"), true);
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putObject(stringIDToTypeID("layerLocking"), stringIDToTypeID("layerLocking"), dUnlock);
        executeAction(stringIDToTypeID("applyLocking"), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

function prismDeleteLayerById(doc, id) {     // ★只允许在副本上调用(函数内已强制校验焦点)
    if (!prismFocusIs(doc)) return false;
    prismAMUnlockLayer(doc, id);
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putBoolean(charIDToTypeID("MkVs"), false);
        executeAction(stringIDToTypeID("delete"), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 画板"去画板化": 拆成普通图层组(内容原样保留)。
   画板身份会把画布牵制在画板矩形上, 不摘掉就裁不动画布 */
function prismUnartboard(doc, ab) {
    if (!prismFocusIs(doc)) return false;
    try {
        prismAMUnlockLayer(doc, ab.id);
        if (!prismAMSelectLayer(doc, ab.id)) return false;
        var ref = new ActionReference();
        ref.putEnumerated(stringIDToTypeID("layer"), stringIDToTypeID("ordinal"),
            stringIDToTypeID("targetEnum"));
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        executeAction(stringIDToTypeID("ungroupLayersEvent"), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* ---------- 去画板化并"保持外观"(同 PS 自带 Presets/Scripts/ArtboardExport.inc 的 unArtBoard) ----------
 * 画板有三样东西不是图层、一拆开就丢, 不补回来导出的图就会变样:
 *   ① 画板底色(白/黑/自定色) —— 它是画板属性, 不占图层;
 *   ② 画板矩形的裁切 —— 画板会把溢出矩形的内容裁掉, 拆开后溢出部分会露出来;
 *   ③ 画布被画板矩形牵制 —— 不摘掉画板身份就裁不动画布。
 * 补法照抄 Adobe 官方流程: 选中画板 → 在位补一层纯色底色层(挪到画板最底层) → 去画板化 →
 *   把散开的图层重新打成一个普通图层组 → 用画板矩形给该组加图层蒙版(还原裁切)。
 * 得到的是一个"长得和画板一样"的普通图层组。返回新组图层 ID(失败 0)。 */
function prismRectsOverlap(a, b) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return false;
    return !(a[3] < b[1] || a[1] > b[3] || a[2] < b[0] || a[0] > b[2]);
}

/* 画板底色(1白/2黑/4自定) → [r,g,b]; 透明(3/0/其它)返回 null */
function prismBgColor(ab) {
    if (!ab) return null;
    if (ab.bgType === 1) return [255, 255, 255];
    if (ab.bgType === 2) return [0, 0, 0];
    if (ab.bgType === 4) return ab.bgColor || [255, 255, 255];
    return null;
}

function prismMakeSolidColorLayer(r, g, b) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putClass(stringIDToTypeID("contentLayer"));
    desc.putReference(stringIDToTypeID("null"), ref);
    var using = new ActionDescriptor();
    var typeD = new ActionDescriptor();
    var colorD = new ActionDescriptor();
    colorD.putDouble(charIDToTypeID("Rd  "), r);
    colorD.putDouble(charIDToTypeID("Grn "), g);
    colorD.putDouble(charIDToTypeID("Bl  "), b);
    typeD.putObject(stringIDToTypeID("color"), charIDToTypeID("RGBC"), colorD);
    using.putObject(stringIDToTypeID("type"), stringIDToTypeID("solidColorLayer"), typeD);
    desc.putObject(stringIDToTypeID("using"), stringIDToTypeID("contentLayer"), using);
    executeAction(stringIDToTypeID("make"), desc, DialogModes.NO);
}

function prismDeleteActiveMask() {
    try {
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        executeAction(charIDToTypeID("Dlt "), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}

/* 用像素矩形给"当前图层"加图层蒙版(revealSelection) = Adobe makeMaskFromSelection */
function prismMaskRectOnActive(doc, rect) {
    if (!prismSelectRectPx(doc, rect)) return false;
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(stringIDToTypeID("channel"), stringIDToTypeID("channel"),
            stringIDToTypeID("mask"));
        desc.putReference(stringIDToTypeID("at"), ref);
        desc.putClass(stringIDToTypeID("new"), stringIDToTypeID("channel"));
        desc.putEnumerated(stringIDToTypeID("using"), stringIDToTypeID("userMaskEnabled"),
            stringIDToTypeID("revealSelection"));
        executeAction(stringIDToTypeID("make"), desc, DialogModes.NO);
        try { doc.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e) { return false; }
}

/* 当前活动图层的 AM 图层 ID (= Adobe getLayerID) */
function prismActiveLayerId() {
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("layerID"));
        ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        return executeActionGet(ref).getInteger(stringIDToTypeID("layerID"));
    } catch (e) { return 0; }
}

function prismUnartboardWithLook(doc, ab) {
    if (!prismFocusIs(doc)) return 0;
    if (!ab || !ab.layer) return 0;
    prismAMUnlockLayer(doc, ab.id);      // 锁定的画板既选不中也拆不动, 先解锁
    /* 空画板单独处理: PS 拆开空画板时会把画板本身抹掉, 后面的"打成组"就会误伤别的图层。
       空画板没有内容, 有底色就按画板矩形补一块底色层, 再把画板删掉即可。 */
    var kids = -1;
    try { kids = ab.layer.layers.length; } catch (eK) { kids = -1; }
    if (kids === 0) {
        var bc = prismBgColor(ab);
        if (bc && ab.rect) {
            try {
                prismMakeSolidColorLayer(bc[0], bc[1], bc[2]);
                prismDeleteActiveMask();
                prismMaskRectOnActive(doc, ab.rect);
            } catch (eB) {}
        }
        prismDeleteLayerById(doc, ab.id);
        return 0;
    }
    try {
        if (!prismAMSelectLayer(doc, ab.id)) return 0;
        /* ① 在位补画板底色: 此刻父级还是画板组, 底色天然只属于这个画板 */
        var host = null;
        try { host = doc.activeLayer; } catch (eH) { host = null; }
        var col = prismBgColor(ab);
        if (col && host) {
            prismMakeSolidColorLayer(col[0], col[1], col[2]);
            prismDeleteActiveMask();
            try { doc.activeLayer.move(host, ElementPlacement.PLACEATEND); } catch (eM) {}
        }
        /* ② 去画板化(拆成散图层) */
        if (!prismUnartboard(doc, ab)) return 0;
        /* ③ 把散图层重新打成普通图层组(蒙版只能加在某个图层上) */
        var dMake = new ActionDescriptor();
        var rNull = new ActionReference();
        rNull.putClass(stringIDToTypeID("layerSection"));
        dMake.putReference(stringIDToTypeID("null"), rNull);
        var rFrom = new ActionReference();
        rFrom.putEnumerated(stringIDToTypeID("layer"), stringIDToTypeID("ordinal"),
            stringIDToTypeID("targetEnum"));
        dMake.putReference(stringIDToTypeID("from"), rFrom);
        var dUsing = new ActionDescriptor();
        dUsing.putString(stringIDToTypeID("name"), ab.name);
        dMake.putObject(stringIDToTypeID("using"), stringIDToTypeID("layerSection"), dUsing);
        dMake.putInteger(stringIDToTypeID("layerSectionStart"), 56);
        dMake.putInteger(stringIDToTypeID("layerSectionEnd"), 57);
        dMake.putString(stringIDToTypeID("name"), ab.name);
        executeAction(stringIDToTypeID("make"), dMake, DialogModes.NO);
        var gid = prismActiveLayerId();
        /* ④ 用画板矩形给该组加蒙版 = 还原"画板把内容裁到矩形内"的观感 */
        if (gid && ab.rect) prismMaskRectOnActive(doc, ab.rect);
        return gid;
    } catch (e) { return 0; }
}

/* 把文档里的画板逐个去画板化(带外观还原); keepId 指定的画板不拆。
   选区模式遇上画板文档时用: 画板身份在, 画布就被所有画板撑着, 裁不下选区。
   每轮重读画板清单 —— 去画板化可能让画布收拢并重算坐标, 沿用旧坐标加蒙版会错位。 */
function prismStripArtboards(doc, keepId) {
    var tried = {}, n = 0;
    for (var guard = 0; guard < 60; guard++) {
        var all = prismListArtboards(doc), next = null;
        for (var i = 0; i < all.length; i++) {
            if (keepId && all[i].id === keepId) continue;
            if (tried[all[i].id]) continue;
            next = all[i]; break;
        }
        if (!next) break;
        tried[next.id] = true;
        prismUnartboardWithLook(doc, next);
        n++;
    }
    return n;
}

/* 用"当前图层的蒙版"当裁剪范围 = Adobe cropFromMask(): 蒙版载入为选区 → 裁掉选区以外 */
function prismCropByMask(doc) {
    if (!prismFocusIs(doc)) return false;
    try {
        var d1 = new ActionDescriptor();
        var r1 = new ActionReference();
        r1.putProperty(charIDToTypeID("Chnl"), stringIDToTypeID("selection"));
        d1.putReference(charIDToTypeID("null"), r1);
        var r2 = new ActionReference();
        r2.putEnumerated(charIDToTypeID("Chnl"), stringIDToTypeID("ordinal"),
            stringIDToTypeID("targetEnum"));
        d1.putReference(stringIDToTypeID("to"), r2);
        executeAction(stringIDToTypeID("set"), d1, DialogModes.NO);
        var d2 = new ActionDescriptor();
        d2.putBoolean(stringIDToTypeID("delete"), true);
        executeAction(stringIDToTypeID("crop"), d2, DialogModes.NO);
        try { doc.selection.deselect(); } catch (eD) {}
        return true;
    } catch (e) { return false; }
}

/* 焦点切到 doc 执行 fn(AM 动作只作用于活动文档), 无论成败都把焦点还给 fallback;
   切不过去返回 null —— 调用方据此放弃, 绝不让 AM 动作落到用户原稿上 */
function prismWithFocus(doc, fallback, fn) {
    try { app.activeDocument = doc; } catch (e1) { return null; }
    if (!prismFocusIs(doc)) return null;
    var r = null;
    try { r = fn(); } catch (e2) { r = null; }
    try { if (fallback) app.activeDocument = fallback; } catch (e3) {}
    return r;
}

/* ---------- 画布裁剪 ---------- */
function prismCanvasWH(doc) {
    try { return [Math.round(parseFloat(doc.width.as("px"))), Math.round(parseFloat(doc.height.as("px")))]; }
    catch (e) { return [0, 0]; }
}

function prismCanvasIs(doc, w, h) {
    var wh = prismCanvasWH(doc);
    return Math.abs(wh[0] - w) <= 1 && Math.abs(wh[1] - h) <= 1;
}

/* 用像素矩形建选区(优先 UnitValue 显式 px, 退化用纯数字) */
function prismSelectRectPx(doc, rect) {
    var nums = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    try {
        var pts = [];
        for (var i = 0; i < 4; i++) {
            pts.push([new UnitValue(nums[i][0], "px"), new UnitValue(nums[i][1], "px")]);
        }
        doc.selection.select(pts, SelectionType.REPLACE, 0, false);
        return true;
    } catch (e1) {
        try { doc.selection.select(nums, SelectionType.REPLACE, 0, false); return true; }
        catch (e2) { return false; }
    }
}

/* "选区 + crop 动作" = 图像>裁剪(与 ArtboardExport.inc 的 cropFromMask 同款办法)。
   ★画板文档里 Document.crop() 会被"画布必须包住所有画板"的规则顶回来 —— 就是这里换法子的原因 */
function prismCropBySelection(doc, rect) {
    if (!prismFocusIs(doc)) return false;      // crop 动作同样只作用于活动文档
    if (!prismSelectRectPx(doc, rect)) return false;
    try {
        var desc = new ActionDescriptor();
        desc.putBoolean(stringIDToTypeID("delete"), true);
        executeAction(stringIDToTypeID("crop"), desc, DialogModes.NO);
    } catch (e) { return false; }
    try { doc.selection.deselect(); } catch (e2) {}
    return prismCanvasIs(doc, Math.round(rect[2] - rect[0]), Math.round(rect[3] - rect[1]));
}

/* Document.crop 直裁像素矩形(显式 px 单位). DOM 调用天生只作用于该文档, 不依赖活动文档 */
function prismDocumentCrop(doc, rect) {
    try {
        var u = function (v) { return new UnitValue(v, "px"); };
        doc.crop([u(rect[0]), u(rect[1]), u(rect[2]), u(rect[3])], 0, 0, 0);
        return true;
    } catch (e) { return false; }
}

/* 把副本画布裁到像素矩形. 返回裁法: "doc"(常规裁剪) / "am"(去画板化后选区裁剪) / "no"(没裁下来)
   ① 先走 Document.crop() —— 普通文档、未被画板牵制的文档直接就成(保持原路径不变);
   ② 画布纹丝不动 = 画板文档的规则把 crop 顶回来了, 这时去掉画板身份, 改用"选区 + crop 动作"再裁。
   ③ ★零闪屏定案(2026-09-15)后本函数已**不在**推送/跟随路径上被调用 —— 画板/选区裁剪改由
      服务端 Pillow 完成(run_watch -> view_crop_frame)。保留定义仅作备用实现, 切勿再接回
      prismPush: 它做的全是"改变文档结构"的动作(去画板化/crop), 接回去就是闪屏。 */
function prismCropRect(doc, rect, fallbackDoc) {
    var wantW = Math.round(rect[2] - rect[0]), wantH = Math.round(rect[3] - rect[1]);
    var wh0 = prismCanvasWH(doc);
    if (prismDocumentCrop(doc, rect) && prismCanvasIs(doc, wantW, wantH)) return "doc";
    var wh1 = prismCanvasWH(doc);
    if (wh1[0] !== wh0[0] || wh1[1] !== wh0[1]) {
        return prismCanvasIs(doc, wantW, wantH) ? "doc" : "no";   // 画布已动过, 不再二次裁
    }
    var okAM = prismWithFocus(doc, fallbackDoc, function () {
        prismStripArtboards(doc, null);
        return prismCropBySelection(doc, rect);
    });
    return (okAM === true) ? "am" : "no";
}

/* 画板模式专用: 把副本裁成"当前画板". 返回 "canvas"/"doc"/"unab"/"sel" 表示已裁到位, "" 表示失败(调用方退回按矩形裁)。
   ① 先删掉与目标画板"不相交"的其它画板(Adobe cleanUnseenAB 同款) —— 画布正是被它们撑开的, 只动副本;
   ② 首选 Document.crop 直裁: 像素精确、不动任何图层内容;
   ③ 还裁不动 ⇒ 画板身份仍把画布牵制着: 照 Adobe 原版流程把画板逐个去画板化(带底色/裁切还原),
      再按目标画板的新蒙版裁。
   全程只动副本; 原稿零改动。 */
function prismCropCopyToArtboard_(doc, ab) {
    /* 副本与原稿图层 ID 一致(duplicate 保留 ID); 仍做 ID -> 矩形 -> 名字 三重匹配兜底 */
    var pick = function (list) {
        var i, r;
        if (!list || !list.length) return null;
        for (i = 0; i < list.length; i++) { if (list[i].id === ab.id) return list[i]; }
        if (ab.rect) {
            for (i = 0; i < list.length; i++) {
                r = list[i].rect;
                if (r && Math.abs(r[0] - ab.rect[0]) < 0.6 && Math.abs(r[1] - ab.rect[1]) < 0.6 &&
                    Math.abs(r[2] - ab.rect[2]) < 0.6 && Math.abs(r[3] - ab.rect[3]) < 0.6) return list[i];
            }
        }
        for (i = 0; i < list.length; i++) { if (list[i].name === ab.name) return list[i]; }
        return null;
    };
    var target = pick(prismListArtboards(doc));
    if (!target || !target.rect) return "";
    var fits = function (t) {
        return prismCanvasIs(doc, Math.round(t.rect[2] - t.rect[0]), Math.round(t.rect[3] - t.rect[1]));
    };

    /* ① 清掉"不相交"的其它画板(隐藏画板一并清掉); 与目标相交的留着 —— 可能有可见内容压在本画板上 */
    var all = prismListArtboards(doc), i, o, vis;
    for (i = 0; i < all.length; i++) {
        o = all[i];
        if (o.id === target.id) continue;
        vis = true;
        try { vis = !!o.layer.visible; } catch (eV) { vis = true; }
        if (vis && prismRectsOverlap(o.rect, target.rect)) continue;
        prismDeleteLayerById(doc, o.id);
    }

    /* 删完重读: 画布若收拢, 画板坐标会重算, 一切以重读值为准 */
    var t1 = pick(prismListArtboards(doc));
    if (t1 && t1.rect) target = t1;
    if (fits(target)) return "canvas";     // 画布已收成这个画板(画板底色/裁切属性原样保留)

    /* ② Document.crop 直裁(普通文档/单画板文档等未被牵制的情形) */
    if (prismDocumentCrop(doc, target.rect) && fits(target)) return "doc";

    /* ③ 去画板化(带外观还原) + 按目标画板的蒙版裁。
       ★进 ③ 前重读画板坐标: ② 的裁剪若只裁动了一部分, 画布原点已移动, 旧坐标不能再用了 */
    var t2 = pick(prismListArtboards(doc));
    if (t2 && t2.rect) target = t2;
    var gid = prismUnartboardWithLook(doc, target);
    for (var n = 0; n < 60; n++) {
        var rest = prismListArtboards(doc);
        if (!rest.length) break;
        prismUnartboardWithLook(doc, rest[0]);
    }
    if (fits(target)) return "unab";       // 去画板化过程中画布自己收成了
    if (gid && prismAMSelectLayer(doc, gid) && prismCropByMask(doc) && fits(target)) return "sel";
    if (prismCropBySelection(doc, target.rect) && fits(target)) return "sel";
    if (prismDocumentCrop(doc, target.rect) && fits(target)) return "doc2";
    return "";
}

function prismCropCopyToArtboard(doc, ab, fallbackDoc) {
    var r = prismWithFocus(doc, fallbackDoc, function () { return prismCropCopyToArtboard_(doc, ab); });
    return r ? r : "";
}

/* 尝试将选区转换为整像素矩形 (多区选区取外接矩形) */
function selectionPx(doc) {
    try {
        var arr = boundsPx(doc.selection.bounds);
        if (arr) {
            arr[0] = Math.floor(arr[0]); arr[1] = Math.floor(arr[1]);
            arr[2] = Math.ceil(arr[2]); arr[3] = Math.ceil(arr[3]);
            if (arr[2] > arr[0] && arr[3] > arr[1]) return arr;
        }
    } catch (e) {}
    return null;
}

/* 获取当前文档信息 (面板展示用) */
function prismDocInfo() {
    try {
        var doc = app.activeDocument;
        if (!doc) return jsonOut(false, "没有打开的文档");
        var hasSel = false;
        try { hasSel = !!(doc.selection && doc.selection.bounds); } catch (e) {}
        return jsonOut(true, "", {
            name: doc.name,
            width: Math.round(doc.width.as("px")),
            height: Math.round(doc.height.as("px")),
            hasSelection: hasSel,
            hasArtboard: findActiveArtboard(doc) ? true : false
        });
    } catch (e) {
        return jsonOut(false, "读取文档失败: " + e);
    }
}

/* 画布内容令牌: historyStates 长度随每次编辑动作递增。
   index.js 每 500ms 轮询一次(轻量: 只读 historyStates.length, 不新增重开销调用),
   令牌变化即认为画布有新改动, 触发自动推送, 实现"手机端实时跟随 PS 画布"。
   重复推送保护在面板侧: 令牌 key(文档名#序号) 去重 + AUTO_PUSH_MIN 最小推送间隔。 */
function prismToken() {
    try {
        var doc = app.activeDocument;
        if (!doc) return jsonOut(false, "没有打开的文档");
        var n = 0;
        try { n = doc.historyStates.length; } catch (e) { n = 0; }
        return jsonOut(true, "", { token: n, name: doc.name });
    } catch (e) {
        return jsonOut(false, "读取文档失败: " + e);
    }
}

/* 探测本机 8765 服务端是否可连 (TCP 三次握手即可) */
function prismServerUp() {
    try {
        var sock = new Socket();
        var ok = sock.open("127.0.0.1:8765", "TCP");
        try { sock.close(); } catch (eClose) {}
        return ok;
    } catch (e) { return false; }
}

/* ---------- 外部进程启动 (ExtendScript 下可靠方式) ----------
 * 踩坑记录 / 为什么这么写:
 *   1) UXP 的 system.callSystem 在 ExtendScript 里并不存在(那是 UXP API),
 *      旧实现直接调它 -> ReferenceError「system.callSystem 不是函数」,
 *      异常被 catch 吞掉, 最终只剩一句「未找到可用的服务端启动方式」。
 *   2) `cmd /c start "" xxx` 同样不可用: 子进程会继承 ExtendScript 的输出句柄,
 *      而服务端是常驻进程, 会让调用一直等它退出 -> 面板卡死、推送无响应。
 *   3) PowerShell Start-Process 依赖 shell 转发, 且 -ArgumentList 会按空格重新
 *      切分含空格路径, 参数转义极易出错。
 *   4) 【闪窗根因(实测结论, Win11 25H2 / Build 26200)】`.cmd` + `start "" /min` 这套
 *      启动器闪黑窗的来源只有 cmd.exe 一个, 与 MirrorServer.exe 无关:
 *      a. cmd.exe 是控制台子系统程序, 被 ShellExecute / explorer 拉起时 OS 必然先
 *         给它分配控制台窗口 —— 脚本再短也躲不掉这一下闪现。本机默认终端已 handoff
 *         给 Windows Terminal, 实测闪出的是可见的 CASCADIA_HOSTING_WINDOW_CLASS
 *         「Windows Terminal」窗口, 比传统 conhost 黑框更醒目; 而 `start /min`
 *         只是把窗口「最小化」, 最小化的窗口依旧存在, 用户照样看得见。
 *      b. MirrorServer.exe 实测 PE OptionalHeader.Subsystem = 2
 *         (IMAGE_SUBSYSTEM_WINDOWS_GUI), 是 GUI 子系统产物, 自进程创建起就没有
 *         控制台窗口, 也无需靠 SW_HIDE 去遮 —— 只要把 cmd.exe 从启动链上摘掉,
 *         闪窗即彻底消失。(旧注释断言它「同为 PyInstaller 控制台子系统产物、必须
 *         隐藏其窗口」, 已被 PE 头实测证伪。)
 *
 * 现方案(完全静默): 用 **VBS 启动器 + wscript.exe** 替代 .cmd。
 *   - wscript.exe 是 GUI 子系统程序, 自身没有控制台 -> 不存在 cmd 那一闪;
 *   - VBS 里 `WshShell.Run(cmd, 0, False)` 第 2 参 = 窗口样式 0(SW_HIDE):
 *     wscript 会以 STARTF_USESHOWWINDOW/SW_HIDE 创建子进程, 全链路不再产生任何
 *     控制台对象, 因此也不会触发 Windows Terminal 的终端 handoff; 即便日后换成
 *     控制台子系统程序, 该标志同样能让其窗口创建即隐藏 -> 双保险;
 *   - 第 3 参 False = 不等待返回, 发起后立即返回 -> 常驻服务端不阻塞 ExtendScript;
 *   - VBS 顶部 `On Error Resume Next`: wscript 脚本出错会弹模态框, 必须吞掉,
 *     任何异常都不许在用户面前冒泡(否则"静默"就变成"弹窗");
 *   - File.execute() 走 Windows ShellExecute, .vbs 的默认打开方式即 wscript.exe
 *     (HKCR\VBSFile\shell\open\command), 全程不经过任何控制台;
 *   - 启动命令仍只带 `--mode watch`: watch-dir / beat-file / 端口全部使用服务端
 *     按"自身 exe 位置"推导出的默认值(<ext>\data\watch、<ext>\data\host.beat、
 *     8765), 命令行里不含任何路径, 从根上避开含空格路径的参数转义问题。 */
function prismLaunchServer(exePath, extraArgs) {
    if (!prismEnsureDir(PRISM_HOME)) return "无法创建数据目录: " + PRISM_HOME;

    /* 程序路径含盘符/空格时加双引号(安装位可能是 D:\Software\AI Agent\...);
       pythonw 这类裸命令名不加引号, 交给 CreateProcess 从 PATH 解析。 */
    var hasSep = (exePath.indexOf("/") !== -1 || exePath.indexOf("\\") !== -1 || exePath.indexOf(" ") !== -1);
    var prog = hasSep ? ('"' + exePath + '"') : exePath;
    var cmdline = prog + (extraArgs ? " " + extraArgs : "");

    /* VBS 字符串字面量转义: 内部双引号写成两个双引号 */
    var vbsCmd = cmdline.replace(/"/g, '""');

    var launcher = PRISM_HOME + "/prism_start_server.vbs";
    var f = new File(launcher);
    if (!f.open("w")) return "启动器写入失败: " + launcher;
    try {
        /* 注释行保持纯 ASCII, 避免 .vbs 的编码解析歧义(路径本身随系统编码写出) */
        f.write("' Prism silent server launcher -- auto-generated by host/main.jsx, safe to delete.\r\n");
        f.write("' WshShell.Run(cmd, 0, False): 2nd arg = window style 0 (SW_HIDE), 3rd = do not wait.\r\n");
        f.write("' wscript.exe is a GUI host without a console, and the child console app is created\r\n");
        f.write("' with STARTF_USESHOWWINDOW/SW_HIDE, so no window ever shows up.\r\n");
        f.write("' On Error Resume Next: never pop a modal error box at the user.\r\n");
        f.write("On Error Resume Next\r\n");
        f.write("Dim sh\r\n");
        f.write("Set sh = CreateObject(\"WScript.Shell\")\r\n");
        f.write("sh.Run \"" + vbsCmd + "\", 0, False\r\n");
        f.write("Set sh = Nothing\r\n");
    } finally {
        try { f.close(); } catch (eClose) {}
    }

    /* 清掉旧版 .cmd 启动器(闪窗元凶), 避免残留误用 */
    try {
        var stale = new File(PRISM_HOME + "/prism_start_server.cmd");
        if (stale.exists) stale.remove();
    } catch (eStale) {}

    try {
        if (new File(launcher).execute()) return "";
        return "启动器执行失败(File.execute 返回 false)";
    } catch (eEx) {
        return "启动器执行异常: " + eEx;
    }
}

/* ---------- pythoncom 可用性门槛 (方案 B: py 候选必须先过探测) ----------
 * 背景: 目标机实测 pythonw = 系统 Python313(没装 pywin32) —— 该解释器能跑 py 版
 *   服务端、8765 照常监听, 但 mirror_server.py 里 import pythoncom 抛
 *   "No module named 'pythoncom'", COM 通道永久不可用(见 data\com_probe.json /
 *   com_drive.log); 而面板折叠期唯一的节拍来源就是服务端 COM DoJavaScript
 *   (mirror_server.py 的 run_com_driver), 于是表现成"面板一折叠就停更"。
 * 对策: py 源码版仍优先(开发期改 py 即生效), 但必须先证明该解释器能 import
 *   pythoncom; 探测不通过(缺 pywin32 / 解释器不存在 / 探测异常或超时)一律视为
 *   不通过 -> prismEnsureServer 跳过它, 直接改用打包版 MirrorServer.exe。
 * 实现: 生成一次性探测脚本 prism_com_probe.py + 探测启动器 prism_com_probe.vbs,
 *   探测走 wscript + WshShell.Run 隐藏窗口通道(与 prismLaunchServer 同一机制,
 *   启动链上没有 cmd.exe -> 不会闪黑窗); 探测进程把结论写进 prism_com_probe.out,
 *   本函数在 PRISM_COM_PROBE_TIMEOUT_MS 内用 $.sleep 轮询该文件, 同步得到判定。
 *   轮询属一次性成本(通常几百毫秒, 上限即超时值), 只在服务端没起来时才走到,
 *   不在推送主链路上。
 * 为什么另起 .vbs 文件名: 不去跟服务端启动器 prism_start_server.vbs 抢同一个
 *   文件, 免得"探测的启动"与"被探测的启动"互相覆盖。
 * 容错: 任何异常都吞掉并返回不通过(回落 exe), 绝不让异常冒到 prismEnsureServer
 *   的 JSON 契约之外; 生成的两个文件一律纯 ASCII —— ExtendScript 按系统 ANSI
 *   编码落盘, 混入非 ASCII 会让 Python / wscript 解析出错。 */
var PRISM_COM_PROBE_POLL_MS = 50;       /* 探测结论轮询间隔(毫秒) */
var PRISM_COM_PROBE_TIMEOUT_MS = 2500;  /* 探测总超时: 超时即判不通过, 回落 exe */

/* 读探测结论(prismPythoncomOK 的轮询单元):
   null = 还没写完(继续等); "" = 通过; 其他 = 不通过原因(按 UTF-8 读回, 可直接上报)。 */
function prismReadComProbeVerdict(outPath) {
    try {
        var f = new File(outPath);
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var txt = "";
        try { txt = f.read(); } finally { try { f.close(); } catch (eC) {} }
        txt = ("" + txt).replace(/^[\s]+/, "");
        if (txt.indexOf("OK") === 0) return "";
        if (txt.indexOf("FAIL") === 0) {
            var why = txt.substring(4).replace(/[\r\n\t]+/g, " ").replace(/^[\s]+|[\s]+$/g, "");
            return why || "pythoncom 不可用(探测未给出原因)";
        }
        return null;   /* 空文件或半截内容: 等下一轮 */
    } catch (eRd) { return null; }
}

/* 探测 py 解释器能否真的 import pythoncom(方案 B 的判定入口)。
   返回: "" = 通过(该解释器可以跑 py 版服务端); 其他 = 不通过原因(直接拼进 tried)。
   绝不抛异常: 探测脚本/启动器写不出、启动器执行失败、轮询异常, 一律按不通过返回。 */
function prismPythoncomOK(py) {
    try {
        if (!prismEnsureDir(PRISM_HOME)) return "数据目录不可用: " + PRISM_HOME;
        var probePy = PRISM_HOME + "/prism_com_probe.py";
        var probeVbs = PRISM_HOME + "/prism_com_probe.vbs";
        var probeOut = PRISM_HOME + "/prism_com_probe.out";

        /* 上一轮结论先清掉, 免得把残留当成本轮判定。
           只删这一个探测结论文件(与 prismLaunchServer 清 prism_start_server.cmd
           同一做法), 路径固定不自造, 全程 try/catch 容错。 */
        try { var stale = new File(probeOut); if (stale.exists) stale.remove(); } catch (eStale) {}

        /* 1) 探测脚本本体: 成功写 "OK<TAB>模块路径", 失败写 "FAIL<TAB>原因";
              自身异常也兜住, 保证解释器只要起得来就一定有结论可读。 */
        var fp = new File(probePy);
        if (!fp.open("w")) return "探测脚本写入失败: " + probePy;
        try {
            fp.write("# Prism pythoncom probe -- auto-generated by host/main.jsx, safe to delete.\r\n");
            fp.write("# Pure ASCII on purpose: ExtendScript writes it in the system ANSI codepage,\r\n");
            fp.write("# so non-ASCII source would break Python 3's UTF-8 default assumption.\r\n");
            fp.write("# Usage: pythonw prism_com_probe.py <verdict-file>\r\n");
            fp.write("# Verdict: \"OK\" + TAB + pythoncom path, or \"FAIL\" + TAB + reason.\r\n");
            fp.write("# A file carries the verdict instead of the exit code because pythonw has no\r\n");
            fp.write("# console and the ExtendScript caller can only poll files (File.execute never waits).\r\n");
            fp.write("import sys\r\n");
            fp.write("\r\n");
            fp.write("\r\n");
            fp.write("def main():\r\n");
            fp.write("    out = sys.argv[1] if len(sys.argv) > 1 else \"\"\r\n");
            fp.write("    try:\r\n");
            fp.write("        import pythoncom\r\n");
            fp.write("        verdict = \"OK\\t\" + str(getattr(pythoncom, \"__file__\", \"\") or \"pythoncom\")\r\n");
            fp.write("    except BaseException as exc:\r\n");
            fp.write("        verdict = \"FAIL\\t%s: %s\" % (type(exc).__name__, exc)\r\n");
            fp.write("    try:\r\n");
            fp.write("        handle = open(out, \"w\", encoding=\"utf-8\")\r\n");
            fp.write("        try:\r\n");
            fp.write("            handle.write(verdict)\r\n");
            fp.write("            handle.flush()\r\n");
            fp.write("        finally:\r\n");
            fp.write("            handle.close()\r\n");
            fp.write("    except Exception:\r\n");
            fp.write("        pass\r\n");
            fp.write("\r\n");
            fp.write("\r\n");
            fp.write("main()\r\n");
        } finally {
            try { fp.close(); } catch (eC1) {}
        }

        /* 2) 探测启动器: 隐藏窗口拉起 <py> <探测脚本> <结论文件>。
              与服务端启动器同一机制, 只有两点不同: 第 3 参 True(等探测进程结束,
              好拿退出码); 解释器不存在 / 退出码非 0 / 探测没留下结论, 这三种情况
              由 VBS 自己补写 FAIL —— 免得"解释器压根不存在"也要干等到超时。 */
        var pyCmd = (py.indexOf("/") !== -1 || py.indexOf("\\") !== -1 || py.indexOf(" ") !== -1) ? ("\"" + py + "\"") : py;
        var vbsCmd = (pyCmd + " \"" + probePy + "\" \"" + probeOut + "\"").replace(/"/g, '""');
        var vbsOut = probeOut.replace(/"/g, '""');
        var fv = new File(probeVbs);
        if (!fv.open("w")) return "探测启动器写入失败: " + probeVbs;
        try {
            fv.write("' Prism pythoncom probe launcher -- auto-generated by host/main.jsx, safe to delete.\r\n");
            fv.write("' Same invisible mechanism as prism_start_server.vbs (wscript + WshShell.Run with\r\n");
            fv.write("' window style 0), kept under its own file name so it never races the server\r\n");
            fv.write("' launcher for the same .vbs file. ASCII only; no cmd.exe anywhere in the chain.\r\n");
            fv.write("' 3rd arg True: wait for the probe so its exit code can be read. The probe is\r\n");
            fv.write("' pythonw (GUI subsystem, no console) and is created with SW_HIDE -> no window.\r\n");
            fv.write("' A missing interpreter / non-zero exit / missing verdict all get a FAIL verdict\r\n");
            fv.write("' written here, so the caller never waits out the timeout for those three cases.\r\n");
            fv.write("' rc = sh.Run(...) MUST keep its parentheses. In an assignment VBScript reads\r\n");
            fv.write("' `rc = sh.Run \"cmd\", 0, True` as an unterminated statement and fails at\r\n");
            fv.write("' COMPILE time with a modal error box -- invisible here, so it would hang the\r\n");
            fv.write("' caller for the whole timeout (hit this in real testing).\r\n");
            fv.write("On Error Resume Next\r\n");
            fv.write("Dim sh, fso, rc, msg, f\r\n");
            fv.write("Set sh = CreateObject(\"WScript.Shell\")\r\n");
            fv.write("Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n");
            fv.write("rc = sh.Run(\"" + vbsCmd + "\", 0, True)\r\n");
            fv.write("If Err.Number <> 0 Then\r\n");
            fv.write("  msg = \"FAIL\" & vbTab & \"launch failed, err=\" & Hex(Err.Number)\r\n");
            fv.write("ElseIf rc <> 0 Then\r\n");
            fv.write("  msg = \"FAIL\" & vbTab & \"probe exit code \" & rc\r\n");
            fv.write("ElseIf Not fso.FileExists(\"" + vbsOut + "\") Then\r\n");
            fv.write("  msg = \"FAIL\" & vbTab & \"probe wrote no verdict\"\r\n");
            fv.write("End If\r\n");
            fv.write("If Len(msg) > 0 Then\r\n");
            fv.write("  Set f = fso.CreateTextFile(\"" + vbsOut + "\", True)\r\n");
            fv.write("  f.Write msg\r\n");
            fv.write("  f.Close\r\n");
            fv.write("End If\r\n");
            fv.write("Set f = Nothing\r\n");
            fv.write("Set fso = Nothing\r\n");
            fv.write("Set sh = Nothing\r\n");
        } finally {
            try { fv.close(); } catch (eC2) {}
        }

        /* 3) 执行 + 有界轮询: 拿到结论立即返回, 绝不多等 */
        try {
            if (!new File(probeVbs).execute()) return "探测启动器执行失败(File.execute 返回 false)";
        } catch (eEx) { return "探测启动器执行异常: " + eEx; }

        var waited = 0;
        while (true) {
            var verdict = prismReadComProbeVerdict(probeOut);
            if (verdict !== null) return verdict;
            if (waited >= PRISM_COM_PROBE_TIMEOUT_MS) {
                return "pythoncom 探测超时(" + PRISM_COM_PROBE_TIMEOUT_MS + "ms), 按不通过处理";
            }
            try { $.sleep(PRISM_COM_PROBE_POLL_MS); }
            catch (eSleep) { return "探测结果无法轮询($.sleep 不可用): " + eSleep; }
            waited += PRISM_COM_PROBE_POLL_MS;
        }
    } catch (e) {
        return "pythoncom 探测异常: " + e;
    }
}

/* 确保 mirror_server 已运行: 面板打开 / 轮询失败 / 点击推送时调用。
   服务未启动时异步拉起服务端(免传参 + File.execute 启动器), 不阻塞面板;
   具体启动方式与踩坑见 prismLaunchServer 上方注释。 */
function prismEnsureServer(force) {
    if (!force && prismServerUp()) return jsonOut(true, "server already up");
    var tried = "";
    var i, py;

    /* 1) 优先用本机 Python 直接跑 mirror_server.py。
       ★为什么 py 排在 exe 前面: MirrorServer.exe 是打包产物, 改了 py 不重新打包就
       完全不生效 —— 现场已踩过这个坑: 服务端明明加了"折叠期 COM 外部节拍"和
       com_drive.log, 跑起来却一个都没有, 因为 8765 端口上蹲着的还是上一版 exe。
       开发期一律以 py 为准, 改完即生效; 没装 Python 的机器自动回落 exe(发布形态)。
       ★为什么 py 优先还要附加"能 import pythoncom"这道硬门槛(2026-09-15 起):
       还有一个更隐蔽的坑 —— 目标机 pythonw 指向系统 Python313(没装 pywin32),
       py 版服务端照样起得来、8765 照样监听, 只是 import pythoncom 失败 ->
       COM 通道永久不可用(见 data\com_probe.json), 而折叠期唯一的节拍来源就是
       服务端 COM DoJavaScript -> 表现为"面板一折叠就停更"。这种机器上 py 版不是
       "能用但旧", 而是"占着端口假装在线", 比回落 exe 更糟, 所以必须先探测。
       ★勿删此门槛: 探测细节与隐藏窗口实现见上方 prismPythoncomOK 注释。 */
    var serverPy = "";
    if (new File(SERVER_DIR + "/mirror_server.py").exists) serverPy = SERVER_DIR + "/mirror_server.py";
    if (serverPy) {
        var cands = ["pythonw", "python"];
        for (i = 0; i < cands.length; i++) {
            py = cands[i];
            /* 硬门槛: 该解释器必须真能 import pythoncom, 否则不许它去占 8765 */
            var whyNoCom = prismPythoncomOK(py);
            if (whyNoCom) { tried += py + "(跳过: " + whyNoCom + "); "; continue; }
            var errPy = prismLaunchServer(py, "\"" + serverPy + "\" --mode watch");
            if (!errPy) return jsonOut(true, "server starting: " + py + " (py 版, pythoncom 可用)");
            tried += py + ":" + errPy + "; ";
        }
    }

    /* 2) 兜底: 免 Python 的独立服务端 (随插件一起装在 <ext>\server 下) */
    var exePath = SERVER_DIR + "/MirrorServer.exe";
    if (new File(exePath).exists) {
        var errExe = prismLaunchServer(exePath, "--mode watch");
        if (!errExe) return jsonOut(true, "server starting: MirrorServer.exe (打包版, 不含最新改动)");
        tried += "exe:" + errExe + "; ";
    }

    return jsonOut(false, "未找到可用的服务端启动方式 " + tried);
}

/* 确保 watch 目录存在(含上层 D 盘项目目录) */
function ensureWatchDir() {
    return prismEnsureDir(WATCH_DIR.fsName);
}

/* ---------- watch 残留清理(插件侧, 只清自己这一批) ----------
 * 与 server/mirror_server.py 的 cleanup_watch_dir() 职责互补:
 *   - 本函数只在"导出前"调用, 清掉同批历史残片, 保证本次导出从干净状态开始;
 *   - 崩溃/异常退出遗留由服务端在启动 / 源离线 / 宿主退出时统一兜底清理。
 * 只删文件, 不删 watch 目录本身, 不碰子目录, 不碰目录外任何内容; 全程容错。 */
var WATCH_RESIDUE_RE = /\.(png|jpg|jpeg|webp|psd|tmp|part)$/i;
var RESIDUE_MIN_AGE_MS = 5000;   // 只清 5s 之前的残片, 避免误删服务端尚未读取的最新帧

function clearWatchResidue(outFile) {
    /* 1) 同名目标文件: 必是上一批本程序写的(含上次失败留下的半成品),
          直接删掉, 防止半截文件被服务端当成新帧推送。 */
    try { if (outFile && outFile.exists) outFile.remove(); } catch (e0) {}

    /* 2) 目录内其它历史残片: 只认本程序产生的图片/中间后缀, 且只清 5s 之前的,
          不碰最新一帧、不碰子目录、不碰目录外内容。 */
    if (!WATCH_DIR.exists) return;
    var files = null;
    try { files = WATCH_DIR.getFiles(); } catch (e1) { return; }
    var now = (new Date()).getTime(), i;
    for (i = 0; i < files.length; i++) {
        try {
            var f = files[i];
            if (f instanceof Folder) continue;
            if (!WATCH_RESIDUE_RE.test(f.name)) continue;
            var mt = 0;
            try { mt = f.modified ? f.modified.getTime() : 0; } catch (eM) { mt = 0; }
            if (mt > 0 && (now - mt) < RESIDUE_MIN_AGE_MS) continue;
            f.remove();
        } catch (eOne) {}
    }
}

/* 对指定文档导出 PNG/JPEG 到 outFile (不修改原稿, 保留透明)。
   多级兜底, 任一级成功即返回:
     ① Save for Web        —— 主路径(顺带承担输出缩放, 见 sfwEdge/sfwScale);
     ② saveAs(PNG, asCopy) —— 不依赖 SFW 组件的通道;
     ③ 工作副本兜底         —— 合并可见图层 + 转 8 位 RGB 后再导。**只在调用方显式
                               传入工作副本(tmpDoc)时生效**; 推送路径恒传 null, 因为
                               自建副本(duplicate)会开合文档窗口 = 闪屏, 与零闪屏冲突。
   ★每级都重新构造 File 对象核对产物: ExtendScript 的 File.length 有属性缓存,
     不重建对象会把刚写好的帧误判成 0 字节("导出结果为空"的现场成因之一)。
   ★outFile 必须是 .png/.jpg 扩展名: 导出器按目标扩展名挑编码器, 写成 .psd 会走
     PSD 编码器, 结果产不出图片文件。
   返回 { ok: bool, how: string, msg: string, w: int, h: int } —— w/h 是**实际落盘帧**
   的像素尺寸(① 走 SFW 输出缩放时就是缩放后的尺寸), 供宿主上报给面板/服务端核对。 */
function exportPng(doc, outFile, is16Bit, tmpDoc, sfwEdge, sfwScale) {
    var outW = 0, outH = 0;
    try {
        outW = Math.round(parseFloat(doc.width.as("px")));
        outH = Math.round(parseFloat(doc.height.as("px")));
    } catch (eSz0) {}
    var log = [];
    function usable() {
        try {
            if (!outFile) return false;
            var probe = new File(outFile.fsName);
            return (probe.exists && probe.length > 0);
        } catch (eU) { return false; }
    }
    function prep() {
        try { if (outFile.exists) outFile.remove(); } catch (e0) {}
    }

    /* ① Save for Web PNG-24 */
    try {
        prep();
        var sfw = new ExportOptionsSaveForWeb();
        /* ★自动跟随帧改走 JPEG: PS 主线程编码一张 2560px PNG-24 实测 3~6s(现场表现
           就是"每帧把 PS 卡住好几秒、没法操作"), 同尺寸 JPEG 的 DCT 编码不到 1s ——
           预览要的是"看得出画面变了", 不是像素级无损; 这是"零副本(不闪屏)"前提下
           唯一能把主线程成本真正压下来的通道。
           手动推送仍是 PNG-24 全彩(用户要看清细节时用)。
           代价: JPEG 无 alpha, 透明背景会合成到白底。 */
        var useJpeg = true;
        try { useJpeg = !PRISM_PUSH_MANUAL; } catch (eUJ) {}
        if (useJpeg) {
            try { sfw.format = SaveDocumentType.JPEG; } catch (eFj) {}
            /* ★编码质量(清晰度修复): 旧值 82 是"编码最快"的取舍, 手机端放大看文字 /
               线条边缘能看到明显 JPEG 振铃(块效应) —— 这是"预览发糊"的观感来源之一。
               改走 PUSH_JPEG_QUALITY(默认 95, 视觉无损档): 同尺寸帧编码耗时仍在 1s
               以内(PS 主线程可接受), 代价只是单帧体积大几百 KB。 */
            var jq = 95;
            try { if (typeof PUSH_JPEG_QUALITY !== "undefined" && PUSH_JPEG_QUALITY > 0) jq = PUSH_JPEG_QUALITY; } catch (eQ0) {}
            try { sfw.quality = jq; } catch (eQj) {}
            sfw.PNG8 = false;
            sfw.transparency = false;
        } else {
            sfw.format = SaveDocumentType.PNG;
            sfw.PNG8 = false;          // PNG-24
            sfw.transparency = true;   // 保留透明通道
        }
        sfw.interlaced = false;
        /* ★跟随帧的输出缩放: ExportOptionsSaveForWeb 自带 width/height, 由 PS 在
           导出阶段直接产出小图 —— 不建副本、不动原文档、不开新文档窗口, 是"零闪屏"
           与"零卡顿"唯一能兼得的通道。
           历史缺陷: 整画布跟随为了不闪屏改成直导原文档全尺寸(降采样甩给服务端),
           结果每帧都在 PS 主线程上编码一张 3.4MB 的 2560px PNG(实测单帧约 7s) ——
           用户侧表现就是"折叠能刷但延迟 20s、还卡操作"。服务端 shrink_frame 只能
           省手机端流量, 省不掉 PS 这一侧的编码开销, 缩放必须提前到 PS 导出阶段。
           手动推送传 0(或未传): 按用户选的倍率原样出图, 不受此限。 */
        try {
            var edge = sfwEdge || 0;
            var sc = sfwScale || 0;
            var ow = Math.round(parseFloat(doc.width.as("px")));
            var oh = Math.round(parseFloat(doc.height.as("px")));
            if (edge > 0) {
                var oMax = Math.max(ow, oh);
                if (oMax > edge) {
                    outW = Math.max(1, Math.round(ow * edge / oMax));
                    outH = Math.max(1, Math.round(oh * edge / oMax));
                }
            } else if (sc > 0 && sc != 1) {
                /* 手动推送的倍率: 原尺寸 × 用户选的倍率。 */
                outW = Math.max(1, Math.round(ow * sc));
                outH = Math.max(1, Math.round(oh * sc));
            }
            if (outW > 0 && outH > 0 && (outW != ow || outH != oh)) {
                sfw.width = outW; sfw.height = outH;
            }
        } catch (eSz) {}
        doc.exportDocument(outFile, ExportType.SAVEFORWEB, sfw);
        if (usable()) return { ok: true, how: "sfw", w: outW, h: outH,
            msg: "sfw ok" + (outW > 0 && outH > 0 ? (" out=" + outW + "x" + outH) : "") };
        log.push("sfw:empty");
    } catch (e1) {
        log.push("sfw:err=" + e1);
    }

    /* ② saveAs(PNG, asCopy) —— 不依赖 Save for Web 组件。
       ★本机 PS 2026 的 Save for Web 组件已被停用(组件文件在场但扩展名非 .8bi,
         exportDocument 不报错却一个字节都不落盘 —— 这就是"导出结果为空"的根因),
         所以必须有一条不依赖该组件的通道。asCopy=true: 只写目标文件,
         不改变原文档的存储路径与未保存状态。 */
    try {
        prep();
        var pngOpt = new PNGSaveOptions();
        try { pngOpt.interlaced = false; } catch (eI) {}
        try { pngOpt.compression = 8; } catch (eC1) {}
        doc.saveAs(outFile, pngOpt, true);
        if (usable()) return { ok: true, how: "saveAs-png", w: outW, h: outH,
            msg: log.join("; ") + "; saveAs-png ok" };
        log.push("saveAs-png:empty");
    } catch (e2) {
        log.push("saveAs-png:err=" + e2);
    }

    /* ③ 工作副本兜底: 合并可见图层 + 转 8 位 RGB 后再 saveAs。
       ★零闪屏硬指标(2026-09-15 回归修复): 旧实现在 ① ② 都失败时"自建一次性副本"
         再重试 —— doc.duplicate() 会开出一个新文档窗口并抢焦点, 用完再 close, 即使
         用户看不到也是一次实实在在的窗口开合(=闪屏), 与"推送路径零 duplicate"直接
         冲突, 故移除。本段现在只在调用方**显式传入工作副本(tmpDoc)**时生效, 推送
         路径恒传 null 即不生效 —— ① SFW 与 ② saveAs 都在原文档上直出, 零窗口动作。 */
    var workDoc = tmpDoc;
    if (workDoc) {
        try {
            prep();
            try { workDoc.flatten(); } catch (eF) {}
            try { workDoc.bitsPerChannel = BitsPerChannelType.EIGHT; } catch (eB) {}
            var pngOpt2 = new PNGSaveOptions();
            try { pngOpt2.interlaced = false; } catch (eI2) {}
            workDoc.saveAs(outFile, pngOpt2, true);
            if (usable()) return { ok: true, how: "saveAs-png-8bit", w: outW, h: outH,
                msg: log.join("; ") + "; saveAs-png-8bit ok" };
            log.push("saveAs-png-8bit:empty");
        } catch (e3) {
            log.push("saveAs-png-8bit:err=" + e3);
        }
    }
    return { ok: false, how: "none", msg: log.join("; ") };
}

/* 跟随帧的发布名: 在文档名后面挂一层 .jpg(帧以 JPEG 承载, 导出器按末尾扩展名挑
   编码器, 所以这层后缀不能省), 服务端再减掉它还原出 PS 里的文档名。
   ★必须"保留原后缀 + 追加 .jpg", 不能先删原后缀: "数字中台系统.psd" 若写成
     "数字中台系统.jpg", 服务端还原出来是 "数字中台系统"(丢了 .psd), 展示名与 PS
     标签对不上; 文档本身是 photo.jpg 时更能看出差别("photo.jpg.jpg" -> "photo.jpg")。
   没有已知扩展名时补 .psd; 全程容错。 */
function prismJpegName(base) {
    try {
        var n = "" + base;
        if (!/\.(psd|psb|tif|tiff|png|jpg|jpeg|gif|bmp|webp)$/i.test(n)) n += ".psd";
        return n + ".jpg";
    } catch (e) { return ("" + base) + ".jpg"; }
}

/* 读帧文件的实际像素尺寸(仅诊断: export.log 的 px=WxH)。直接解析文件头, 不依赖任何
   PS 接口; 失败返回空串, 绝不影响导出。 */
function prismImgSize(path) {
    try {
        var f = new File(path);
        if (!f.exists) return "";
        f.encoding = "BINARY";
        if (!f.open("r")) return "";
        var b = null;
        try { b = f.read(1900); } finally { try { f.close(); } catch (eC) {} }
        if (!b) return "";
        var n = b.length;
        if (n > 24 && b.charCodeAt(0) === 0x89 && b.charCodeAt(1) === 0x50) {   // PNG: IHDR 宽高
            return (b.charCodeAt(16) * 16777216 + b.charCodeAt(17) * 65536 + b.charCodeAt(18) * 256 + b.charCodeAt(19)) +
                "x" + (b.charCodeAt(20) * 16777216 + b.charCodeAt(21) * 65536 + b.charCodeAt(22) * 256 + b.charCodeAt(23));
        }
        if (n > 24 && b.charCodeAt(0) === 0xFF && b.charCodeAt(1) === 0xD8) {   // JPEG: 扫 SOFn 段
            var i = 2;
            while (i + 9 < n) {
                if (b.charCodeAt(i) !== 0xFF) { i++; continue; }
                var mk = b.charCodeAt(i + 1);
                if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
                    return (b.charCodeAt(i + 7) * 256 + b.charCodeAt(i + 8)) +
                        "x" + (b.charCodeAt(i + 5) * 256 + b.charCodeAt(i + 6));
                }
                var seg = b.charCodeAt(i + 2) * 256 + b.charCodeAt(i + 3);
                if (seg <= 0) break;
                i += 2 + seg;
            }
        }
    } catch (e) {}
    return "";
}

/* ---------- 核心: 推送预览 ---------- */
function prismPush(mode, scale) {
    scale = scale || 1;
    var src = null;
    try { src = app.activeDocument; } catch (e) {}
    if (!src) return jsonOut(false, "没有打开的文档");

    /* ★闪屏根因(两轮各有一处, 现已全部清除):
       ① 旧实现"画布超出限边就建副本降采样" —— duplicate 会在 PS 里开出一个新文档窗口
          并把焦点切过去, 导出完再 close, 每跟一帧闪两次(已改: 降采样放服务端
          shrink_frame, 见 server/mirror_server.py);
       ② 上一轮把"画板/选区"的裁剪做在 duplicate 出来的副本上(删其余画板 / 去画板化 /
          打组 / 加蒙版 / crop) —— 副本窗口开合叠加副本上的结构性改动, 会让 PS 重绘文档
          窗口, 跟随帧每帧来一次, 就是现场看到的严重闪屏(选"当前画板"和"当前选区"都闪)。
       定案(零闪屏硬指标): 本函数内零 duplicate、零文档关闭、零 activeDocument 切换、
       零文档结构改动 —— 画板/选区一律"直导整画布 + 上报几何 + 服务端裁剪",
       见下方"目标几何"块。 */
    var oldDialogs = null;
    var outFile = null;     // 本次导出的目标文件(失败时在 finally 里清半成品)
    var okExport = false;   // 是否已产出完整帧: 成功帧由服务端删, 插件不删
    var t0 = (new Date()).getTime();   // 本帧从进函数到落盘的总耗时(写进 export.log 的 cost)

    try {
        oldDialogs = app.displayDialogs;
        app.displayDialogs = DialogModes.NO; // 抑制原生对话框

        if (!ensureWatchDir()) return jsonOut(false, "无法创建 watch 目录: " + WATCH_DIR.fsName);

        /* ---------- 目标几何(只算坐标, 绝不动文档) ----------
           ★零闪屏定案: 画板/选区的裁剪不再由 PS 侧做。PS 侧永远只导出【整画布】帧,
             同时把"本轮要显示的区域"(画布坐标, px)随帧上报, 由服务端收帧后用 Pillow 裁。
             推送路径上因此没有任何 duplicate / 切 activeDocument / 删画板 / 去画板化 /
             ungroup / 打组 / 加蒙版 / crop —— PS 文档窗口全程不被触碰, 零闪屏。
             (选区本来也被画板规则牵制: 画板文档里 Document.crop 会被"画布必须包住所有
              画板"顶回整画布; 放到服务端裁剪, 顺带把"裁不动"与"闪屏"一并解决。) */
        var cvW = Math.round(parseFloat(src.width.as("px")));   // 整画布尺寸: 帧坐标换算基准
        var cvH = Math.round(parseFloat(src.height.as("px")));
        var viewRect = null;      // 要显示的区域(画布坐标 [l,t,r,b])
        var viewUsed = false;     // 本帧是否带几何(带则服务端裁)
        var abSel = null;         // 当前画板(含 artboardRect), 仅 artboard 模式用
        var abFallback = "";      // artboard 模式拿不到画板时的退因(非空 = 本帧按整画布推)
        if (mode === "selection") {
            var sel = selectionPx(src);
            if (!sel) return jsonOut(false, "当前没有有效选区, 请先框选区域");
            viewRect = sel;
            viewUsed = true;
        } else if (mode === "artboard" || mode === "auto") {
            /* ★上一轮修复: 画板判定改走 Action Manager(artboardEnabled), 旧写法用
               LayerKind.ARTBOARD 这个不存在的枚举常量, 恒判 false 才导致"永远不在画板内"的误报。
               mode "auto" 与 artboard 走同一分支(有画板取画板 / 没画板退整画布)。
               ★本轮契约变化: 面板下拉已由三项并为两项(只留「当前画板」/「当前选区」),
               "整个画布"不再由面板产生 —— 「当前画板」就是面板上的自适应项(同 auto 语义)。
               宿主侧无需为此再改分支; mode "canvas"(整画布、不裁)分支必须保留给
               旧客户端与 prismExternalPush 外部传参, 不得删除或使其失效。 */
            abSel = findActiveArtboard(src);
            if (!abSel) {
                /* ★自适应回退(修"切到无画板文档后跟随停更"): 拿不到画板时**不再报错中断** ——
                   本帧直接按整画布推送 + 上报 canvas 清零旧几何, 照常产出帧、令牌照常推进,
                   跟随链一秒都不停。两种情形都走这里: 文档根本没画板 / 活动图层在画板外。
                   ★这里以前是 return jsonOut(false, ...): 失败的返回值会让 prismPushTick
                   不推进令牌基线、并触发失败退避(+2s), 切到无画板文档后画面就永久停在
                   上一个文档 —— 这正是用户报的"切文档后手机端不再跟随"的主因。 */
                var abCnt = 0;
                try { abCnt = prismListArtboards(src).length; } catch (eCnt) { abCnt = 0; }
                abFallback = abCnt ? "layer-outside" : "no-artboard";
            } else if (!abSel.rect) {
                abFallback = "no-rect";     // 读不到画板边界: 同样退整画布, 不中断跟随
            } else {
                viewRect = abSel.rect;
                viewUsed = true;
            }
        }
        if (viewRect) {
            viewRect[0] = Math.max(0, Math.floor(parseFloat(viewRect[0])));
            viewRect[1] = Math.max(0, Math.floor(parseFloat(viewRect[1])));
            viewRect[2] = Math.min(cvW, Math.ceil(parseFloat(viewRect[2])));
            viewRect[3] = Math.min(cvH, Math.ceil(parseFloat(viewRect[3])));
            if (viewRect[2] <= viewRect[0] || viewRect[3] <= viewRect[1]) {
                /* 退化矩形(画板报空矩形 / 选区被算出画布外): 跟进链不许在这里断 ——
                   画板类模式退整画布继续出帧(日志留退因); 真·空选区仍给提示(用户框一下即可,
                   属于合理提示, 不是链路故障)。 */
                if (mode === "selection") return jsonOut(false, "选区为空, 请重新框选区域");
                abFallback = "empty-rect";
                viewRect = null;
                viewUsed = false;
            }
        }
        /* 上报给服务端的 mode 只有 artboard / selection 两种语义(服务端据此决定裁不裁):
           "auto" 走的本来就是画板那一套(拿不到画板就退整画布), 上报时归一成 "artboard",
           否则服务端不认识 auto 会把几何当成无效值直接清掉 = 永远不裁。 */
        var reportMode = (mode === "auto") ? "artboard" : mode;

        /* ---------- 输出对象: 恒为原文档(零副本 = 零闪屏) ----------
           ★硬指标: 推送/跟随路径上不出现 duplicate、不切 activeDocument、不关文档窗口、
             不改文档结构 —— PS 侧一张文档窗口都不动, 自然不闪。
           ★上报必须早于出帧: 服务端是"收帧时按当时的几何裁一刀", 若帧先落盘再上报,
             本帧就会按上一轮的几何裁 —— 刚切到画板/选区模式时的第一帧尤其明显。
             上报失败只影响裁剪(退回整画布), 记进 export.log, 绝不影响出帧。 */
        var exportDoc = src;
        var docW = Math.round(parseFloat(src.width.as("px")));
        var docH = Math.round(parseFloat(src.height.as("px")));
        var is16Bit = false;
        try { is16Bit = (src.bitsPerChannel == BitsPerChannelType.SIXTEEN); } catch (e) {}

        var viewTag = "canvas";
        if (viewUsed) {
            viewTag = reportMode + ":" + viewRect[0] + "," + viewRect[1] + "," + viewRect[2] + "," + viewRect[3];
        }
        /* 自适应回退帧: 日志里必须能一眼看出"这一帧为什么是整画布", 否则
           "切到无画板文档后画面变成整画布"会被误当成 bug。 */
        if (abFallback) viewTag = "canvas(fallback:" + abFallback + ")";
        var viewPosted = prismViewReport(viewUsed ? reportMode : "canvas", cvW, cvH, viewUsed ? viewRect : null);
        if (viewUsed && !viewPosted) viewTag = viewTag + "(post-fail)";

        /* ---------- 输出尺寸: 全部由 SFW 的输出参数完成 ----------
           ★不 resizeImage: 改像素尺寸必须先建副本(副本 = 新文档窗口 = 闪屏), 所以缩放
             一并交给导出阶段。
           ★清晰度定案: 跟随帧默认【按设计稿原始像素 1:1 导出】, 不再压到 1080 ——
             1080 会让手机端只能看"大概", 放大全是糊的。PUSH_MAX_AUTO_EDGE 自此只是
             防卡死的安全阀(默认 4096, 与服务端 FRAME_MAX_EDGE 同值), 正常设计稿
             (长边 ≤4096) 一律原尺寸出图。
             手动推送按用户选的倍率(>1 放大, =1 原样, 帧走 PNG-24 无损且保留透明)。
           ★画板/选区模式注意: 帧本身是整画布, 由服务端按上报几何裁一刀; 所以这里
             比对的是【画布】长边 —— 画布一旦超过安全阀, 目标区域会跟着同比例缩小。 */
        var sfwEdge = 0, sfwScale = 0;
        if (PRISM_PUSH_MANUAL) {
            if (scale > 1) sfwScale = scale;
        } else {
            sfwEdge = PUSH_MAX_AUTO_EDGE;
        }

        /* 导出文件名 = PS 文档全名(含 .psd 扩展名), 与 PS 文档标签完全一致,
           手机端「文档」区即显示当前 PS 文档名; 文件内容仍是 PNG-24。
           ★两处要害:
             ① 导出器按目标扩展名挑编码器 —— 中间帧必须叫 .png, 直接写 .psd 会走
                PSD 通道, 产不出 PNG(现场表现为"导出结果为空, 已清理残片");
             ② 中间帧先落在 watch 顶层之外的 _stage\ 子目录 —— 服务端 run_watch
                只扫 watch 顶层, 否则中间帧会被抢读成帧、或在改名瞬间被 unlink,
                导致插件侧核对时文件已消失, 又把成功帧误判为失败。 */
        var STAGE_DIR = WATCH_DIR.fsName + "/_stage";
        prismEnsureDir(STAGE_DIR);
        var docBase = (src.name || "untitled").replace(/[\\\/:*?"<>|]/g, "_");
        /* ★帧文件后缀必须与导出格式一致(导出器按目标扩展名挑编码器), 而手机端要显示的是
           PS 文档名 —— 跟随帧改走 JPEG 后只能"以 .jpg 承载、由服务端把展示名还原成 .psd"
           (见 mirror_server.py 的 display_name)。两者不能再像 PNG 时代那样同名。 */
        var useJpegF = true;
        try { useJpegF = !PRISM_PUSH_MANUAL; } catch (eUJ2) {}
        var framePath = STAGE_DIR + "/__prism_frame__." + (useJpegF ? "jpg" : "png");
        var publishName = useJpegF ? prismJpegName(docBase) : docBase;
        var finalPath = WATCH_DIR.fsName + "/" + publishName;
        outFile = new File(framePath);      // 失败时 finally 清的是中间帧

        /* 导出前先清掉同批历史残片(同名旧文件 + 目录内过期临时文件),
           避免上次失败留下的半截 PNG 被服务端当成新帧推送。 */
        clearWatchResidue(new File(finalPath));
        try { if (outFile.exists) outFile.remove(); } catch (eTR) {}

        /* 缩放在函数开头决定(sfwEdge / sfwScale), 这里只直导原文档 —— 零副本、零窗口
           动作。选区/画板帧同样是整画布帧, 裁哪一块由服务端按上面的几何上报决定。 */
        var exp = exportPng(exportDoc, outFile, is16Bit, null, sfwEdge, sfwScale);
        if (!exp.ok) return jsonOut(false, "导出失败: " + exp.msg);
        try {
            if (exp.w > 0 && exp.h > 0) { docW = exp.w; docH = exp.h; }
        } catch (eWH) {}

        /* 发布: 把中间帧复制成"文档全名"落到 watch 顶层(服务端只扫顶层)。
           ★复制成功即视为已发布, 不再回头核对顶层文件是否还在 —— 服务端读到后
             立刻 unlink, 此刻核对必然扑空, 会把已成功的帧判成失败。 */
        try { var oldFrame = new File(finalPath); if (oldFrame.exists) oldFrame.remove(); } catch (eOld) {}
        var published = false;
        try { published = outFile.copy(finalPath); } catch (eCp) { published = false; }
        if (!published) return jsonOut(false, "帧发布失败: " + finalPath);
        try { if (outFile.exists) outFile.remove(); } catch (eRm) {}

        /* 视觉上要能自证"这一帧真的按画板裁了": 服务端把帧缩到限边后, 画板帧的
           像素高宽 = (画板高宽 × 缩放), 与整画布帧不同。据此给出裁后预期尺寸, 面板/
           心跳直接显示 —— 用户不必翻日志就能判断"当前画板"是否生效(旧版只能看到
           整画布尺寸, 分不清是没裁还是裁了)。
           本帧不带几何(整画布 / 自适应回退)时不出这两项, 契约保持与旧客户端兼容。 */
        var viewOut = null;
        if (viewUsed) {
            try {
                var vSc = 1;
                if (docW > 0 && cvW > 0) vSc = docW / cvW;   // SFW 输出缩放比(帧宽/画布宽)
                var vW = Math.round((viewRect[2] - viewRect[0]) * vSc);
                var vH = Math.round((viewRect[3] - viewRect[1]) * vSc);
                if (vW > 0 && vH > 0) viewOut = [vW, vH];
            } catch (eV) { viewOut = null; }
        }

        okExport = true;   // 成功帧保留在 watch 目录, 由服务端读取发布后删除
        var finalFile = new File(finalPath);
        var finalLen = -1;
        try { if (finalFile.exists) finalLen = finalFile.length; } catch (eFL) {}
        PRISM_PUSH_OK_COUNT = PRISM_PUSH_OK_COUNT + 1;
        /* 诊断日志降频: prismDiagAppend 是"读全文 + 写全文", 每帧都调用会成为
           实打实的磁盘负担(自动跟随下尤甚)。只在手动推送 / 刚恢复成功 / 每 10 帧落一条。 */
        if (PRISM_PUSH_MANUAL || PRISM_PUSH_FAILS > 0 || (PRISM_PUSH_OK_COUNT % 10) === 1) {
            prismDiagAppend("export.log", prismDiagTime() + " ok#" + PRISM_PUSH_OK_COUNT +
                " how=" + exp.how + " mode=" + mode + " view=" + viewTag +
                " name=" + publishName + " bytes=" + finalLen +
                " px=" + prismImgSize(finalPath) + " cost=" + ((new Date()).getTime() - t0) + "ms" +
                " auto=" + (PRISM_PUSH_AUTO ? "1" : "0") + " | " + exp.msg);
        }
        var okMsg = "ok";
        if (abFallback) {
            okMsg = (abFallback === "layer-outside")
                ? "当前图层不在画板内, 本帧已自动回退推送整个画布"
                : "当前文档没有画板, 本帧已自动回退推送整个画布";
        }
        var okExtra = {
            file: finalPath,
            name: src.name,   // 心跳上报用: 当前 PS 文档全名(含 .psd)
            how: exp.how,
            width: Math.round(docW),
            height: Math.round(docH),
            sizeKB: (finalLen > 0 ? Math.round(finalLen / 1024) : -1)
        };
        /* 范围诊断(面板/心跳可读): scope 是面板选的下拉项, viewUsed 才是宿主真正
           上报了几何、服务端真会裁 —— 两者不一致 = 走了自适应回退, 面板据此提示。 */
        try {
            okExtra.scope = mode;
            okExtra.viewUsed = viewUsed;
            if (abFallback) okExtra.abFallback = abFallback;
            if (viewOut) { okExtra.viewWidth = viewOut[0]; okExtra.viewHeight = viewOut[1]; }
        } catch (eExtra) {}
        return jsonOut(true, okMsg, okExtra);
    } catch (e) {
        return jsonOut(false, "导出异常: " + e);
    } finally {
        try { app.displayDialogs = oldDialogs; } catch (e7) {}
        /* ★本函数不再有任何需要收尾的文档动作: 全程只在原文档上直导, 没有副本可关、
           没有 activeDocument 要还原、没有结构改动要撤销 —— "零窗口动作"既是零闪屏的
           保证, 也让这里不需要任何补偿逻辑。 */
        /* 导出失败/中断(含异常抛出打断): 删除半成品, 不留 0 字节或半截 png。
           成功帧(okExport=true)不在此处删除 —— 交服务端读取发布后 unlink,
           避免插件与服务端两边抢删。全程容错, 清理失败也不影响返回值。 */
        if (!okExport && outFile) {
            try { if (outFile.exists) outFile.remove(); } catch (eClean) {}
        }
    }
}

/* ---------- 宿主侧推送会话: 面板折叠/关闭后推送不断 ----------
 * 为什么必须放在宿主(PS 进程内)而不是面板里:
 *   CEP 面板是 Chromium 页面。面板不可见时(折叠、被其它面板遮挡、切到别的
 *   面板标签), Chromium 会节流后台页面的 setInterval(降到 1s 甚至暂停),
 *   面板里跑的"心跳"与"画布令牌轮询"随之停摆 —— 服务端 BEAT_TIMEOUT(10s)
 *   一到就判定源离线, 手机端显示本机源消失。这就是"点推送后一折叠面板
 *   推送就断"的根因。
 *   ExtendScript 的 app.scheduleTask 由 PS 主进程调度, 与面板是否可见、
 *   是否打开都无关; 所以把"心跳保活 + 画布变动检测"整体下沉到宿主:
 *     · 保活: 每 PUSH_TICK_MS 用 Socket 直接 POST /api/heartbeat(请求体为
 *             纯 ASCII, 不含中文, 不涉及 UTF-8 字节长度换算);
 *     · 跟随: 同一 tick 内比对画布令牌("文档名#编辑序号"), 变化即导出推送。
 *   面板只做 UI: 开/关调 prismPushStart / prismPushStop, 重开面板时用
 *   prismPushState 把按钮与下拉框状态恢复回来。
 * 生命周期: 一旦开启就常驻, 只有 ①用户点「关闭推送」 ②退出 PS 才结束
 *   (PS 退出 -> 宿主调度器消失 -> 心跳停 -> 服务端租约超时自行退出)。
 */
var PUSH_TICK_MS = 1000;             // 巡检间隔: 心跳保活 + 画布令牌比对
var PUSH_MIN_GAP_MS = 1200;          // 实时闸门下限: 令牌变化时两帧之间的最小间隔
                                     // (真实节流阈值 = 本值 + 上一帧实测耗时, 见 prismPushTick)
var PUSH_TASK_ID = "prismPushTick";  // 定时任务名(重复注册防护用)
var PUSH_TASK_CODE = "$.global.PRISM_TICK()";  // 定时任务脚本串(经全局对象调用, 见文件末挂载)
var PUSH_SERVER = "127.0.0.1:8765";  // 服务端监听地址(固定本机)

/* 宿主侧会话状态只在 PS 会话内初始化一次。
   面板每次操作都会把本文件全文以字符串重新注入执行(见 index.js 的 execFunc),
   若这里每次直接赋值, 就会把正在运行的推送会话状态打回初始值, 宿主定时任务
   下一拍读到 PRISM_PUSH_ON=false 后立即停摆 —— 这是"折叠后推送断"的第二成因。
   加 typeof 守卫后, 状态在 PS 生命周期内持续有效。 */
if (typeof PRISM_PUSH_ON === "undefined") PRISM_PUSH_ON = false;   // 推送会话开关
if (typeof PRISM_PUSH_MODE === "undefined") PRISM_PUSH_MODE = "artboard";
/* ★默认视图 =「当前画板」(面板默认项): 有画板推活动图层所属画板、无画板自动退整画布,
   于是在拿到面板/外部参数之前被读到, 也不会推出"用户没选过的整画布"。
   "canvas" 依旧是合法入参(旧客户端、prismExternalPush 外部节拍), 只是不再作为默认值。 */
if (typeof PRISM_PUSH_SCALE === "undefined") PRISM_PUSH_SCALE = "1";
if (typeof PRISM_PUSH_LAST_KEY === "undefined") PRISM_PUSH_LAST_KEY = "";  // 最后已推送的画布令牌
if (typeof PRISM_PUSH_LAST_DOC === "undefined") PRISM_PUSH_LAST_DOC = "";  // 上次推送时的文档身份(id|名): 切文档要立即重推首帧
if (typeof PRISM_PUSH_LAST_AT === "undefined") PRISM_PUSH_LAST_AT = 0;     // 上次推送时间戳(毫秒)
if (typeof PRISM_PUSH_LAST_MSG === "undefined") PRISM_PUSH_LAST_MSG = "";  // 最近一次导出结果(面板诊断)
if (typeof PRISM_PUSH_TICKS === "undefined") PRISM_PUSH_TICKS = 0;          // 宿主巡检累计次数(面板自检用)
if (typeof PRISM_PUSH_LASTTICK === "undefined") PRISM_PUSH_LASTTICK = 0;   // 最近一次巡检时刻(毫秒)
if (typeof PRISM_PUSH_DRIVEN === "undefined") PRISM_PUSH_DRIVEN = "";      // 节拍来源: "host"(PS 调度器) | "panel"(面板驱动) | ""
if (typeof PRISM_PUSH_LASTBEAT === "undefined") PRISM_PUSH_LASTBEAT = 0;   // 最近一次刷 host.beat 的时刻(毫秒)
if (typeof PRISM_PUSH_FAILS === "undefined") PRISM_PUSH_FAILS = 0;         // 连续导出失败计数(失败退避 + 自动重试)
if (typeof PRISM_PUSH_LAST_COST === "undefined") PRISM_PUSH_LAST_COST = 0;  // 最近一次导出的实际耗时(毫秒)
if (typeof PRISM_PUSH_LASTBEATREQ === "undefined") PRISM_PUSH_LASTBEATREQ = 0; // 最近一次发心跳请求的时刻(毫秒)
if (typeof PRISM_PUSH_FORCE_MS === "undefined") PRISM_PUSH_FORCE_MS = 4000; // 兜底补帧间隔(自适应; 只用于令牌不变时的保活)
/* ★为什么兜底间隔必须是 5s 而不是 2s: 每推一帧 = 一次全尺寸导出 + 一次写盘 +
   一次复制, 全部在 PS 主线程同步执行。间隔压到 2s 会让大画布文档持续霸占
   主线程, 用户侧直接表现为"PS 卡死"。宁可跟随粗一点, 也不能卡住 PS。 */
if (typeof PRISM_PUSH_MANUAL === "undefined") PRISM_PUSH_MANUAL = false;   // 本帧是否用户手动推送
if (typeof PRISM_PUSH_AUTO === "undefined") PRISM_PUSH_AUTO = false;       // 本帧是否自动跟随
if (typeof PRISM_PUSH_OK_COUNT === "undefined") PRISM_PUSH_OK_COUNT = 0;   // 累计成功帧数(日志降频用)
/* 自动跟随的单边像素"安全阀"(不再是清晰度上限)。
   ★历史: 旧值 1080 的取舍是"手机端看个大概", 代价是预览明显发糊 —— 设计稿 2560px
     被压到 1080 再铺满 1080+ 的屏幕, 细节全丢。现改为: 跟随帧按设计稿原始像素 1:1
     导出, 只有画布长边超过本值才等比降采样, 用于挡住几万像素级的超大画布把
     PS 主线程与手机解码内存拖死。
   ★取值与服务端 FRAME_MAX_EDGE(4096) 必须一致: 服务端只做"安全阀"兜底, 正常帧
     来什么传什么; 若下游比本值小, 上游按原始尺寸出的帧仍会被截断, 只改一边等于白改。
   直导原文档的跟随帧由 SFW 输出缩放实现, 走副本的选区/画板跟随由副本 resize 实现,
   两条路都受本值约束。 */
if (typeof PUSH_MAX_AUTO_EDGE === "undefined") PUSH_MAX_AUTO_EDGE = 4096;   // 自动跟随帧单边安全阀(与服务端一致)
/* 跟随帧的 JPEG 编码质量(0-100)。95 = 视觉无损档: 文字/线条边缘不再出现可辨的
   JPEG 振铃, 同尺寸编码耗时仍远低于 PNG-24(<1s vs 3~6s), 所以清晰度可以放心给。
   现场网络吃紧、需要更快出帧时可下调到 90~92; 不建议低于 90(边缘会出现块效应)。 */
if (typeof PUSH_JPEG_QUALITY === "undefined") PUSH_JPEG_QUALITY = 95;       // 跟随帧 JPEG 质量(视觉无损档)

/* 极简 HTTP POST: 只服务本机 127.0.0.1:8765 的接口(心跳/下线/推送范围几何)。
   请求体固定 ASCII, Content-Length 即字符串长度; 写完后只读 1 字节
   (服务端会立刻回状态行)再关闭, timeout 兜底, 绝不长阻塞 PS 主线程。
   wantStatus=true 时多读几十字节并解析出状态码返回("200" / "" 表示失败),
   供调用方判断服务端是否真的收下了 —— 其余调用保持原样(有回包即视为成功)。 */
function prismHttpPost(path, body, wantStatus) {
    var sock = new Socket();
    try {
        try { sock.timeout = 0.5; } catch (eT) {}
        if (!sock.open(PUSH_SERVER, "TCP")) {
            try { sock.close(); } catch (e0) {}
            return false;
        }
        var payload = body || "{}";
        var req = "POST " + path + " HTTP/1.1\r\n" +
                  "Host: " + PUSH_SERVER + "\r\n" +
                  "Content-Type: application/json\r\n" +
                  "Content-Length: " + payload.length + "\r\n" +
                  "Connection: close\r\n\r\n" + payload;
        try { sock.write(req); } catch (eW) {}
        var st = "";
        try { st = sock.read(wantStatus ? 64 : 1); } catch (eR) {}
        try { sock.close(); } catch (eC) {}
        if (!wantStatus) return true;
        var m = /HTTP\/1\.[01]\s+(\d{3})/.exec("" + st);
        return m ? m[1] : "";
    } catch (e) {
        try { sock.close(); } catch (e2) {}
        return false;
    }
}

/* ---------- 推送范围几何上报: POST /api/view ----------
 * 作用: 告诉服务端"本帧要显示画布上的哪一块", 服务端收帧后用 Pillow 裁一刀再发布
 *       (mirror_server.py -> view_crop_frame)。这是"画板/选区裁剪"整条链路里 PS 侧的
 *       **全部**职责 —— PS 侧因此永远只导整画布: 不建副本、不切 activeDocument、
 *       不改文档结构, 跟随帧每帧都是零窗口动作(=零闪屏)。
 * 参数: mode = "canvas" | "artboard" | "selection"; cw/ch = 画布像素尺寸;
 *       rect = [l,t,r,b] 目标区域(画布坐标, px), 整画布传 null。
 * 返回: true = 服务端回 200(几何已生效); false = 没连上/没回 200。
 *       ★失败不抛错、不阻塞、不影响出帧: 服务端收不到几何就不裁(退回整画布)。
 *       ★canvas 模式也必须上报: 主动清零上一轮残留的矩形, 否则从"当前画板"切回
 *         "整个画布"后服务端会继续按旧矩形裁, 用户看到的就是"切不回整画布"。
 */
function prismViewReport(mode, cw, ch, rect) {
    var m = "" + (mode || "canvas");
    var body = "{\"mode\":\"" + m + "\",\"cw\":" + Math.round(cw || 0) +
               ",\"ch\":" + Math.round(ch || 0);
    if (m != "canvas" && rect && rect.length == 4) {
        body += ",\"rect\":[" + Math.round(rect[0]) + "," + Math.round(rect[1]) + "," +
                Math.round(rect[2]) + "," + Math.round(rect[3]) + "]";
    } else {
        body += ",\"rect\":null";
    }
    body += "}";
    var st = "";
    try { st = prismHttpPost("/api/view", body, true); } catch (e) { st = ""; }
    return (st === "200");
}

/* 文档身份 key: "id|名称"。切换活动文档时立刻变 —— ★必须带 id: 光看名称在
   "同名文档 / 另存为同名"下会漏判, 跟随就停在上一个文档的画面上。
   取不到 id(极旧版本)时退回名称, 不影响既有行为。 */
function prismDocKey() {
    try {
        var doc = app.activeDocument;
        if (!doc) return "";
        var id = "";
        try { id = "" + doc.id; } catch (eI) { id = ""; }
        if (!id || id === "undefined") return "" + doc.name;
        return id + "|" + doc.name;
    } catch (e) { return ""; }
}

/* 画布令牌 key: "文档身份#编辑序号#最近一步名"。切换活动文档、换画布(序号恰好相同)
   都会变化 —— 切文档因此天然带 keyChanged, 巡检与外节拍都会立即放行重推。 */
function prismTokenKey() {
    try {
        var doc = app.activeDocument;
        if (!doc) return "";
        var n = 0, last = "";
        try { n = doc.historyStates.length; } catch (eN) { n = 0; }
        /* 带上最近一步的名称: 历史步数被上限截断后, 这个名字仍能反映"换了操作",
           让令牌多一个变化维度(纯长度会在顶到上限后恒定不变)。 */
        try { if (n > 0) last = doc.historyStates[n - 1].name; } catch (eL) { last = ""; }
        return prismDocKey() + "#" + n + "#" + last;
    } catch (e) { return ""; }
}

/* 定时巡检: 心跳保活 + 令牌变化即推送一帧 */
function prismPushTick() {
    /* 先记数再看开关: 面板据此判断宿主定时任务是否真正在跑
       (旧版 4 参 scheduleTask 写法会让任务"注册成功但从不执行") */
    PRISM_PUSH_TICKS = PRISM_PUSH_TICKS + 1;
    var tickNow = (new Date()).getTime();
    PRISM_PUSH_LASTTICK = tickNow;
    /* 顺带按 2s 节流刷新宿主租约文件。面板驱动模式下没有调度任务刷它, 只靠面板
       的 /api/host-alive 保活; 这里补上文件源, 双源互备, 代价仅一次文件写。 */
    if (tickNow - PRISM_PUSH_LASTBEAT >= HOST_BEAT_MS) {
        PRISM_PUSH_LASTBEAT = tickNow;
        try { prismHostBeatTick(); } catch (eBeat) {}
    }
    /* 诊断流水: 每 10 拍落一条(1s 节拍 ≈ 每 10s 一条)写入 data\tick.log。
       事后按时间轴即可判断"面板折叠期间节拍是否断过" —— 这是本次问题的唯一判据。 */
    if (PRISM_PUSH_TICKS % 10 === 0) {
        prismDiagAppend("tick.log", prismDiagTime() + " tick=" + PRISM_PUSH_TICKS +
            " driven=" + ("" + PRISM_PUSH_DRIVEN) + " on=" + PRISM_PUSH_ON +
            (PRISM_PUSH_TICKS <= 10 ? (" build=" + prismBuildTag()) : ""));
    }
    if (!PRISM_PUSH_ON) return;
    /* 保活请求体保持纯 ASCII(不带中文文档名): Content-Length 按字节数算,
       中文会被服务端按 UTF-8 长度校验, 名字可能被截断; 文档名走"导出帧文件名"
       那条链路传给服务端即可。 */
    /* 心跳降到 5s 一次(服务端租约超时 10s, 5s 足够保活): 原先每拍 POST,
       1s 一条纯属给 PS 主线程叠无谓的网络阻塞。 */
    if (!PRISM_PUSH_LASTBEATREQ || tickNow - PRISM_PUSH_LASTBEATREQ >= 5000) {
        PRISM_PUSH_LASTBEATREQ = tickNow;
        prismHttpPost("/api/heartbeat", "{}");
    }
    var key = prismTokenKey();
    if (!key) return;                          // 没有打开的文档: 只保活, 不推送
    var now = (new Date()).getTime();
    if (PRISM_PUSH_LAST_KEY === "") {          // 首轮只记录基线
        PRISM_PUSH_LAST_KEY = key;
        PRISM_PUSH_LAST_DOC = prismDocKey();
        PRISM_PUSH_LAST_AT = now;
        return;
    }
    /* ★触发条件 = 令牌变化 OR 心跳兜底到期(且文档确实有未保存改动)。
       为什么必须有兜底: 令牌里的 historyStates.length 会被 PS 的历史记录上限
       截断(默认 50 步), 顶到上限后无论怎么画这个数都不再增长、令牌恒定 ——
       画面在变, 插件却认为"没变化", 现场表现就是"完全不更新"。所以令牌没变也
       每 PRISM_PUSH_FORCE_MS 重导一帧, 作为跟随不掉的保险。 */
    var keyChanged = (key !== PRISM_PUSH_LAST_KEY);
    /* ★文档切换独立检测(现场问题: 选「当前画板」时切文档, 手机端停在旧文档)。
       为什么要单独比一次而不是只靠 keyChanged: 令牌里混着 historyStates, 且"失败的
       帧不推进令牌基线"是刻意设计(失败要重试) —— 用一个显式的"上次巡检看到的文档
       身份"来比对, 才能保证"切了文档一定被判定为需要立即重推首帧"。
       取不到 id 时 prismDocKey 退回文档名, 仍可判别。 */
    var docNow = prismDocKey();
    var docChanged = (PRISM_PUSH_LAST_DOC !== "" && docNow !== "" && docNow !== PRISM_PUSH_LAST_DOC);
    PRISM_PUSH_LAST_DOC = docNow;
    var dirty = false;
    try { dirty = (app.activeDocument && app.activeDocument.saved === false); } catch (eD) { dirty = true; }
    var firstFrame = !PRISM_PUSH_LAST_AT;   // 会话首帧: 不受任何闸门限制
    var beatDue = (now - PRISM_PUSH_LAST_AT >= PRISM_PUSH_FORCE_MS) && dirty;
    if (!keyChanged && !beatDue && !firstFrame && !docChanged) return;
    /* ★两种闸门别混用, 混用就是"要么卡死、要么半天不刷":
       ① 令牌变化(画面真的变了) = 用户能感知的跟手度。要控的只是别把主线程压满,
          所以下限 = PUSH_MIN_GAP_MS + 上一帧实测耗时(帧越贵, 间隔自动越长)。
       ② 令牌没变但文档仍有未保存改动 = 历史步数被 50 步上限截断后的"令牌冻结",
          用自适应兜底间隔(上一帧耗时×3, 夹 4s~20s), 只为保活不掉帧。
       历史缺陷: 两条路曾共用同一个自适应间隔(初值 3s, ×2 递增, 夹 2.5s~20s), 于是
       "画一笔"也要等上一次退避后的间隔, 最长 20s 才出帧 —— 现场就是"延迟高、不跟手"。 */
    if (keyChanged) {
        /* ★占空比闸门(为什么不再用"最小间隔 + 耗时"): 旧式 gapReal = 1200 + cost 是加法,
           一帧 3s 就变成 4.2s 才允许下一帧, 用户侧就是"改一下要等好几秒"; 更糟的是每帧
           3s 的主线程占用本身就把 PS 卡住了。真正该控的是"主线程被导出占掉的比例":
           帧越贵, 间隔按它的 2 倍走(占用约 1/3), 帧越便宜间隔回落到 PUSH_MIN_GAP_MS。 */
        var gapReal = PRISM_PUSH_LAST_COST * 2;
        if (gapReal < PUSH_MIN_GAP_MS) gapReal = PUSH_MIN_GAP_MS;
        if (PRISM_PUSH_FAILS > 3) gapReal += 2000;        // 连续失败: 别继续踩油门
        /* ★切文档是用户明确动作、且新画面与上一个文档毫无关系: 这一次必须立刻出帧,
           不能再等 1~3s(旧行为下手机端就停在旧文档的画面上)。
           注意 docChanged 只对"真的换了文档"放行; 同一文档内的连续改动作照旧走闸门
           (失败重试也照旧受 PRISM_PUSH_FAILS 退避约束, 不会变成死循环)。 */
        if (!firstFrame && !docChanged && (now - PRISM_PUSH_LAST_AT < gapReal)) return;
    } else {
        /* 令牌冻结(历史步数顶到上限后恒定不变)时的保活补帧: 同样按上一帧耗时自适应,
           但夹到 3s~12s —— 旧的上界 20s 正是用户反馈的"延迟高"。 */
        var gapIdle = PUSH_MIN_GAP_MS + PRISM_PUSH_LAST_COST * 3;
        if (gapIdle < 3000) gapIdle = 3000;
        if (gapIdle > 12000) gapIdle = 12000;
        if (!firstFrame && (now - PRISM_PUSH_LAST_AT < gapIdle)) return;
    }
    PRISM_PUSH_LAST_AT = now;
    PRISM_PUSH_MANUAL = false;   // 自动跟随: 受节流与单边安全阀约束
    PRISM_PUSH_AUTO = true;
    var tickMsg = "";
    var costStart = (new Date()).getTime();
    try { tickMsg = prismPush(PRISM_PUSH_MODE, PRISM_PUSH_SCALE); }
    catch (eP) { tickMsg = "推送异常: " + eP; }
    PRISM_PUSH_LAST_COST = (new Date()).getTime() - costStart;
    /* ★自适应跟随间隔: 导出是同步跑在 PS 主线程上的, 文档越大越占时间。
       固定间隔重导(尤其全尺寸帧)会把主线程占满 —— 现场表现就是整机卡死。
       这里按上一帧实测耗时把"兜底补帧"的间隔拉到 3 倍(4s ~ 20s), 保证 PS 有充足
       空闲。注意只作用于兜底补帧; 真实变化走上面的实时闸门。 */
    var wantMs = PRISM_PUSH_LAST_COST * 3;
    if (wantMs < 4000) wantMs = 4000;
    if (wantMs > 20000) wantMs = 20000;
    PRISM_PUSH_FORCE_MS = wantMs;
    PRISM_PUSH_LAST_MSG = tickMsg;
    /* ★只有真的产出帧才推进令牌基线。失败时保留旧 key, 下一拍自动重试 ——
       否则一次导出失败就会被永久当成"这一拍已推过", 此后画面再变也不导出,
       表现为"开启推送后预览一动不动"。 */
    if (("" + tickMsg).indexOf('"ok":true') >= 0) {
        PRISM_PUSH_FAILS = 0;
        PRISM_PUSH_LAST_KEY = key;
    } else {
        PRISM_PUSH_FAILS = PRISM_PUSH_FAILS + 1;
        prismDiagAppend("export.log", prismDiagTime() + " FAIL#" + PRISM_PUSH_FAILS +
            " key=" + key + " msg=" + ("" + tickMsg).substring(0, 200));
    }
}

/* 面板驱动的巡检入口: 本机 PS 的 ExtendScript 没有 app.scheduleTask, 宿主无法
   自定时, 由面板按 PUSH_TICK_MS 节拍 evalScript 触发本函数, 心跳保活/令牌比对/
   导出仍全部在宿主侧完成。
   ★历史缺陷: index.js 一直在调 prismHostTick(), 而本文件从未定义该函数 —— 每一拍
   都在 JSX 侧抛 "prismHostTick is undefined"(被 $.global.PRISM_CALL 捕获成 ok:false),
   宿主巡检一次都没跑成, 面板日志才长期停在"宿主跟随未启动", 展开时面板自家轮询尚能
   兜底、一折叠就彻底不更新。这里补齐定义, 并返回可判定的结果供面板自检。 */
function prismHostTick() {
    try { prismPushTick(); }
    catch (e) { return jsonOut(false, "宿主巡检异常: " + e); }
    return jsonOut(true, "", {
        ticks: PRISM_PUSH_TICKS,
        driven: ("" + PRISM_PUSH_DRIVEN)
    });
}

/* 外部节拍入口: 由独立于 CEP 面板的进程(服务端 COM 节拍线程)调用。
   ★为什么需要它: 本机实测, CEP 面板一折叠, 面板页面级定时器与 Worker 一起停摆
   (manifest 的 CEF 反节流参数拦不住 CEP 对不可见面板的挂起), 而本机 PS 的
   ExtendScript 又没有 app.scheduleTask —— 节拍在 PS 内部没有任何可靠来源。
   唯一能脱离面板生命周期的节拍源在 PS 之外: 服务端通过 COM
   (Photoshop.Application 的 DoJavaScript) 在画布变化时驱动一次巡检。
   ★与 prismHostTick 的关键差异: PS 的 COM DoJavaScript 每次调用都跑在全新的脚本
   引擎里, $.global 与顶层变量不跨调用保留(实测: 赋值后下次调用读回 undefined)。
   因此调用方必须把"本文件全文 + 调用本函数"放在同一次 DoJavaScript 里。
   ★令牌比对: 内存状态跨调用不保留, 所以改成落盘复用(见下方 external_state.txt) ——
     服务端因此可以按较高频率注入, 而不会把每次注入都变成一次导出。
   参数 mode/scale 由服务端按面板最后一次的选择传入(会话内不保留)。 */
/* ---------- 外部节拍的状态落盘 ----------
 * DoJavaScript 每次调用都是一个全新的脚本引擎: 上一次注入建立的函数、令牌、
 * 节流基准全部不复存在。这意味着"画面有没有变"这一判断在跨调用之间天然失忆 ——
 * 服务端每 2~3s 注入一次, 每次都会被当成"变了"而重导一帧, 折叠期就变成固定频率的
 * 满负荷导出(大文档上直观表现为持续卡顿)。
 * 因此把令牌与上次导出时刻写进磁盘, 让下一次注入能读到。文件只有一行, 读写代价
 * 远小于一次导出。 */
var PRISM_EXT_STATE_FILE = new File(PRISM_HOME + "/external_state.txt");
var PRISM_EXT_MIN_GAP = 1200;      // 两次外部导出之间的最小间隔(毫秒): COM 每 3s 注入一次, 这层只管别叠帧
var PRISM_EXT_KEEPALIVE = 8000;    // 画面静止时最长不刷新时间(毫秒): 旧的 20s 是"折叠期要等 20s"的来源

function prismExtStateRead() {
    var out = { key: "", at: 0 };
    try {
        if (PRISM_EXT_STATE_FILE.exists) {
            PRISM_EXT_STATE_FILE.encoding = "UTF-8";
            if (PRISM_EXT_STATE_FILE.open("r")) {
                var t = "";
                try { t = PRISM_EXT_STATE_FILE.read(); } finally {
                    try { PRISM_EXT_STATE_FILE.close(); } catch (eC) {}
                }
                var parts = ("" + t).replace(/[\r\n]/g, "").split("\t");
                out.key = parts[0] || "";
                out.at = parseInt(parts[1] || "0", 10) || 0;
            }
        }
    } catch (e) {}
    return out;
}

function prismExtStateWrite(key, at) {
    try {
        prismEnsureDir(PRISM_HOME);
        PRISM_EXT_STATE_FILE.encoding = "UTF-8";
        if (PRISM_EXT_STATE_FILE.open("w")) {
            try { PRISM_EXT_STATE_FILE.write(("" + key) + "\t" + at); } finally {
                try { PRISM_EXT_STATE_FILE.close(); } catch (eC) {}
            }
        }
    } catch (e) {}
}

function prismExternalPush(mode, scale) {
    PRISM_PUSH_ON = true;
    PRISM_PUSH_DRIVEN = "external";    // 节拍来自 PS 之外的进程(仅用于诊断)
    /* ★对外契约保留: 服务端 COM 外部节拍(=折叠期接棒通道)会传入面板最后一次的 mode,
       其中完全可能是 "canvas"(旧版面板/旧会话), 这里必须原样接受, 不做白名单过滤;
       仅在 mode 为空时兜底到新的默认项「当前画板」。 */
    PRISM_PUSH_MODE = ("" + (mode || "artboard"));
    PRISM_PUSH_SCALE = ("" + (scale || "1"));
    /* ★无论这一拍推不推, 都必须先刷一次宿主心跳。服务端以 host.beat 租约为准判断
       "宿主还在不在", 折叠期若连着 20s 不落这个文件, 服务端会认定 PS 已退出而
       自行停服 —— 那比不刷新严重得多。 */
    try { prismHostBeatTick(); } catch (eB) {}
    var key = prismTokenKey();
    var now = (new Date()).getTime();
    var st = prismExtStateRead();
    /* ★去重: 画面未变就一次导出都不做(见上方 external_state.txt 的说明)。
       静止超过 PRISM_EXT_KEEPALIVE 后允许补一帧, 保证晚连上来的手机端能拿到当前画面。 */
    if (key && st.key === key) {
        if ((now - st.at) < PRISM_EXT_MIN_GAP) {
            return jsonOut(true, "external skip(节流)", { key: key, skipped: true });
        }
        if ((now - st.at) < PRISM_EXT_KEEPALIVE) {
            return jsonOut(true, "external skip(画面未变)", { key: key, skipped: true });
        }
    }
    /* 外部节拍属于自动跟随: 一律不建副本(否则每跟一帧闪屏两次), 与面板驱动同策略 */
    PRISM_PUSH_MANUAL = false;
    PRISM_PUSH_AUTO = true;
    var msg = "";
    try { msg = prismPush(PRISM_PUSH_MODE, PRISM_PUSH_SCALE); }
    catch (eP) { msg = "推送异常: " + eP; }
    PRISM_PUSH_LAST_MSG = msg;
    if (("" + msg).indexOf('"ok":true') >= 0) {
        prismExtStateWrite(key, now);
        return jsonOut(true, "external push", { key: key, last: ("" + msg).substring(0, 120) });
    }
    /* 失败不写状态: 下一拍自动重试(与 prismPushTick 的失败处理一致) */
    return jsonOut(false, "external push 失败", { key: key, last: ("" + msg).substring(0, 200) });
}

/* 开启(或更新参数)推送会话: 立即推一帧, 之后每 PUSH_TICK_MS 巡检一次。
   重复调用安全: 先撤销同名旧任务再注册, 不会叠加多个定时器。 */
function prismPushStart(mode, scale) {
    /* ★兜底默认 =「当前画板」(面板默认项): 只有 mode 为空/拿不到时才落到这里;
       显式传 "canvas"/"artboard"/"selection"/"auto" 一律原样沿用, 对外契约不变。 */
    PRISM_PUSH_MODE = ("" + (mode || "artboard"));
    PRISM_PUSH_SCALE = ("" + (scale || "1"));

    /* 先撤销旧任务(可能不存在, 异常忽略): 兼容不同 PS 版本的任务标识方式 */
    if (prismHasScheduler()) {
        try { app.cancelTask(PUSH_TASK_ID); } catch (e0) {}
        try { app.cancelTask(PUSH_TASK_CODE); } catch (e0b) {}
    }

    PRISM_PUSH_ON = true;              // 会话开关与"谁提供节拍"无关: 先无条件打开
    PRISM_PUSH_LAST_KEY = prismTokenKey();
    PRISM_PUSH_LAST_DOC = prismDocKey();   // 与令牌基线同时落: 开启后第一拍不会误判为"切了文档"
    PRISM_PUSH_LAST_AT = (new Date()).getTime();
    prismHttpPost("/api/heartbeat", "{}");     // 立刻保活: 手机端即时可见
    PRISM_PUSH_MANUAL = true;   // 用户手动推送: 按所选倍率原样出图, 不受跟随节流限制
    PRISM_PUSH_AUTO = false;    // 手动帧不降采样
    try { PRISM_PUSH_LAST_MSG = prismPush(PRISM_PUSH_MODE, PRISM_PUSH_SCALE); }
    catch (eP1) { PRISM_PUSH_LAST_MSG = "推送异常: " + eP1; }

    /* 主路径: 本机 PS 没有 app.scheduleTask(引用错误: 不是函数)。宿主无法自定时,
       但会话照常开启, 节拍交由面板按 PUSH_TICK_MS 调 prismHostTick() 驱动 ——
       功能等价, 只换节拍源, 不再让整条推送链路因缺调度器而判定失败。 */
    if (!prismHasScheduler()) {
        PRISM_PUSH_DRIVEN = "panel";
        /* 面板驱动模式下再挂一路"事件驱动"兜底: 用户在画布上操作时由 PS 的
           notifier 直接触发宿主巡检, 与面板是否可见、是否被挂起完全无关。 */
        try { prismInstallNotifier(); } catch (eNt1) {}
        try { prismPushTick(); } catch (eT1) {}
        return jsonOut(true, "push on (panel-driven)", {
            driven: "panel",
            mode: PRISM_PUSH_MODE,
            scale: PRISM_PUSH_SCALE,
            intervalMs: PUSH_TICK_MS
        });
    }

    PRISM_PUSH_DRIVEN = "host";
    /* 调度器可用也挂 notifier: 用户在画布上操作时立刻跟一帧, 无需等下一拍 */
    try { prismInstallNotifier(); } catch (eNt2) {}
    try {
        /* 官方签名: app.scheduleTask(task, delay, repeat) -> 返回任务 ID。
           必须先用这个: PS 上并没有 4 参重载 (taskID, task, delay, repeat),
           多出来的首参会让"脚本串"被当成 task, 于是任务虽注册成功、每次却只是
           求值一个标识符表达式, 永不真正执行 —— 这正是历史"宿主定时任务看似
           注册成功、实际从不运行、折叠后推送照样断"的成因。 */
        PUSH_TASK_ID = app.scheduleTask(PUSH_TASK_CODE, PUSH_TICK_MS, true);
    } catch (e1) {
        try {
            /* 少数版本才支持带任务名的 4 参签名, 作为兜底 */
            app.scheduleTask(PUSH_TASK_ID, PUSH_TASK_CODE, PUSH_TICK_MS, true);
        } catch (e2) {
            PRISM_PUSH_ON = false;
            return jsonOut(false, "推送定时任务注册失败: " + e2);
        }
    }
    /* 注册后立即走一拍巡检, 让"最近巡检时刻"从开关打开那一刻起就有效。
       否则面板的健康检查(每 2s 一次)会在任务首拍(1s 后)之前读到 agoMs=-1,
       误判"宿主跟随未响应"并重注册(cancelTask + scheduleTask), 首拍被再次推后
       1s —— 如此循环, 宿主跟随永远跑不起来, 面板只能退回 500ms 轮询兜底,
       表现为"无法实时跟随 + PS 卡顿闪烁"。 */
    try { prismPushTick(); } catch (eT0) {}

    return jsonOut(true, "push on", {
        driven: "host",
        mode: PRISM_PUSH_MODE,
        scale: PRISM_PUSH_SCALE,
        intervalMs: PUSH_TICK_MS
    });
}

/* 关闭推送会话: 撤销定时任务并立即通知服务端下线(手机端随即搜不到本机源) */
function prismPushStop() {
    PRISM_PUSH_ON = false;
    try { app.cancelTask(PUSH_TASK_ID); } catch (e0) {}
    try { app.cancelTask(PUSH_TASK_CODE); } catch (e0b) {}
    prismHttpPost("/api/deactivate", "{}");
    return jsonOut(true, "push off");
}

/* 查询推送会话状态: 面板(重新)打开时据此恢复按钮与下拉框 */
function prismPushState() {
    /* 面板每 2s 轮询一次本函数, 顺带保证"事件驱动跟随"一定挂上 */
    try { prismEnsureNotifier(); } catch (eN) {}
    return jsonOut(true, "", {
        on: PRISM_PUSH_ON,
        driven: ("" + PRISM_PUSH_DRIVEN),
        /* 有实测结论时以实测为准: typeof 探测在本机历史上给过假阴性 */
        hasScheduler: (PRISM_SCHED_OK === null ? prismHasScheduler() : PRISM_SCHED_OK),
        schedProbe: (PRISM_SCHED_OK === null ? "untested" : (PRISM_SCHED_OK ? "ok" : "dead")),
        ticks: PRISM_PUSH_TICKS,
        agoMs: (PRISM_PUSH_LASTTICK > 0 ? ((new Date()).getTime() - PRISM_PUSH_LASTTICK) : -1),
        taskId: ("" + PUSH_TASK_ID),
        tickMs: PUSH_TICK_MS,
        mode: PRISM_PUSH_MODE,
        scale: PRISM_PUSH_SCALE,
        /* 事件驱动(折叠期唯一不依赖面板可见性的通道)的注册情况:
           notifyOk = 已挂上的事件数(4 = 全挂上); 该值由 prismEnsureNotifier 维护 */
        notifyOk: PRISM_NOTIFY_OK_COUNT,
        notifyTotal: PRISM_NOTIFY_NAMES.length,
        last: ("" + PRISM_PUSH_LAST_MSG).substring(0, 160)
    });
}

/* ---------- 调度入口挂载到 ExtendScript 全局对象 ----------
   CEP 注入本文件时, 代码未必运行在全局作用域; 而 app.scheduleTask 的任务脚本
   是由 PS 调度器在【全局作用域】求值执行的。若任务脚本直接写 "prismPushTick()",
   全局作用域下很可能找不到该函数(它只存在于注入时那个作用域里), 于是任务虽然
   注册成功、却从不真正执行 —— 这是"折叠后不跟随"在 ExtendScript 侧的第二成因
   (第一个成因是 scheduleTask 误用 4 参重载)。
   把入口显式挂到 $.global 上, 无论注入作用域如何, 调度器都能稳定找到。 */
try {
    $.global.PRISM_TICK = function () { prismPushTick(); };
    $.global.PRISM_BEAT = function () { prismHostBeatTick(); };
    /* 面板驱动入口也挂到全局: 面板在"已全量注入"之后只发一行
       PRISM_CALL("$.global.PRISM_HOSTTICK()"), 经全局对象调用不依赖 eval 的
       闭包作用域, 与调度器侧的 PRISM_TICK 口径一致。 */
    $.global.PRISM_HOSTTICK = function () { return prismHostTick(); };
} catch (eG) {}
