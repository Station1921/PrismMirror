/* 棱镜 PS 插件面板逻辑
 *
 * 服务开关模型(推送会话常驻宿主侧):
 *   「推送预览」按钮 = 推送服务开关, 真正的推送会话跑在宿主(main.jsx)里,
 *   面板只做 UI。宿主会话不受面板折叠/关闭影响。
 *   开启: 立即导出当前画布一帧 -> 宿主每 1.5s 心跳保活 + 比对画布令牌
 *         ("文档名#编辑序号", 有改动自动重新导出) -> 实时跟随。
 *   关闭: 点「关闭推送」通知宿主撤销定时任务并调用 /api/deactivate,
 *         手机端随即搜不到本机源。
 *   退出 PS: 宿主调度器随进程消失, 心跳停 -> 服务端租约超时自行退出。
 *
 * 为什么推送不能留在面板里(历史 bug):
 *   面板是 Chromium 页面, 折叠/被遮挡/切标签后会被节流 setInterval,
 *   面板侧心跳与令牌轮询停摆 -> 服务端 10s 判定源离线 -> 一折叠推送就断。
 *   理想解是把保活与跟随整体下沉到 ExtendScript(app.scheduleTask, 与面板可见性无关),
 *   但本机 PS 的 ExtendScript 没有 app.scheduleTask, 宿主的定时器起不来, 节拍只能由
 *   CEP 侧提供 —— 于是改由 Web Worker 当节拍源: Worker 跑在独立线程, 不受页面可见性
 *   节流, 折叠后仍能唤醒主线程驱动宿主 prismHostTick()(见 startBeatWorker/tickFromPanel)。
 *
 * 关键设计: 不依赖 CEP ScriptPath 预加载 .jsx(改代码需重启 PS 才生效)，
 * 而是每次操作时读取最新 host/main.jsx 源码并以字符串注入执行，
 * 保证任何修改即时生效。
 *
 * 临时文件清理职责 (watch 目录, 面板本身不直接删文件, 只明确归属):
 *   - 导出/推送全在 host/main.jsx 内完成, 删除分三段, 互不重叠:
 *       · 成功帧 : 服务端 run_watch 读取发布后立即 unlink(插件不删, 避免抢删);
 *       · 失败半成品 + 导出前历史残片: main.jsx 侧清理
 *                 (prismPush 的 finally / clearWatchResidue);
 *       · 进程异常退出/崩溃遗留: 服务端在 启动 / 源离线 / 宿主退出 三个时机
 *                 调用 cleanup_watch_dir() 兜底清理, 并删除 host.beat。
 *   - 面板只负责拉起服务端与上报心跳(补充文档名), 不直接读写 watch 目录。
 */
(function () {
  "use strict";

  var cs = new CSInterface();
  var SERVICE = "http://127.0.0.1:8765";
  var EXT_ROOT = "";
  try { EXT_ROOT = cs.getSystemPath(SystemPath.EXTENSION); } catch (e) {}

  var BEAT_MS = 5000;        // 心跳间隔 (服务端 10s 超时)
  var HOST_ALIVE_MS = 3000;  // 宿主存活心跳间隔 (服务端宿主租约 10s 超时)
  /* 画布跟随通道(三态, 同一时刻只允许一条导出通道):
       ① 面板驱动(hostDriven="panel") = 本机 PS 没有 app.scheduleTask, 宿主不能
          自定时, 由面板按 FOLLOW_MS evalScript 触发宿主 prismHostTick(), 导出仍在
          宿主侧完成, 面板自己的轮询关掉;
       ② 宿主自调度(hostDriven="host") = 宿主调度器可用且 tick 在跑, 面板降到
          FOLLOW_IDLE_MS 当低频兜底;
       ③ 兜底 = 宿主会话起不来时, 面板按 FOLLOW_MS 常态轮询。
       (两通道同频导出会叠加成 PS 卡顿与画面闪烁, 故必须互斥。) */
  /* ★节拍密 ≠ 导出多: 面板这一拍只是让宿主比对一次令牌(一次 evalScript, 开销约
     一次函数调用), 真正贵的是"这一拍要不要真去导出一帧", 那一步已由宿主侧闸门
     控制(真实变化 1.2s 起, 兜底补帧 4s 起)。所以这里放心把节拍压密 —— 拍子越密,
     "画一笔多久刷出来"的跟手延迟越小, 而导出频率并不会因此上升。 */
  var FOLLOW_MS = 1500;          // 面板常态跟随间隔
  var FOLLOW_IDLE_MS = 1500;     // 宿主 tick 正常时面板的降频间隔
  var AUTO_PUSH_MIN = 800;       // 面板侧最小触发间隔(防连续笔画导致 evalScript 风暴)
  var AUTO_FOLLOW = true;    // 画布变动自动推送: 常量恒定 true, 界面不提供开关

  /* ---------- 推送范围(下拉)的两项契约 ----------
     「当前画板」已兼备整画布能力 —— 有画板推活动图层所属画板, 无画板的文档由宿主
     自动退整画布(见 main.jsx 的 abFallback), 因此面板不再单独暴露「整个画布」。
     ★宿主与服务端的 canvas 分支必须保留: 旧版客户端、以及 prismExternalPush 外部
       传参仍可能传 "canvas", 那条链路照旧整画布推送, 不得删改。
     默认项 = artboard(index.html 已 selected): 打开面板即推画板, 不留未选中/空值。 */
  var DEFAULT_MODE = "artboard";
  var PUSH_MODES = ["artboard", "selection"];

  /* 归一化推送范围: 下拉现在只有两项, 但 localStorage 里可能残留旧值("canvas"),
     原样回填会让 select 变成未选中(value=""), 后续推送就成了空 mode。
     所有取值处统一过这里 —— 不在白名单(含空值/取不到)一律落回默认「当前画板」。 */
  function normalizeMode(v) {
    v = (v === null || v === undefined) ? "" : ("" + v);
    for (var i = 0; i < PUSH_MODES.length; i++) { if (PUSH_MODES[i] === v) return v; }
    return DEFAULT_MODE;
  }

  /* 日志/诊断文案: canvas 分支保留(面板虽不再暴露该选项, 外部链路与旧会话仍可能出现) */
  function modeLabel(m) {
    if (m === "canvas") return "整个画布";
    if (m === "selection") return "当前选区";
    return "当前画板";
  }
  var HOST_TICK_FRESH_MS = 6000; // 宿主巡检时刻在这么久以内才算"活着"

  var pushBtn = document.getElementById("pushBtn");
  var connDot = document.getElementById("connDot");
  var connText = document.getElementById("connText");
  var svcAddr = document.getElementById("svcAddr");
  var ipVal = document.getElementById("ipVal");
  var lastInfo = document.getElementById("lastInfo");
  var docInfo = document.getElementById("docInfo");
  var logBox = document.getElementById("log");
  var previewName = document.getElementById("previewName");
  var previewImg = document.getElementById("previewImg");
  var previewPh = document.getElementById("previewPh");
  var previewPhTitle = document.getElementById("previewPhTitle");
  var previewPhNote = document.getElementById("previewPhNote");

  var lastSeq = -1;
  var lastToken = -1;
  var lastAutoPush = 0;
  var pushOn = false;      // 推送开关
  var curName = "";        // 最近一次导出的 PS 文档名(心跳上报给服务端)
  var exporting = false;   // 导出进行中
  var exportTimeout = null;   // 导出看门狗: 回调丢失时强制复位
  var EXPORT_TIMEOUT_MS = 8000;
  var hostTickLogged = false;  // 通道状态是否已提示(只报一次)
  var hostTickState = "";      // 上次判定的通道: "host"(宿主在跑) | "panel"
  var hostDriven = "";         // 宿主节拍来源: "host"(PS 调度器) | "panel"(面板驱动) | ""
  var hostDriveTimer = null;   // 面板驱动定时器(仅 hostDriven="panel" 时运行)
  var hostDriveLogged = false; // "无宿主调度器, 改由面板驱动"是否已提示(只报一次)
  var driveFail = 0;           // 面板驱动宿主巡检的连续失败次数(自检用)
  var tickWorker = null;       // 节拍 Worker: 抗折叠的主节拍源(见 startBeatWorker)
  var lastPanelTick = 0;       // 上一次真正下发节拍的时刻(两路节拍共用节流窗口)
  var panelTicks = 0;          // 面板侧已下发的节拍数(自检/诊断用)
  var TICK_MIN_GAP_MS = 1500;   // 两拍之间的最小间隔
  var lastPanelBeatAt = 0;     // 面板节拍上报服务端的节流基准(见 reportPanelBeat)
  var previewLoader = null;    // 预览双缓冲用的离屏预加载器(见 refreshPreview)
  var curFollowMs = 0;         // 当前面板跟随间隔(0 = 未开启跟随)
  var lastEnsureAt = 0;    // 上次尝试自动拉起服务端的时间(冷却重试, 不再只试一次)
  var ENSURE_COOLDOWN = 8000;
  var beatTimer = null;
  var followTimer = null;
  var hostAliveTimer = null;

  function log(msg, cls) {
    var d = new Date();
    var t = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    logBox.innerHTML = '<span class="' + (cls || "") + '">[' + t + "] " + msg + "</span>\n" + logBox.innerHTML;
  }

  /* 读取 host/main.jsx 全文 */
  function readMainJsx() {
    var p = EXT_ROOT + "/host/main.jsx";
    try {
      var res = cep.fs.readFile(p);
      if (res && res.err === 0 && res.data) {
        return res.data.replace(/^#target[^\n]*\n?/m, "");
      }
      log("读取脚本失败: " + (res && res.err), "err");
    } catch (e) {
      log("读取脚本异常: " + e, "err");
    }
    return null;
  }

  /* 注入并执行 main.jsx 中定义的函数。
     main.jsx 全文 36KB, 旧实现每次调用都重新注入全文 —— 画布跟随 500ms 一次,
     等于每 500ms 让 CEP 往 PS 传 36KB 并让 ExtendScript 重新解析执行整个脚本,
     CEP 与 PS 双方都被拖住, 这正是"面板启动推送就卡"的主因。
     现改为两级:
       ① 首次(面板加载 / PS 刚重启): 全量注入一次, 并把统一入口挂到
          $.global.PRISM_CALL —— 它与 main.jsx 的函数、状态同处一个作用域,
          因此后续调用共享同一份状态(与调度器用的 $.global.PRISM_TICK 一致)。
       ② 之后: 只发一行 $.global.PRISM_CALL("fnCall"), 单次注入从 36KB 降到
          几十字节, 不再重复解析脚本、也不再重置任何宿主状态。
     若 PS 重启导致入口丢失(返回 EvalScript error / undefined), 自动回退全量注入一次。 */
  var FULL_INJECTED = false;

  function injectFull(fnCall, cb) {
    var code = readMainJsx();
    if (!code) { if (cb) cb("读取 main.jsx 失败"); return; }
    var script =
      /* 把运行时确定的扩展目录喂给 main.jsx: 数据/服务端路径全部由它派生,
         避免任何写死的绝对路径(Windows 反斜杠由 JSON.stringify 正确转义)。 */
      "var PRISM_EXT_ROOT = " + JSON.stringify(EXT_ROOT || "") + ";\n" +
      code + "\n" +
      "$.global.PRISM_CALL = function (__src) {\n" +
      "  try { return ('' + eval(__src)); }\n" +
      "  catch (e) {\n" +
      "    var __e = (e && e.line ? 'JSX异常@行' + e.line + ': ' + (e.message || e) : 'JSX异常: ' + (e && e.message || e));\n" +
      "    return jsxJson({ok:false, msg:__e});\n" +
      "  }\n" +
      "};\n" +
      "$.global.PRISM_CALL(" + JSON.stringify(fnCall) + ");";
    cs.evalScript(script, function (res) {
      FULL_INJECTED = true;
      if (cb) cb(res);
    });
  }

  function execFunc(fnCall, cb) {
    if (!FULL_INJECTED) { injectFull(fnCall, cb); return; }
    cs.evalScript("$.global.PRISM_CALL(" + JSON.stringify(fnCall) + ");", function (res) {
      var r = (res === null || res === undefined) ? "" : ("" + res);
      /* 入口丢失(PS 重启 / 面板重载)或返回空才回退全量注入。
         注意: 不再把 "undefined" 当失败 —— main.jsx 里大半函数(prismPushTick 等)
         本就没有返回值, 回调收到的就是字符串 "undefined"。旧写法会把每一次正常调用
         误判成"入口丢失"并重新注入 36KB 全文, 面板驱动模式下等于每 1s 重解析一遍
         宿主脚本, 既拖慢 PS 又把两级注入优化完全废掉。 */
      if (r === "" || r.indexOf("EvalScript error") === 0 || r.indexOf("is not a function") >= 0) {
        FULL_INJECTED = false;
        injectFull(fnCall, cb);
        return;
      }
      if (cb) cb(res);
    });
  }

  /* 预览图刷新: seq 变化时更新文件名与图片(带时间戳防缓存)。
     双缓冲 —— 旧帧一直留在页面上, 新帧先在离屏 Image 里解码完成, 再替换 src。
     旧实现每帧先 showPreviewLoading()(摘掉 src + 露出"加载中"占位)再挂新图,
     跟随期间每秒推一帧就变成"画面每秒闪一下"; 现在只在首帧到达时经过占位。 */
  function refreshPreview(s) {
    if (!s || !previewImg) return;
    if (s.seq === lastSeq) return;
    lastSeq = s.seq;
    if (s.name && previewName) previewName.textContent = s.name;
    var url = SERVICE + "/latest?ts=" + s.ts + "&seq=" + s.seq;
    if (!previewLoader) {
      previewLoader = new Image();
      previewLoader.onerror = function () { /* 单帧失败保留旧画面, 不清空 */ };
    }
    previewLoader.onload = function () {
      previewImg.src = url;   // 与预加载同一 URL, 命中缓存即时渲染
      previewImg.classList.add("ready");
      if (previewPh) { previewPh.style.display = "none"; previewPh.classList.remove("is-loading"); }
    };
    previewLoader.src = url;
  }

  /* ---------- 预览区状态机 (彻底消除 broken image) ----------
     三个状态互斥, 全部只操作 CSS 类与 src, 不引入其它副作用:
       空态   : img 摘除 src + 去掉 .ready (CSS 默认 display:none) -> 只显示 .preview-ph 占位
       加载态 : 同样摘除 src + 隐藏, 待新帧 onload 成功才显示, 中途不露破图
       成功态 : onload 回调里加 .ready 显示 img 并隐藏占位
     onerror 覆盖: 404 / 解码失败 / 断源清空 等所有失败路径。 */
  function setPreviewPlaceholder(title, note) {
    if (!previewPh) return;
    previewPh.style.display = "flex";
    if (previewPhTitle) previewPhTitle.textContent = title;
    if (previewPhNote) previewPhNote.textContent = note;
  }

  /* 预览区空态: 未推送 / 服务未运行 / 源离线 / 图片 URL 无效 / 解码失败 */
  function showPreviewEmpty() {
    if (!previewImg) return;
    previewImg.classList.remove("ready");
    previewImg.removeAttribute("src");   // 摘掉 src: 元素不再参与图片渲染, 不会出现默认破图图标
    previewPh && previewPh.classList.remove("is-loading");
    setPreviewPlaceholder("暂无画面", "开启推送后此处实时显示画布");
    if (previewName) previewName.textContent = "--";
  }

  /* 预览区加载态: 隐藏旧图并挂起, 直到 load 成功才显示 */
  function showPreviewLoading() {
    if (previewImg) {
      previewImg.classList.remove("ready");
      previewImg.removeAttribute("src");
    }
    previewPh && previewPh.classList.add("is-loading");
    setPreviewPlaceholder("加载中…", "正在获取最新画布预览");
  }

  /* 预览区成功态: 仅在 onload 之后调用 */
  function showPreviewImage() {
    if (previewImg) previewImg.classList.add("ready");
    if (previewPh) previewPh.style.display = "none";
  }

  if (previewImg) {
    previewImg.onload = function () { showPreviewImage(); };
    previewImg.onerror = function () { showPreviewEmpty(); };
  }
  showPreviewEmpty();   // 面板初始即为干净占位, 不含任何 src

  /* 自动拉起服务端: 带冷却的持续重试。
     旧实现只尝试一次且仅等 2.5s, 若 python 启动稍慢就永久显示"服务未启动"。
     传 1 跳过 ExtendScript 侧的 Socket 探测: 面板已用 fetch 确认服务不在线,
     直接启动更可靠 (Socket.open 在未连接时可能误报已连通, 导致永不拉起)。 */
  function ensureServer() {
    var now = Date.now();
    if (now - lastEnsureAt < ENSURE_COOLDOWN) return;
    lastEnsureAt = now;
    log("服务端未运行, 正在自动启动...", "");
    execFunc("prismEnsureServer(1)", function (res) {
      log("自动启动结果: " + (res || "无返回"), "");
    });
  }

  /* 显式登记"推送开关已打开"。
     服务端据此把"源在线"与面板心跳解耦: 面板折叠后 CEP 面板的 JS 会停摆、
     心跳随之停发, 但用户并没有关闭推送 —— 只要 PS 还在, 源就该一直在线,
     手机端不该显示"电脑端已停止推送"。 */
  function enablePushOnServer() {
    fetch(SERVICE + "/api/push-enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).catch(function () {});
  }

  /* 把推送会话下沉到宿主(PS 进程内的 ExtendScript 定时任务)。
     面板是 Chromium 页面, 一旦折叠/被遮挡就会停掉 setInterval, 只靠面板侧的
     心跳 + 跟随必然"一折叠就断"; 宿主定时任务由 PS 主进程调度, 与面板可见性
     无关, 折叠后仍按 1.5s 巡检保活并跟随画布。面板侧逻辑保留作为可见时的
     快速通道, 两者并行不冲突(重复注册有 cancelTask 兜底, 不会叠加)。 */
  function startHostSession() {
    var mode = normalizeMode(document.getElementById("mode").value);
    var scale = document.getElementById("scale").value;
    execFunc("prismPushStart('" + mode + "', " + scale + ")", function (res) {
      var j = null;
      try { j = JSON.parse(res); } catch (e) {}
      if (j && j.ok) {
        if (j.driven === "panel") {
          hostDriven = "panel";
          startHostDrive();     // 宿主不能自定时: 由面板按节拍驱动宿主 tick
          if (!hostDriveLogged) {
            hostDriveLogged = true;
            log("本机 PS 无宿主调度器(app.scheduleTask 不可用), 由面板驱动宿主跟随(每 " + (j.intervalMs || FOLLOW_MS) + "ms)", "");
          }
        } else {
          hostDriven = "host";
          stopHostDrive();
          log("宿主跟随任务已注册, 每 " + (j.intervalMs || 0) + "ms 巡检", "");
        }
      } else {
        /* 宿主会话彻底起不来(如脚本注入失败): 面板侧常态跟随仍能覆盖 */
        log("宿主跟随任务不可用(" + ((j && j.msg) || "无返回") + "), 由面板跟随", "");
      }
    });
  }

  /* ---------- 面板驱动宿主跟随 ----------
     本机 PS 的 ExtendScript 没有 app.scheduleTask(日志: "app.scheduleTask 不是
     函数"), 宿主无法自定时。此时不再把宿主会话判为失败, 而是由面板按同一个节拍
     evalScript 触发宿主 prismHostTick() —— 心跳保活、令牌比对、导出仍全部在宿主
     侧完成, 面板只提供节拍源; 同时关掉面板自己的 autoFollowCheck, 保证同一时刻
     只有一条导出通道(两条通道同频导出会叠加成 PS 卡顿与画面闪烁)。
     代价: 面板被 CEP 真正销毁(非折叠)时失去节拍源, 跟随随之中断, 需重开面板。 */
  function startHostDrive() {
    stopFollow();
    /* 主节拍源 = Web Worker。窗口 setInterval 一折叠就停(见 startBeatWorker),
       必须由 Worker 提供节拍, 否则折叠即断流。 */
    startBeatWorker();
    if (!hostDriveTimer) {
      hostDriveTimer = setInterval(function () { tickFromPanel("window"); }, FOLLOW_MS);
    }
  }
  function stopHostDrive() {
    if (hostDriveTimer) { clearInterval(hostDriveTimer); hostDriveTimer = null; }
    stopBeatWorker();
    driveFail = 0;
  }

  /* 单拍: 驱动宿主 prismHostTick()(心跳保活 / 令牌比对 / 导出 全在宿主侧完成)。
     Worker 与窗口定时器共用本函数与同一节流窗口(TICK_MIN_GAP_MS), 因此两路
     同时在跑时也只会有一拍生效, 不会叠加成双通道导出(那会表现为卡顿+闪烁)。 */
  function tickFromPanel(src) {
    if (!pushOn || hostDriven !== "panel") return;
    var now = Date.now();
    if (now - lastPanelTick < TICK_MIN_GAP_MS) return;
    lastPanelTick = now;
    panelTicks++;
    /* 经 $.global 入口调用(与调度器侧 PRISM_TICK 同口径); main.jsx 的
       prismHostTick() 回 {ok,ticks} 供这里自检, 连续失败才报一次, 不刷屏。 */
    execFunc("$.global.PRISM_HOSTTICK()", function (res) {
      var r = (res === null || res === undefined) ? "" : ("" + res);
      if (r.indexOf('"ok":true') >= 0) { driveFail = 0; reportPanelBeat(); return; }
      driveFail++;
      if (driveFail === 3) log("宿主巡检调用失败(" + src + "): " + r.substring(0, 140), "err");
    });
  }

  /* 面板节拍上报: 服务端据此判断"面板侧节拍源是否活着"—— 超过 6s 没收到,
     就认定面板连同 Worker 一起停摆, 由服务端自己的 COM 节拍线程接管。
     这条上报同时就是折叠检测器: 折叠时它自然中断, 无需任何可见性事件。
     只在宿主巡检真的执行成功后才上报, 因此也不会把"节拍在跑但全拍失败"误报成健康。 */
  function reportPanelBeat() {
    var now = Date.now();
    if (now - lastPanelBeatAt < 3000) return;
    lastPanelBeatAt = now;
    /* 顺带上报面板当前的导出参数: 折叠后由服务端的 COM 节拍沿用同一套参数,
       避免切回手机端时视图(画布/选区/倍率)突然变化。 */
    var body = "{}";
    try {
      var mEl = document.getElementById("mode");
      var sEl = document.getElementById("scale");
      var mode = normalizeMode(mEl ? mEl.value : DEFAULT_MODE);
      var scale = sEl ? parseFloat(sEl.value) : 1;
      if (!(scale > 0)) scale = 1;
      body = JSON.stringify({ mode: mode, scale: scale });
    } catch (e) {}
    try { fetch(SERVICE + "/api/panel-beat", { method: "POST", body: body }); } catch (e) {}
  }

  /* 节拍 Worker —— "一折叠就不再实时更新"的根治点。
     本机 PS 的 ExtendScript 没有 app.scheduleTask, 宿主无法自定时, 节拍只能由面板
     提供; 而 CEP 面板一折叠, 页面级 setInterval 就停摆(manifest 里四个 CEF 反节流
     参数也拦不住 CEP 对不可见面板的挂起) —— 节拍一停, 心跳保活、令牌比对、导出
     全断, 手机端就停在旧帧。web Worker 跑在独立线程, Chromium 的后台节流只作用于
     页面级 timer, Worker 定时器照常触发; 它 postMessage 唤醒主线程下发同一拍。
     Worker 用 Blob URL 内联(file:// 下 new Worker(相对路径) 会被同源策略拦掉),
     不新增文件、不依赖打包。顺带让 Worker 每 3 拍自己 POST /api/host-alive:
     即使主线程整块停摆, 服务端也不会把本机源判离线。 */
  function startBeatWorker() {
    if (tickWorker) return;
    var src =
      "var n = 0;\n" +
      "setInterval(function () {\n" +
      "  n++;\n" +
      "  postMessage(n);\n" +
      "  if (n % 3 === 0) { try { fetch('" + SERVICE + "/api/host-alive', { method: 'POST', body: '{}' }); } catch (e) {} }\n" +
      "}, 1000);\n";
    try {
      var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      var w = new Worker(url);
      w.onmessage = function () { tickFromPanel("worker"); };
      w.onerror = function () { log("节拍 Worker 异常, 已退回窗口定时器(折叠会停)", "err"); };
      tickWorker = w;
      log("节拍源: Worker(抗折叠) + 窗口定时器", "");
    } catch (e) {
      tickWorker = null;
      log("节拍 Worker 不可用(" + e + "), 仅窗口定时器(折叠会停)", "err");
    }
  }
  function stopBeatWorker() {
    if (tickWorker) { try { tickWorker.terminate(); } catch (e) {} tickWorker = null; }
    lastPanelTick = 0;
  }

  /* 等待服务端就绪后启动推送: 未就绪则自动拉起并重试, 超时给出提示。
     先确保服务在线再导出, 避免服务未运行时导出文件残留在 watch 目录。 */
  function startWhenServiceReady(tries) {
    if (!pushOn) return;
    fetch(SERVICE + "/api/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function () {
        connDot.className = "dot on";
        connText.textContent = "服务在线";
        enablePushOnServer();   // 显式登记推送开关: 折叠面板不再导致源掉线
        startBeats();
        startFollow();
        startHostSession();     // 推送会话同步下沉宿主, 折叠面板后仍持续推送
        saveState();
        /* 首帧立即导出; 之后的画布变动由面板侧 followTimer 检测并自动重推
           (manifest 已关闭 CEF 后台节流, 折叠后依然运行) */
        doPush(true);
        /* 调度器能力实测: 800ms 后由 probe 写标记文件, 1.8s 后回读。
           历史上是"typeof app.scheduleTask 不是函数"一句话把整条链路判成无调度器,
           但 ExtendScript 对内建方法的类型探测并不可靠。这里以"标记文件是否真的
           出现"为准; 一旦可用, 宿主会立刻按原参数把会话重启为自调度(节拍回到 PS
           进程内), 折叠与推送从此完全无关, 无需用户做任何操作。 */
        execFunc("prismSchedProbe()", function () {});
        setTimeout(function () {
          execFunc("prismSchedProbeCheck()", function (res) {
            var ok = /"schedulerOk"\s*:\s*true/.test("" + res);
            log("调度器实测: " + (ok ? "可用 → 已切回宿主自调度" : "不可用 → 维持面板驱动"), ok ? "ok" : "");
          });
        }, 1800);
        setTimeout(function () { pollStatus(); }, 900);
      })
      .catch(function () {
        if (!pushOn) return;
        if (tries <= 0) {
          log("推送服务启动超时, 请检查 Python 环境", "err");
          log("推送服务启动失败, 请点击「关闭推送」后重试", "err");
          return;
        }
        ensureServer();
        setTimeout(function () { startWhenServiceReady(tries - 1); }, 500);
      });
  }

  function pollStatus() {
    fetch(SERVICE + "/api/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        connDot.className = "dot on";
        connText.textContent = "服务在线";
        svcAddr.textContent = SERVICE + "  seq=" + s.seq;
        if (s.ip && ipVal) ipVal.textContent = s.ip + ":" + s.port;
        if (s.active) {
          docInfo.textContent = "源在线 · " + (s.active_name || s.name || "PS 插件");
          refreshPreview(s);
          hostTickWatch();   // 宿主跟随健康检查
        } else {
          // 源离线(PS 已关闭/推送已停): 立即清空预览, 不残留上一帧
          docInfo.textContent = "服务已开启·未推送预览";
          showPreviewEmpty();
        }
      })
      .catch(function () {
        connDot.className = "dot err";
        var starting = (lastEnsureAt > 0 && Date.now() - lastEnsureAt < 15000);
        connText.textContent = starting ? "正在启动服务..." : "服务未启动";
        svcAddr.textContent = SERVICE + " (未连接)";
        if (ipVal) ipVal.textContent = "--";
        // 服务未运行: 预览区回到干净占位, 不留任何无效图片元素
        showPreviewEmpty();
        // 服务端不在运行: 冷却重试自动拉起 (ExtendScript 异步启动 pythonw, 不阻塞面板)
        ensureServer();
      });
  }

  function readActiveDoc() {
    execFunc("prismDocInfo()", function (res) {
      try {
        var j = JSON.parse(res);
        if (j.ok) {
          docInfo.textContent = j.name + "  " + j.width + "×" + j.height + (j.hasSelection ? "  (含选区)" : "");
          curName = j.name || curName;
        } else {
          log("docInfo: " + (j.msg || res), "err");
        }
      } catch (e) {
        log("docInfo 返回异常: " + res, "err");
      }
    });
  }

  /* 心跳: 推送开启期间每 5s 上报, 服务端视为活跃源 */
  function heartbeat() {
    fetch(SERVICE + "/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: curName })
    }).catch(function () {});
  }

  function startBeats() {
    stopBeats();
    heartbeat();
    beatTimer = setInterval(heartbeat, BEAT_MS);
  }
  function stopBeats() {
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  }

  /* ---------- 推送会话(面板侧常驻) ----------
     面板折叠后 Chromium 会节流后台页面的 setInterval, 这正是历史"一折叠推送
     就断"的根因。manifest.xml 已通过 CEFCommandLine 关闭该节流
     (--disable-background-timer-throttling / --disable-backgrounding-occluded-windows
      / --disable-renderer-backgrounding), 面板折叠后仍按原频率运行, 所以推送
     现状是双通道: 常态跟随由宿主(main.jsx)的定时任务负责 —— 由 PS 主进程调度,
     与面板可见性无关; 面板侧轮询只在宿主跟随确实跑不起来时兜底。两条通道同时
     导出会互相叠加(表现为 PS 卡顿 + 画面闪烁), 所以宿主健康时面板主动停轮询,
     见 hostTickWatch。
     面板状态另写 localStorage: 面板若被 CEP 销毁后重开, 自动按上次状态续推。 */
  var LS_KEY = "prism.push.state";

  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        on: pushOn,
        mode: normalizeMode(document.getElementById("mode").value),
        scale: document.getElementById("scale").value
      }));
    } catch (e) {}
  }

  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      return (s && typeof s === "object") ? s : null;
    } catch (e) { return null; }
  }

  /* 画布跟随(面板侧): 轮询画布令牌, 有改动自动导出重推。
     宿主 tick 健康时只降频, 不整体停掉 —— 宿主任务随时可能被 PS 静默取消,
     停掉后就再也没有通道在跟随了。 */
  function startFollow() {
    autoFollowCheck();
    setFollowMs(FOLLOW_MS);
  }
  function setFollowMs(ms) {
    if (followTimer && curFollowMs === ms) return;
    curFollowMs = ms;
    if (followTimer) clearInterval(followTimer);
    followTimer = setInterval(autoFollowCheck, ms);
  }
  function stopFollow() {
    if (followTimer) { clearInterval(followTimer); followTimer = null; }
    curFollowMs = 0;
  }

  /* 跟随通道仲裁: 宿主 tick 是否真的在跑。
     本机实测 app.scheduleTask 根本不存在(引用错误: app.scheduleTask 不是函数),
     宿主无法自调度, 此时由 startHostDrive 提供节拍(hostDriven="panel"), tick 数
     随面板节拍增长 —— 判定与动作:
       · hostDriven="panel" -> 宿主 tick 由面板驱动运行, 面板停掉自己的轮询;
       · 最近一次巡检在 HOST_TICK_FRESH_MS 内 -> 宿主活着, 面板降频兜底;
       · 否则 -> 面板按 FOLLOW_MS 常态跟随。
     不再重注册宿主任务: 注册失败时重注册只会把首拍一次次推后(永远等不到第一
     拍), 白刷一条红字日志且问题依旧 —— 这正是历史日志里"宿主跟随未响应
     (已巡检 0 次), 重新注册跟随任务"的来源。 */
  /* 面板侧诊断落盘: 折叠时面板日志区会整段停摆(看不到也留不下证据), 关键判定交给
     宿主代写 <ext>\data\panel.log, 展开后可事后核对折叠期间到底断在哪一环。 */
  function panelDiag(msg) {
    execFunc("prismPanelDiag(" + JSON.stringify(msg) + ")", function () {});
  }

  function hostTickWatch() {
    if (!pushOn) return;
    execFunc("prismPushState()", function (res) {
      var j = null;
      try { j = JSON.parse(res); } catch (e) { return; }
      if (!j || !j.ok) return;
      var ago = (typeof j.agoMs === "number" ? j.agoMs : -1);
      var healthy = (!!j.on && ago >= 0 && ago < HOST_TICK_FRESH_MS);
      var state = healthy ? "host" : "panel";
      if (state !== hostTickState) {   // 通道切换只报一次, 不刷屏
        hostTickState = state;
        panelDiag("state=" + state + " driven=" + (hostDriven || "-") + " agoMs=" + ago +
                  " hostTicks=" + (j.ticks || 0) + " panelTicks=" + panelTicks +
                  " sched=" + (j.hasScheduler ? 1 : 0));
        if (healthy) {
          if (hostDriven === "panel") {
            log("宿主跟随正常 (面板驱动, 已巡检 " + (j.ticks || 0) + " 次, 面板下发 " + panelTicks + " 拍)", "ok");
          } else {
            log("宿主跟随正常 (已巡检 " + (j.ticks || 0) + " 次), 面板降为低频兜底", "ok");
          }
        } else {
          log("宿主跟随未启动, 由面板跟随(每 " + FOLLOW_MS + "ms)", "");
        }
      }
      /* 面板驱动模式: 跟随导出由宿主 tick 完成, 面板只供节拍, 不再开自己的轮询
         (否则面板 1s 轮询 + 宿主 1s tick 两条通道叠加, 就是历史上的卡顿+闪烁) */
      if (hostDriven === "panel") { stopFollow(); return; }
      setFollowMs(healthy ? FOLLOW_IDLE_MS : FOLLOW_MS);
    });
  }

  /* ---------- 宿主存活心跳(双源保活) ----------
     服务端以"PS 是宿主"为前提: 宿主不在, 服务端应随之退出。
     主源: main.jsx 在 PS 进程内每 2s 刷新 host.beat(PS 退出即自然停更);
     辅源: 本面板存活期间每 3s POST /api/host-alive(面板随 PS 一起关闭)。
     两路任一存活即保活; 都停止后服务端在 HOST_TIMEOUT 左右自行退出并停发 beacon。 */
  function startHostBeat() {
    execFunc("prismStartHostBeat()", function (res) {
      log("宿主心跳任务: " + (res || "无返回"), "");
    });
  }

  function hostAlive() {
    fetch(SERVICE + "/api/host-alive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).catch(function () {});
  }

  function startHostAlive() {
    if (hostAliveTimer) clearInterval(hostAliveTimer);
    hostAlive();
    hostAliveTimer = setInterval(hostAlive, HOST_ALIVE_MS);
  }

  /* 自动跟随: 轮询画布令牌, 有改动自动导出 */
  function autoFollowCheck() {
    if (!pushOn || exporting) return;
    execFunc("prismToken()", function (res) {
      try {
        var j = JSON.parse(res);
        if (!j || !j.ok) return;
        if (j.name) curName = j.name;
        var now = Date.now();
        // 令牌 = 文档名 + 编辑序号: 切换活动画布(即使序号恰好相同)也会触发重推
        var key = (j.name || "?") + "#" + j.token;
        if (lastToken === -1) { lastToken = key; return; }
        if (key !== lastToken && now - lastAutoPush >= AUTO_PUSH_MIN) {
          lastToken = key;
          lastAutoPush = now;
          log("检测到画布变更, 自动推送", "");
          doPush(true);
        }
        // 节流窗口未到时不再把令牌"吞掉": lastToken 始终表示"最后一次已推送的令牌",
        // 下一轮(FOLLOW_MS 后)窗口一旦满足即补推最新画面(尾沿防抖), 避免窗口内最后一次
        // 改动被丢弃导致手机端一直停在旧帧。key 去重仍在, 不会重复导出同一帧。
      } catch (e) {}
    });
  }

  /* 导出并推送一帧 (silent=true 时为自动跟随触发, 不重设 lastToken) */
  function doPush(silent) {
    if (exporting) return;
    var mode = normalizeMode(document.getElementById("mode").value);
    var scale = document.getElementById("scale").value;
    exporting = true;
    /* 看门狗: 面板折叠/被遮挡时 execFunc 的回调可能丢失,
       若不强制复位, exporting 会永久为 true, 之后所有
       自动跟随都被 doPush 开头拦掉, 表现为"面板展开也不再跟随"。 */
    if (exportTimeout) clearTimeout(exportTimeout);
    exportTimeout = setTimeout(function () {
      if (exporting) {
        exporting = false;
        if (!silent) { pushBtn.disabled = false; pushBtn.classList.remove("busy"); }
        log("导出超时(回调未返回), 已复位跟随", "err");
      }
    }, EXPORT_TIMEOUT_MS);
    if (!silent) {
      pushBtn.disabled = true;
      pushBtn.classList.add("busy");
    }
    log("导出 " + modeLabel(mode) + " @" + scale + "x");

    execFunc("prismPush('" + mode + "', " + scale + ")", function (res) {
      exporting = false;
      if (exportTimeout) { clearTimeout(exportTimeout); exportTimeout = null; }
      if (!silent) {
        pushBtn.disabled = false;
        pushBtn.classList.remove("busy");
      }
      var j = null;
      try { j = JSON.parse(res); } catch (e) {}
      if (j && j.ok) {
        if (j.file) {
          var seg = j.file.split(/[\\\/]/);
          curName = seg[seg.length - 1] || curName;
        }
        lastInfo.textContent = j.width + "×" + j.height + "px · " + (j.sizeKB || 0) + " KB · " + new Date().toLocaleTimeString();
        log("已推送 " + (j.file || ""), "ok");
        setTimeout(function () { pollStatus(); }, 600);
      } else {
        log((j && j.msg) || res || "导出失败", "err");
      }
      if (!silent) readActiveDoc();
    });
  }

  /* 开关切换: 真正的推送会话跑在宿主(main.jsx)里, 面板只负责 UI 与状态同步。
     宿主会话不受面板折叠/关闭影响 —— 只有点「关闭推送」或退出 PS 才结束。 */
  function togglePush() {
    if (!pushOn) {
      pushOn = true;
      hostTickState = "";      // 重新开启: 通道状态重新判定
      pushBtn.classList.add("on");
      pushBtn.textContent = "关闭推送";
      saveState();
      readActiveDoc();
      log("推送服务已开启", "ok");
      // 点击推送即确保服务端在线: 未运行则自动拉起, 就绪后开始心跳保活与跟随
      startWhenServiceReady(24);
    } else {
      pushOn = false;
      saveState();
      pushBtn.classList.remove("on");
      pushBtn.textContent = "推送预览";
      stopBeats();
      stopFollow();
      /* 通知宿主撤销可能残留的定时任务, 并让服务端把本机源标记下线 */
      execFunc("prismPushStop()", function () {
        log("已停止推送会话", "");
      });
      log("推送服务已关闭, 手机端约 10s 后搜不到本机", "");
    }
  }

  /* 面板(重新)打开时按上次状态恢复: 推送会话在面板侧常驻, 面板被 CEP 销毁
     后重开, 依 localStorage 记录自动续推(服务端不在线会自动拉起)。
     PS 重启后 localStorage 仍在, 因此这里只在"服务端已知本机有过推送会话"
     时恢复 —— 保守起见仅恢复按钮 UI 与参数, 由服务端心跳状态决定是否续推。 */
  function syncPushState() {
    var s = loadState();
    if (!s) return;
    var m = document.getElementById("mode");
    var sc = document.getElementById("scale");
    /* ★状态回填必须归一化: 旧版本存过 mode:"canvas"(该选项已从下拉移除), 原样回填会让
       select 落到未选中(value=""), 既不显示「当前画板」, 后续推送还会发空 mode。
       这里一律落回默认「当前画板」, 并立即回写, 保证下次打开仍是干净的两项之一。 */
    if (m) m.value = normalizeMode(s.mode || m.value);
    if (sc && s.scale) sc.value = s.scale;
    if (!s.on) {
      pushBtn.classList.remove("on");
      pushBtn.textContent = "推送预览";
      return;
    }
    pushOn = true;
    pushBtn.classList.add("on");
    pushBtn.textContent = "关闭推送";
    /* 仅当服务端仍在运行时才自动续推 —— 服务端会随 PS 退出而终止, 因此
       "服务端在线"等价于"这还是同一个 PS 会话"(面板折叠后重开/被销毁重建)。
       PS 重启后服务端已被宿主租约关停, 不会擅自恢复推送, 需用户重新点击。 */
    fetch(SERVICE + "/api/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function () {
        log("已恢复上次的推送会话", "ok");
        startWhenServiceReady(24);
      })
      .catch(function () {
        pushOn = false;
        pushBtn.classList.remove("on");
        pushBtn.textContent = "推送预览";
        saveState();
      });
  }

  /* 推送中切换「推送内容 / 导出倍率」: 记下新参数并立即按新参数重推一帧 */
  function onParamChange() {
    if (!pushOn) return;
    saveState();
    hostTickState = "";
    startHostSession();   // 宿主会话按新参数重建: 立即按新参数推一帧并继续跟随
    doPush(true);         // 面板侧补推一帧, 新参数立刻反映到预览
    log("推送参数已更新", "");
  }

  pushBtn.addEventListener("click", togglePush);
  document.getElementById("mode").addEventListener("change", onParamChange);
  document.getElementById("scale").addEventListener("change", onParamChange);

  /* 画布变动跟随: 面板侧 autoFollowCheck 常态运行(面板折叠时靠 manifest 里已
     关闭的 CEF 后台节流保持频率); 宿主 tick 若在跑则面板降频, 见 hostTickWatch。 */

  /* 画布变动跟随: 面板侧 autoFollowCheck 只在兜底链路(宿主会话起不来)里跑;
     常态跟随由宿主 tick 完成, 节拍由 Worker 提供(抗折叠), 见 startBeatWorker。
     折叠/展开时打点并把节拍计数写进日志, 便于判断节拍在折叠期间是否仍在跑。 */
  document.addEventListener("visibilitychange", function () {
    var v = document.visibilityState;
    log("面板可见性: " + v + " · 节拍 Worker " + (tickWorker ? "运行中" : "未启用") +
        " · 已下发 " + panelTicks + " 拍 · 宿主 " + (hostDriven || "-"), "");
    if (v === "visible") { lastPanelTick = 0; tickFromPanel("visible"); }
  });

  setInterval(pollStatus, 2000);
  pollStatus();
  readActiveDoc();
  /* 面板就绪即注入 main.jsx 并启动宿主心跳(文件源 + HTTP 源), 与推送开关无关:
     只要 PS 还在, 服务端就该活着; PS 一关, 两路心跳同时消失。 */
  startHostBeat();
  startHostAlive();
  /* 打开面板即校准推送范围: 无论有无持久化记录, 下拉都必须停在两项之一(默认「当前画板」),
     不允许出现"未选择"(selectedIndex=-1 / value="")—— 那会让推送带上空 mode 或报错。
     首次打开走 index.html 的 selected=artboard; 有旧值("canvas" 等已移除项)时在这里归一。 */
  (function ensureModeSelected() {
    var m = document.getElementById("mode");
    if (!m) return;
    var fixed = normalizeMode(m.value);
    if (m.value !== fixed) m.value = fixed;
  })();
  /* 面板折叠/关闭后重开: 推送会话仍在宿主侧常驻, 恢复按钮与下拉框状态 */
  syncPushState();
  log("棱镜 PS 插件就绪 · 推送按钮为服务开关", "");
})();
