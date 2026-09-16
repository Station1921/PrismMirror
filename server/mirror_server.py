# -*- coding: utf-8 -*-
r"""
DesignMirror Demo - 电脑端模拟推送服务 (协议接收测试用)

用途:
  模拟"PS/AI 画板内容实时推送到手机"的数据源服务, 供鸿蒙接收端 demo 联调。
  实际产品形态中, 此服务将由"PS UXP 插件导出 + 同步小服务"替代, 网络协议保持一致。

运行:
  python mirror_server.py [--port 8765] [--mode watch|simulate] [--interval 2]

模式:
  watch    : 监听 ./watch 目录, 放入新图片即成为最新预览图 (模拟 PS 导出)
  simulate : 每 --interval 秒自动生成一张变化的渐变测试图 (模拟画板内容变动)

HTTP 接口 (纯标准库, 手机/浏览器均可访问):
  GET  /           简易预览页 (浏览器验证用)
  GET  /latest     返回最新预览图 (响应头 X-Ts / X-Seq 便于查看更新)
  GET  /api/status 返回 JSON 状态 (活跃源/图片序号/文件名/本机IP)
  POST /api/heartbeat  电脑端插件心跳: 注册活跃源 (PS 关闭后心跳停止即视为离线)
  POST /api/host-alive 宿主(PS)存活心跳: 只刷新宿主租约, 不改推送源语义

宿主存活 (PS 是宿主, 宿主不在则服务端不运行):
  首选: 直接枚举系统进程看 Photoshop 在不在 —— 与插件心跳、面板可见性完全无关。
        面板折叠会让 CEP 面板 JS 停摆(心跳随之停), 但 PS 进程照样在,
        所以只有进程判据才能做到"PS 在则服务在, PS 关则服务停"。
        --no-host-check 可关闭(脱离 PS 单独调试服务端), --host-process 可改进程名。
  回退: 平台不支持进程枚举时, 仍按租约心跳判定 —— 启动宽限 STARTUP_GRACE 秒内
        不判定, 之后若连续 HOST_TIMEOUT 秒既无 /api/host-alive 也无
        <应用根>\data\host.beat 更新, 即认为 PS 已退出。
  退出动作: 停发 beacon -> 清理 watch 残片 -> 删除 host.beat -> os._exit(0)。

UDP 发现:
  服务端每 1s 向 255.255.255.255:8787 广播 "prism-beacon" JSON 包
  (host/ip/port/active), 手机端监听 8787 即可发现本机多台电脑源。

临时文件清理 (用完即删 / 关闭即清理 / 不残留):
  watch 目录是插件导出 + 服务端读取的专用中转目录, 帧图"用完即删":
    * 常态: run_watch 读到完整 PNG 并发布进内存后立即 unlink, 目录不积存图片;
    * 兜底: 统一清理函数 cleanup_watch_dir() 在三个时机补清 ——
            进程启动(清上次异常退出/崩溃残留)、源由活跃转不活跃
            (心跳超时或收到 /api/deactivate)、宿主退出前(PS 关闭导致自退);
    * 宿主退出前还会删除 host.beat, 保证 PS 关闭后不残留任何本程序生成的文件。
  cleanup_watch_dir() 只删该目录内本程序产生的临时文件(图片/中间后缀),
  绝不删除目录本身, 也绝不动目录外的任何文件; 删除失败一律容错。
  隔离测试可用 --watch-dir / --beat-file 覆盖两个路径
  (默认取服务端所在应用根目录下的 data)。

活跃源模型:
  镜像服务本身是电脑常驻小进程; 真正"可被手机发现的源"由 PS 插件决定。
  插件面板运行时每 2s 上报心跳, 服务端记录最近心跳时间;
  心跳停止超过 10s 后 /api/status 的 active 自动置为 false,
  手机端即认为"找不到该源"——实现"PS 开=源在线, PS 关=源消失"。
"""
import argparse
import json
import os
import socket
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

# 打包为独立 exe 后 __file__ 指向临时解包目录, 须改用可执行文件所在目录
BASE_DIR = (Path(sys.executable).resolve().parent
            if getattr(sys, "frozen", False)
            else Path(__file__).resolve().parent)
# ---------- 路径推导 (数据跟随插件安装位置, 不写死任何绝对路径) ----------
# 服务端由安装器释放到 CEP 扩展目录内的 <ext>\server\ :
#     <ext>\server\MirrorServer.exe   <- 本程序
#     <ext>\data\watch\               <- 帧图中转目录(发布后即删)
#     <ext>\data\host.beat            <- 宿主(PS)存活租约文件
# 故根目录按"自身可执行文件位置"推导: 若位于 server 子目录内则取上一级(=<ext>),
# 否则取同级目录(便于把 exe 丢到任意位置单独调试), 再在其下派生 data。
# 插件侧 main.jsx 用同样的推导结果, 并在拉起本程序时以 --watch-dir/--beat-file
# 显式传入, 两端保持一致; 也可手工覆盖, 见 --help。
def _app_root(base):
    return base.parent if base.name.lower() == "server" else base


PRISM_ROOT = _app_root(BASE_DIR)
PRISM_HOME = PRISM_ROOT / "data"
WATCH_DIR = PRISM_HOME / "watch"
# 服务端取"内存时间戳 / 本文件 mtime"较新者作为宿主最后存活时间。
HOST_BEAT_FILE = PRISM_HOME / "host.beat"
BEACON_PORT = 8787  # UDP 广播发现端口
BEACON_INTERVAL = 1.0
HOST_TIMEOUT = 10.0   # 宿主存活租约超时(秒): 仅在进程检测不可用时作为回退判据
STARTUP_GRACE = 20.0  # 启动宽限(秒): 只作用于上面的租约回退路径
# ---------- 宿主进程检测 (首选判据) ----------
# 直接枚举系统进程看 Photoshop 在不在, 不看任何心跳。
# 面板折叠/隐藏会让 CEP 面板的 JS 停摆(心跳停发), 但 PS 进程照样在 ——
# 用进程做判据, 才能真正做到"PS 在则服务在, PS 关则服务停"。
HOST_PROCESS_NAME = "Photoshop.exe"
HOST_CHECK = True     # --no-host-check 可关闭(脱离 PS 单独调试服务端时用)

# watch 目录扫描间隔(秒)。原值 0.2, 压缩到 0.1:
# 新帧的"大小连续两轮一致"确认耗时正比于本间隔, 减半后新帧发布等待同步减半,
# 而 10 次/秒的 iterdir+stat 对一个小目录而言 CPU 开销可忽略(实测见验证报告)。
# 注意: 这里只压缩"轮询间隔", 不放松两轮一致性 + PNG 完整性双重校验,
# 避免把 PS 尚未写完的半截 PNG 误判为完整帧发布出去。
WATCH_SCAN_INTERVAL = 0.1


# ---------- 极简 PNG 生成器 (模拟模式用, 无需 Pillow) ----------
def make_gradient_png(width: int, height: int, seq: int) -> bytes:
    """生成一张随时间变化的横向渐变 PNG (RGB), 模拟画板内容在变。"""
    rows = []
    phase = (seq * 13) % 256
    for y in range(height):
        row = bytearray(b"\x00")
        for x in range(width):
            r = (x * 255 // width + phase) % 256
            g = (y * 255 // height + phase) % 256
            b = ((x + y) * 255 // (width + height) + seq * 7) % 256
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


# ---------- 全局状态 ----------
BEAT_TIMEOUT = 10.0  # 心跳超时秒数: 超过即视为源离线
PANEL_BEAT_TIMEOUT = 5.0  # 面板节拍超时(秒): 超过即认为 CEP 面板 JS 已停摆(折叠)
COM_DRIVE_INTERVAL = 2.0  # 折叠期 COM 外部节拍的巡检间隔(秒): 每拍仅注入一次脚本, 实际是否导出由宿主侧令牌比对决定
# ★为什么是 3s 而不是更密: 每一拍都要把整份宿主脚本(数十 KB)注入 PS 重新解析,
#   注入本身就不便宜; 画面变更的去重已由宿主侧的 external_state.txt 承担,
#   这里只需保证"变化后 3s 内被发现", 没必要更密。


class MirrorState:
    def __init__(self):
        self.lock = Lock()
        self.latest_png: bytes | None = None
        self.seq = 0
        self.ts = 0.0
        self.name = ""
        # 活跃源会话 (由 PS 插件心跳驱动)
        self.active = False
        self.active_name = ""
        self.last_beat = 0.0
        # 推送开关: 面板点「推送预览」后置 True(/api/push-enable 或 /api/heartbeat),
        # 点「关闭推送」(/api/deactivate)置 False。它与"心跳有没有按时到达"解耦 ——
        # 面板折叠后心跳会停, 但用户并没有关闭推送, 源就该一直在线。
        self.push_on = False
        # 宿主(PS)存活时间戳: 由 on_host_alive() 刷新, 与上面的推送心跳语义相互独立
        self.host_beat = 0.0
        # 面板节拍时间戳: 面板每拍成功驱动宿主后经 /api/panel-beat 上报(面板侧 3s 节流)。
        # 这是"CEP 面板 JS 还活不活"的唯一外部证据 —— 面板一折叠, window 定时器与
        # Worker 一起停摆、上报随之中断, COM 外部节拍据此接管(见 run_com_driver)。
        self.panel_beat = 0.0
        # 面板最后一次上报的导出参数: 折叠期由 COM 外部节拍接棒时, 必须沿用同一套
        # 参数(mode/scale), 否则折叠期推出去的帧会退回默认视图, 用户看到画面突然变样。
        # ★默认值 = "artboard"(与面板下拉默认项一致): 面板一次都还没上报过(如服务端刚
        #   重启、面板处于折叠态)时, 外部节拍按「当前画板」推 —— 有画板推画板、无画板
        #   由宿主自动退整画布。旧值 "canvas" 仍是合法入参(旧面板/旧会话上报的原样沿用),
        #   这里只是不再把它当默认视图。
        self.panel_mode = "artboard"
        self.panel_scale = 1.0
        # 推送范围几何: 由插件出帧前经 /api/view 上报, 形如
        #   {"mode": "artboard", "cw": 3840, "ch": 2160, "rect": [x0,y0,x1,y1]}
        # cw/ch 是 PS 画布尺寸(像素), rect 是目标画板(或选区)在画布坐标系里的矩形;
        # mode=canvas 或 rect 为空 = 整画布, 不裁。服务端收帧后按它裁一刀再发布
        # (见 view_crop_frame) —— 裁剪放服务端, PS 侧才能保持"只直导、零副本、零闪屏"。
        self.panel_view = {}


state = MirrorState()


def publish_png(data: bytes, name: str):
    with state.lock:
        state.latest_png = data
        state.seq += 1
        state.ts = time.time()
        state.name = name


def on_heartbeat(name: str):
    """插件心跳: 刷新活跃源会话。

    name 为空时保留上一次的 active_name —— 面板折叠/关闭后由宿主(PS 内
    ExtendScript)代为保活, 宿主心跳不携带中文文档名(请求体保持纯 ASCII,
    避免 Content-Length 的 UTF-8 字节数换算), 此时不能把源名清空。
    """
    with state.lock:
        state.active = True
        state.push_on = True     # 有心跳 = 推送开着(兼容旧版面板)
        if name:
            state.active_name = name
        state.last_beat = time.time()


def source_active() -> bool:
    """当前是否有活跃的插件源。

    判据分两层:
      1. 推送开关开着 且 宿主(PS)进程在 -> 源在线, 与心跳无关。
         面板折叠后 CEP 面板 JS 停摆、心跳停发, 但用户并没有关推送,
         手机端不该看到"电脑端已停止推送";
         ★这里刻意不看 last_beat, 也不把"会话标记 active"当必要条件 ——
         历史实现先判 active, 一旦面板在折叠状态下重开/心跳迟到一个周期,
         就会把源误报成离线(手机端闪一下"离线"), 折叠期必须稳定在线。
      2. 回退: 开关状态未知(旧版客户端只发心跳、没发 /api/push-enable)时,
         仍按原心跳超时(10s)判定。
    """
    with state.lock:
        active = state.active
        push_on = state.push_on
        last = state.last_beat
    # 判据 1: 推送开着 + PS 进程还在 => 源在线。不看心跳、不看 active 标记。
    if push_on and host_alive():
        return True
    # 判据 2: 回退到心跳超时(兼容旧版客户端 / 宿主状态无法判定时)
    if not active:
        return False
    return (time.time() - last) <= BEAT_TIMEOUT


def on_host_alive():
    """宿主(PS)存活心跳: 只刷新宿主存活时间戳。

    该接口不得改变 active / active_name / last_beat 的现有语义 ——
    "PS 在不在"与"推送开关开没开"是两件事, 分开记录。
    """
    with state.lock:
        state.host_beat = time.time()


def on_panel_beat(params: dict | None = None):
    """面板节拍上报: 面板每拍成功驱动宿主巡检后调用(面板侧 3s 节流)。

    只刷新面板时间戳; 顺手刷新宿主租约 —— 面板这一拍确实驱动了宿主,
    这是宿主还活着的直接证据。
    params 带面板当前的导出参数(mode/scale), 供折叠期 COM 外部节拍沿用,
    保证折叠与展开推出去的是同一个视图。
    """
    params = params or {}
    with state.lock:
        state.panel_beat = time.time()
        state.host_beat = time.time()
        mode = params.get("mode")
        if isinstance(mode, str) and mode:
            state.panel_mode = mode
        try:
            sc = float(params.get("scale"))
            if sc > 0:
                state.panel_scale = sc
        except (TypeError, ValueError):
            pass


def panel_alive() -> bool:
    """面板节拍是否新鲜(说明 CEP 面板 JS 仍在跑)。"""
    with state.lock:
        pb = state.panel_beat
    return pb > 0.0 and (time.time() - pb) < PANEL_BEAT_TIMEOUT


def on_view(params: dict | None = None):
    """推送范围几何上报(插件侧在出帧前直接调用, 面板不参与)。

    mode=canvas 或拿不到有效矩形 -> 清空 = 整画布(不裁);
    mode=artboard/selection -> 存下画布尺寸与目标矩形, 服务端收帧后裁一刀。
    几何只影响"帧发布前裁哪里", 不参与任何推送节拍判断, 出错也不能影响出帧。
    """
    params = params or {}
    mode = params.get("mode")
    rect = params.get("rect")
    cw = ch = 0.0
    try:
        cw = float(params.get("cw") or 0)
        ch = float(params.get("ch") or 0)
    except (TypeError, ValueError):
        cw = ch = 0.0
    ok_rect = (isinstance(rect, (list, tuple)) and len(rect) == 4)
    keep = False
    if isinstance(mode, str) and mode in ("artboard", "selection") and ok_rect:
        try:
            x0, y0, x1, y1 = [float(v) for v in rect]
            keep = (cw > 0 and ch > 0 and x1 > x0 and y1 > y0)
        except (TypeError, ValueError):
            keep = False
    with state.lock:
        if keep:
            state.panel_view = {
                "mode": mode, "cw": cw, "ch": ch,
                "rect": [float(v) for v in rect], "ts": time.time(),
            }
        else:
            state.panel_view = {}


# ---------- COM 外部节拍 (面板折叠场景的唯一不依赖可见性的通道) ----------
# 本机 PS 的 ExtendScript 没有 app.scheduleTask, 宿主不能自定时; 而面板一折叠,
# CEP 侧 (window 定时器与 Worker 一起) 随不可见面板停摆 —— 节拍源没了, 心跳保活、
# 令牌比对、导出全断, 手机端就停在旧帧。Photoshop 暴露 COM 自动化接口
# (ProgID: Photoshop.Application), 服务端是独立进程, 可以在面板折叠期间持续
# 用 DoJavaScript 驱动宿主巡检, 这是面板之外唯一的驱动通道。两个实测结论:
#   ① DoJavaScript 每次调用都是**独立作用域**: 上一次注入的函数与 $.global 变量
#      都不保留, 所以不能"注入一次、之后只调函数", 每次调用都得重新注入 main.jsx
#      全文(≈40KB);
#   ② 因此单次调用必须自包含 —— 注入脚本尾部直接把宿主巡检跑完。
# 代价是每次注入都要 PS 重新解析整份脚本, 所以调用频率按秒级而非百毫秒级。
COM_PROGIDS = ("Photoshop.Application", "Photoshop.Application.200")
COM_LOCK = Lock()          # 串行化所有 COM 调用(Dispatch 与 DoJavaScript 都不可重入)
COM_OK = False             # 最近一次探测结论: COM 外部节拍通道是否可用
COM_LAST_ERR = ""          # 最近一次失败原因(可读文本): 落盘 com_probe.json 并打进 /api/status
COM_TRIES = 0              # 累计探测次数
COM_FAILS = 0              # 连续失败次数: 用于把重试间隔逐次拉长(降频)
COM_NEXT_TRY = 0.0         # 下次允许重新探测的时刻(epoch 秒)
COM_RETRY_BASE = 30.0      # 失败后首次重试间隔(秒)
COM_RETRY_MAX = 300.0      # 降频重试间隔上限(秒)
COM_PUSH_FAILS = 0         # com_push_once 连续失败次数(超阈值即触发重新探测)
# ---- "PS 主线程忙"必须与通道故障分开处理 ----
# PS 主线程忙时, COM 层会用 RPC_E_SERVERCALL_RETRYLATER(0x8001010A, 文案
# "消息筛选器显示应用程序正在使用中")拒绝调用: 语义是"这一刻没受理, 稍后原样重发
# 即可"(脚本一行都没执行), 属抖动而非通道失效 —— 2026-09-12 折叠期实测 103 次,
# 全部是这一种。处理: 拍内先原样重发一次, 仍失败就只让出这一拍; 不计失败、
# 不进降频静默(详见 _com_is_busy / _com_push_fail)。
COM_BUSY_INBEAT_WAIT = 0.25  # 同一拍内被"PS 忙"拒绝后, 原样重发前的等待(秒)
COM_BUSY_RETRY = 2.0         # 探测遇"PS 忙"后的短重试间隔(秒): 不进降频阶梯


def _com_retry_interval() -> float:
    """失败 n 次后的重试间隔: 30s -> 60s -> 120s -> 240s -> 上限 300s。"""
    n = max(1, COM_FAILS)
    return min(COM_RETRY_MAX, COM_RETRY_BASE * (2 ** (n - 1)))


def _com_note_failure(err: str):
    """记录一次 COM 通道失败: 写明确原因 + 安排降频重试(绝不永久关闭该通道)。

    ★历史缺陷: 旧实现只在进程启动时探测一次并把结论写进 COM_OK, 失败即
    "COM_OK=False -> run_com_driver 永远 continue", 通道被永久关闭 ——
    例如启动瞬间 PS 尚未就绪、或 pywin32 初始化未完成, 折叠期补偿节拍就
    再也起不来了。现在改为: 失败降频重试(30s 起, 上限 5 分钟),
    期间每次失败都把原因写进 com_probe.json 与控制台。
    """
    global COM_OK, COM_LAST_ERR, COM_FAILS, COM_NEXT_TRY
    COM_OK = False
    COM_LAST_ERR = err
    COM_FAILS += 1
    wait = _com_retry_interval()
    COM_NEXT_TRY = time.time() + wait
    print(f"[mirror-server] COM external-drive unavailable: {err} "
          f"(fail #{COM_FAILS}, retry in {wait:.0f}s)", flush=True)


def _com_note_success(progid: str = ""):
    """记录一次 COM 通道可用: 清空失败计数与下次重试时刻。"""
    global COM_OK, COM_LAST_ERR, COM_FAILS, COM_NEXT_TRY, COM_PUSH_FAILS
    COM_OK = True
    COM_LAST_ERR = ""
    COM_FAILS = 0
    COM_NEXT_TRY = 0.0
    COM_PUSH_FAILS = 0
    print("[mirror-server] COM external-drive OK"
          + (f" via {progid}" if progid else ""), flush=True)


COM_PUSH_MAX_FAILS = 3     # com_push_once 连续失败多少次后重新探测 COM 通道


# ---------- COM 通道落盘日志 ----------
# 服务端通常以后台方式启动(vbs / 打包 exe), stdout 根本没人看。而"折叠期间到底有没有
# 在补节拍"是这套方案唯一的验收点, 必须留下能事后翻看的凭据, 所以单独落一份
# com_drive.log: 探测结果和各关节拍结果各记一次(同一状态不重复写, 免得刷屏)。
COM_LOG_FILE = PRISM_HOME / "com_drive.log"
COM_LOG_MAX = 200000
_COM_LOG_LAST = ""


def _com_log(tag: str, line: str, force: bool = False):
    """按"状态变化"落盘: 同一 tag 连续重复只写第一条。"""
    global _COM_LOG_LAST
    if (not force) and tag == _COM_LOG_LAST:
        return
    _COM_LOG_LAST = tag
    try:
        PRISM_HOME.mkdir(parents=True, exist_ok=True)
        old = ""
        try:
            if COM_LOG_FILE.exists() and COM_LOG_FILE.stat().st_size < COM_LOG_MAX:
                old = COM_LOG_FILE.read_text(encoding="utf-8", errors="replace")
        except OSError:
            old = ""
        COM_LOG_FILE.write_text(
            old + time.strftime("%m-%d %H:%M:%S ") + line + "\n", encoding="utf-8")
    except OSError:
        pass


def _com_is_busy(err) -> bool:
    """这次失败是不是"PS 主线程忙, COM 层让稍后再试", 而不是通道失效。

    ★RPC_E_SERVERCALL_RETRYLATER(0x8001010A): 典型文案
      "消息筛选器显示应用程序正在使用中。"; 2026-09-12 折叠期实测 103 次
      DoJavaScript 失败全部是它。含义是"本次调用没被受理, 稍后原样重发即可"
      (被拒时脚本一行都没执行, 重发不会重复执行), 与"PS 没开 / COM 没注册 /
      Dispatch 失败"这类真故障有本质区别: 前者是抖动, 后者才该降频。
    """
    s = str(err or "").lower()
    if "-2147417846" in s or "8001010a" in s:
        return True
    # 只认"忙"专属措辞(+ 上面的 HRESULT): 不把 CALL_E_REJECTED(0x80010001,
    # "被调用方拒绝调用")之类的其它拒绝算进来, 免得把真故障误当抖动而失去降频保护。
    for mark in ("消息筛选器", "应用程序正在使用中", "application is busy",
                 "retrylater", "server busy"):
        if mark in s:
            return True
    return False


def _com_push_fail(err: str):
    """记录一次 com_push_once 失败: 把可读原因落盘/打日志, 连续失败则重新探测。

    ★与 _com_note_failure 的区别: 单次推送失败(PS 正忙、文档未就绪、正在渲染)
    不算通道坏掉, 仍按 COM_DRIVE_INTERVAL 继续尝试; 只有连续失败到阈值才升级为
    "通道可能已失效"并进入降频重试, 避免一次抖动就把折叠期补偿节拍永久关掉。

    ★历史缺陷(2026-09-12 折叠期实测): "PS 主线程忙"被和真失败一起计进
      COM_PUSH_FAILS, 三拍(≈6s)就够触发 _com_note_failure -> COM_OK=False,
      而 run_com_driver 里 `if not COM_OK: continue`, 于是整条外部节拍通道停摆
      COM_RETRY_BASE=30s 起、逐步翻倍到 300s; 折叠期它是唯一节拍源, 手机端在该
      窗口内零帧(实测 37 段静默、累计 54 分钟, 单段 34s~568s), 到点重探成功才
      恢复 —— 这正是"偶发停顿 + 延迟忽高忽低"的直接成因。
      ｜修法: "忙"只让出这一拍, 不计失败、不进降频, 通道始终可用。
    """
    global COM_LAST_ERR, COM_PUSH_FAILS
    COM_LAST_ERR = err
    if _com_is_busy(err):
        # 通道没坏, 只是这一刻 PS 主线程在忙: 不计失败、不降频, 让出这一拍即可 ——
        # run_com_driver 会在下一拍(COM_DRIVE_INTERVAL 后)原样重来, 通道始终可用。
        print(f"[mirror-server] COM busy (PS 主线程忙), 保持通道并让出这一拍: {err}",
              flush=True)
        return
    COM_PUSH_FAILS += 1
    print(f"[mirror-server] COM push failed (#{COM_PUSH_FAILS}): {err}", flush=True)
    if COM_PUSH_FAILS >= COM_PUSH_MAX_FAILS:
        _com_note_failure("连续 %d 次 COM 推送失败: %s" % (COM_PUSH_FAILS, err))


def _com_apartment_enter():
    """在"将要调用 COM 的线程"内初始化 COM 单元。

    ★历史缺陷: 本模块所有 COM 调用都发生在子线程(run_com_probe /
    run_com_driver / /api/com-push 的工作线程), 而 pywin32 在未调用
    CoInitialize 的线程里首次使用 COM 会抛 "CoInitialize has not been
    called"(HRESULT 0x800401F0) 或让 Dispatch 返回莫名失败 —— 表现为
    "Dispatch 报服务器运行失败 -2146959355"这类难定位的故障。
    每个线程进入前必须配对初始化/反初始化。

    返回 (是否需要配对调用 CoUninitialize, 错误文本)。
    """
    try:
        import pythoncom
    except Exception as e:
        return False, "无 pythoncom(pywin32 未安装/未打包): %s" % e
    try:
        pythoncom.CoInitialize()
        return True, ""
    except Exception as e:
        return False, "CoInitialize 失败: %s" % e


def _com_apartment_leave(inited: bool):
    """与 _com_apartment_enter 配对的反初始化(线程退出前必须调用)。"""
    if not inited:
        return
    try:
        import pythoncom
        pythoncom.CoUninitialize()
    except Exception:
        pass


def _com_rot_listing():
    """列出 ROT(运行对象表)里的显示名, 用于诊断"PS 有没有把自己注册成 COM 服务"。

    现场遇到 CO_E_SERVER_EXEC_FAILURE(0x80080005, 文案"服务器运行失败")时, 第一件
    要确认的事就是它: ROT 里有 Photoshop.Application, 说明 COM 服务已注册、只是连接
    方式不对(改用 GetActiveObject 即可); 没有, 说明 PS 这次启动没暴露自动化接口,
    该改走 notifier / 面板通道 —— 两者处置完全不同, 不能只留一句笼统报错。
    """
    names = []
    try:
        import pythoncom
        rot = pythoncom.GetRunningObjectTable()
        ctx = pythoncom.CreateBindCtx(0)
        enum = rot.EnumRunning()
        while len(names) < 40:
            try:
                batch = enum.Next(1)
            except Exception:
                break
            if not batch:
                break
            got = False
            for mk in batch:
                got = True
                try:
                    names.append(str(mk.GetDisplayName(ctx, None)))
                except Exception:
                    names.append("?")
            if not got:
                break
    except Exception as e:
        names.append("ROT 枚举失败: %s" % e)
    return names


def _com_dispatch():
    """取一个可用的 PS COM 对象。

    返回 (app, err, progid): 成功为 (对象, "", 命中方式);
    失败为 (None, 可读错误文本, "")。
    ★必须在已 _com_apartment_enter 的线程内调用(与 _com_apartment_leave 配对)。
    ★绝不在 PS 未运行时 Dispatch: COM 会把 Photoshop 自动拉起来。

    ★历史故障(现场实录): 旧实现直接 wc.Dispatch("Photoshop.Application"), 报
      "服务器运行失败"(CO_E_SERVER_EXEC_FAILURE)。这句错并不代表"PS 没开" ——
      PS 当时就在前台跑着。Dispatch 走的是"启动/激活服务器"的路径: 它不会复用
      已有实例, 而是尝试拉起一个新的 Photoshop, 在超时或被拒之后统一以这句
      笼统的错误收场, 于是外部节拍通道被误判为"本机不可用"。
      修正: **优先用 GetActiveObject 从 ROT 直连那个已经开着的 PS** —— 这条路只认
      运行中的实例, 不触发任何启动尝试(两条等价写法, 视 pywin32 版本择一);
      ROT 里确实找不到时, 才退回 Dispatch 兜底。
    """
    try:
        import win32com.client as wc
    except Exception as e:
        return None, "无 win32com: %s" % e, ""
    last_err = ""
    # ① 直连已运行实例(不启动任何新进程)
    for progid in COM_PROGIDS:
        getter = getattr(wc, "GetActiveObject", None)
        if getter is not None:
            try:
                return getter(progid), "", progid + " GetActiveObject"
            except Exception as e:
                last_err = "%s GetActiveObject: %s" % (progid, e)
        try:
            import pythoncom
            return (wc.Dispatch(pythoncom.GetActiveObject(progid)), "",
                    progid + " pythoncom-ROT")
        except Exception as e:
            last_err = "%s pythoncom.GetActiveObject: %s" % (progid, e)
    # ② 兜底: 常规 Dispatch(会尝试激活/启动服务器)
    for progid in COM_PROGIDS:
        try:
            return wc.Dispatch(progid), "", progid + " Dispatch"
        except Exception as e:
            last_err = "%s Dispatch: %s" % (progid, e)
    return None, (last_err or "Dispatch 失败(无可用 ProgID)"), ""


def com_push_once() -> bool:
    """用 COM 在 PS 主进程里跑一次外部节拍 (注入 main.jsx + 触发 prismExternalPush)。

    成功返回 True。加锁串行, 避免与其它 COM 调用交叉。
    ★本函数运行在子线程: 调用前必须 _com_apartment_enter() 初始化 COM 单元,
      结束后配对 _com_apartment_leave(), 否则 pywin32 会以
      "CoInitialize has not been called" 之类的错误让通道看起来不可用。
    ★每次失败都把可读原因写进 COM_LAST_ERR(并经 write_com_probe 落盘 com_probe.json);
      连续失败 COM_PUSH_MAX_FAILS 次即转交 _com_note_failure 进入降频重试, 不永久关通道。
    """
    # PS 不在跑时绝不 Dispatch: COM 会自动把 Photoshop 重新拉起来,
    # 那是灾难(用户已关 PS, 服务端却给它拉起一个后台实例)。
    if photoshop_running() is False:
        return False
    app_root = BASE_DIR.parent if BASE_DIR.name == "server" else BASE_DIR
    try:
        src = (app_root / "host" / "main.jsx").read_text(encoding="utf-8")
    except OSError as e:
        _com_push_fail("读取宿主脚本失败 %s: %s"
                       % (app_root / "host" / "main.jsx", e))
        return False
    if src.startswith("#target") and "\n" in src:
        src = src.split("\n", 1)[1]
    # 沿用面板最后一次的导出参数(mode/scale): 折叠期推出去的帧必须与展开时同一视图
    with state.lock:
        mode = state.panel_mode
        scale = state.panel_scale
    try:
        scale = float(scale)
        if scale <= 0:
            scale = 1.0
    except (TypeError, ValueError):
        scale = 1.0
    # ★必须调 prismExternalPush 而不是 prismHostTick:
    #   DoJavaScript 每次调用都是全新引擎, 没有历史令牌 —— prismHostTick 会把本例
    #   的令牌当作"首轮基线"而不导出(实测: 心跳刷新了、seq 不涨), 手机端拿不到新帧。
    #   prismExternalPush 自行处理跨调用失忆: 令牌与上次导出时刻落盘在
    #   data/external_state.txt, 画面未变就直接跳过导出, 变了才真出帧。
    # ★末句就是本函数的返回值: DoJavaScript 回传最后一个表达式的值, 于是外部节拍
    #   的执行结果(推了 / 跳过 / 失败)能直接落到服务端侧, 不必再靠猜。
    #   末尾不要再补一句 'com-beat-ok'; —— 那会把真正的结果覆盖掉。
    script = ("var PRISM_EXT_ROOT = %s;\n" % json.dumps(str(app_root))) + src + \
             "\nprismExternalPush(%s, %s);" % (json.dumps(mode), repr(scale))
    # 子线程首次触碰 COM 前必须初始化 COM 单元(STA); 失败即写明确原因并返回
    inited, ierr = _com_apartment_enter()
    try:
        if ierr:
            _com_push_fail(ierr)
            return False
        with COM_LOCK:
            app, verr, vprogid = _com_dispatch()
            if app is None:
                _com_push_fail(verr)
                return False
            rv = None
            dj_err = None
            # 被"PS 主线程忙"拒绝时, 拍内原样重发一次: RETRYLATER 表示本次调用没被
            # 受理(脚本一行都没执行), 重发不会重复导出; "忙"通常几百毫秒就过去,
            # 拍内抓住能省下一整拍(COM_DRIVE_INTERVAL=2s)的延迟。其余错误不重发。
            for attempt in (1, 2):
                try:
                    rv = app.DoJavaScript(script)
                    dj_err = None
                    break
                except Exception as e:
                    dj_err = e
                    if attempt == 1 and _com_is_busy(e):
                        time.sleep(COM_BUSY_INBEAT_WAIT)
                        continue
                    break
            if dj_err is not None:
                _com_push_fail("DoJavaScript 失败: %s" % dj_err)
                _com_log("beat-fail", "折叠期节拍失败(DoJavaScript): %s" % dj_err)
                return False
            rvt = "" if rv is None else str(rv)
            # 宿主明确回报失败才算这一拍没成; 回报"跳过"(画面未变)同样是成功 ——
            # 折叠期绝大多数拍都属于"跳过", 那正是落盘去重生效的证据。
            if '"ok":false' in rvt:
                _com_push_fail("外部节拍未成功: %s" % rvt[:200])
                _com_log("beat-fail", "折叠期节拍未成功: %s" % rvt[:200])
                return False
            if "skipped" in rvt:
                _com_log("beat-skip", "折叠期节拍: 画面未变, 已跳过导出(去重生效)")
            else:
                _com_log("beat-push", "折叠期节拍: 已驱动宿主推出一帧")
        global COM_PUSH_FAILS
        COM_PUSH_FAILS = 0        # 本次成功: 清零连续失败计数
        return True
    finally:
        _com_apartment_leave(inited)


def write_com_probe(res: dict):
    """把 COM 探测结果落盘, 供面板/宿主读取(判断本机是否具备外部驱动能力)。"""
    try:
        p = HOST_BEAT_FILE.parent / "com_probe.json"
        p.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def run_com_probe():
    """探测 COM 通道: Dispatch 能否拿到 PS、DoJavaScript 能否执行。

    只读探测(id 里跑一句 'ok'), 不触碰文档、不注入宿主脚本。结果落盘供插件读取。
    ★本函数运行在子线程 -> 必须先 CoInitialize, 结束 CoUninitialize 配对释放。
    ★失败不再"一锤定音": 把可读原因与下次重试间隔写进 com_probe.json, 同时由
      _com_note_failure 排出降频重试时刻(30s 起, 上限 5 分钟), run_com_driver
      会在到点时再调本函数 —— 启动瞬间 PS 未就绪之类的误判可以自愈。
    """
    global COM_TRIES
    res = {"dispatch": False, "dojavascript": False, "ok": False,
           "progid": "", "err": "", "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    COM_TRIES += 1
    res["tries"] = COM_TRIES
    inited, ierr = _com_apartment_enter()
    try:
        if ierr:
            res["err"] = ierr
        else:
            with COM_LOCK:
                app, derr, progid = _com_dispatch()
                if app is None:
                    res["err"] = derr
                    # 失败时附上 ROT 快照: 一眼看出是"PS 没注册 COM 服务"还是
                    # "注册了但连接方式不对", 避免下次又只拿到一句笼统的"服务器运行失败"。
                    res["rot"] = _com_rot_listing()
                else:
                    res["progid"] = progid
                    res["dispatch"] = True
                    try:
                        app.DoJavaScript("'ok'")
                        res["dojavascript"] = True
                    except Exception as e:
                        res["err"] = "DoJavaScript 失败: %s" % e
    finally:
        _com_apartment_leave(inited)
    res["ok"] = bool(res["dispatch"] and res["dojavascript"])
    if res["ok"]:
        _com_note_success(res.get("progid", ""))
        _com_log("probe-ok",
                 "COM 通道可用: %s (第 %d 次探测) -> 折叠期可由服务端补节拍"
                 % (res.get("progid", ""), COM_TRIES), force=True)
    elif _com_is_busy(res.get("err")):
        # 探测被"PS 主线程忙"拒绝: 同样不是通道失效 —— 保持 COM_OK 原值不动, 只把
        # 下次重试提前到 COM_BUSY_RETRY 秒后。历史实现这里走 _com_note_failure, 于是
        # 一次"忙"被放大成 30s→60s→120s→240s→300s 的静默, 折叠期唯一节拍源随之消失。
        global COM_NEXT_TRY, COM_LAST_ERR
        COM_LAST_ERR = res.get("err", "")
        COM_NEXT_TRY = time.time() + COM_BUSY_RETRY
        print(f"[mirror-server] COM probe hit PS-busy, retry in {COM_BUSY_RETRY:.1f}s: "
              f"{res.get('err')}", flush=True)
        _com_log("probe-busy", "COM 探测遇 PS 主线程忙(第 %d 次探测): %s"
                 % (COM_TRIES, (res.get("err") or "无错误文本")[:160]))
    else:
        _com_note_failure(res["err"] or "COM 探测失败(无错误文本)")
        _com_log("probe-fail", "COM 通道不可用(第 %d 次探测): %s"
                 % (COM_TRIES, (res["err"] or "无错误文本")[:160]))
    # 失败时把"下次重试还有多久 / 已连续失败几次"一并落盘, 便于定位
    res["retryInSec"] = max(0, int(COM_NEXT_TRY - time.time()))
    res["fails"] = COM_FAILS
    write_com_probe(res)


def run_com_driver(stop_event):
    """折叠期外部节拍: 面板节拍一断, 就由本进程用 COM 驱动 PS 跑宿主巡检。

    为什么要这条通道: 本机 PS 的 ExtendScript 没有 app.scheduleTask, 宿主不能自定时;
    面板一折叠, CEP 侧 window 定时器与 Worker 一起停摆 —— 节拍源彻底消失, 心跳保活、
    令牌比对、导出全断, 手机端停在旧帧。服务端是独立进程, 不受面板可见性影响,
    经 COM(DoJavaScript) 就能在折叠期间继续驱动宿主, 这是面板之外唯一的通道。

    判定面板是否停摆, 认三个条件(缺一不可, 避免误判、避免与面板双通道叠加导出):
      ① COM 通道可用(COM_OK, 来自 run_com_probe);
      ② 推送开着(state.push_on)且有宿主在跑(PS 进程在);
      ③ 面板节拍已超过 PANEL_BEAT_TIMEOUT 没上报 —— 面板还活着时绝不出手,
         否则每秒多出一次 40KB 注入, 表现为 PS 卡顿 + 画面闪烁。
    每轮先看面板是否恢复: 面板一旦喘过气, 立即让位(continue), 只补一拍不带惯性。
    ★通道不可用时不会退出循环, 而是按 _com_retry_interval() 降频重试探测,
      免得"启动时探测失败 -> 折叠期补偿节拍永久失效"。
    """
    while not stop_event.is_set():
        stop_event.wait(COM_DRIVE_INTERVAL)
        try:
            now = time.time()
            if (not COM_OK) and now >= COM_NEXT_TRY:
                run_com_probe()          # 降频重试: 失败也留着这条路
            if not COM_OK:
                continue
            with state.lock:
                push_on = state.push_on
            if not push_on:
                continue
            if panel_alive():
                continue          # 面板节拍新鲜: 让面板驱动, 不叠加
            if photoshop_running() is False:
                continue          # PS 不在跑: 不 COM(免得把 PS 拉起来)
            com_push_once()
        except Exception as e:
            # 不再静默吞掉: 异常文本落盘并计入连续失败, 超阈值自动重新探测
            try:
                _com_push_fail("driver 异常: %s" % e)
            except Exception:
                pass


def host_last_seen() -> float:
    """宿主最后存活时间 = max(内存时间戳, 心跳文件 mtime)。"""
    with state.lock:
        beat = state.host_beat
    try:
        mtime = HOST_BEAT_FILE.stat().st_mtime
    except OSError:
        mtime = 0.0
    return max(beat, mtime)


def _is_host_process(exe_name: str) -> bool:
    """进程名是否算宿主: 精确匹配配置名, 或 Photoshop 系列(Beta 等)。"""
    want = HOST_PROCESS_NAME.lower()
    e = (exe_name or "").strip()
    if e == want:
        return True
    return e.startswith("photoshop") and e.endswith(".exe")


def photoshop_running():
    """枚举系统进程判断 Photoshop 是否在运行。

    返回 True / False / None(None = 平台不支持或调用失败, 无法判定,
    调用方应回退到租约心跳)。只用标准库 ctypes 调 kernel32 的进程快照 API,
    不引入 psutil 等第三方依赖, 保证 PyInstaller 单文件打包后依然可用。
    """
    if not HOST_CHECK:
        return None
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        TH32CS_SNAPPROCESS = 0x00000002

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),   # ULONG_PTR
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        k32 = ctypes.windll.kernel32
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not snap or snap == ctypes.c_void_p(-1).value:
            return None
        try:
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = k32.Process32First(snap, ctypes.byref(entry))
            while ok:
                exe = entry.szExeFile.decode("mbcs", "ignore").lower()
                if _is_host_process(exe):
                    return True
                ok = k32.Process32Next(snap, ctypes.byref(entry))
            return False
        finally:
            k32.CloseHandle(snap)
    except Exception:
        return None


HOST_STARTED = time.time()   # 本进程启动时刻(租约回退路径的兜底基准)


def host_alive() -> bool:
    """宿主(PS)是否还活着: 首选进程检测, 无法检测时回退到租约心跳。"""
    r = photoshop_running()
    if r is not None:
        return r
    return (time.time() - max(HOST_STARTED, host_last_seen())) <= HOST_TIMEOUT


def run_watchdog(stop_event):
    """宿主租约看门狗: 每 1s 检查一次, 宿主(PS)消失超时即自行退出。

    PS 是宿主: 宿主不在, 插件与服务端都不该继续跑。
    PS 退出后 main.jsx 随宿主消失、host.beat 不再刷新, 面板也不再来
    /api/host-alive, 于是租约自然过期 -> 停发 beacon -> 进程退出,
    手机端"找到设备源"列表中的本机源随之消失。
    """
    started = time.time()
    while not stop_event.is_set():
        now = time.time()
        # 判据 1(首选): 直接看 Photoshop 进程在不在 —— 与心跳、面板可见性无关。
        # PS 一关, 最迟 1s 后这里就自退, 不再有 20s 宽限期的尾巴。
        alive = photoshop_running()
        if alive is False:
            print("[mirror-server] 宿主 Photoshop 已退出, 服务端随之关闭",
                  flush=True)
            _shutdown_server(stop_event, "host-exit")
            return
        # 判据 2(回退): 平台不支持进程枚举时, 仍按原租约心跳判定
        if alive is None and now - started >= STARTUP_GRACE:
            # 基准取 max(启动时刻, 宿主最后存活时刻): 服务端刚起来、面板还没发出
            # 首个心跳时 host_last_seen() 返回 0(1970), 直接相减得到 17 亿秒级的
            # idle, 服务端会在宽限期一过就"启动即自退"。用启动时刻兜底后, 最坏
            # 情况也保证 STARTUP_GRACE + HOST_TIMEOUT 的存活窗口。
            idle = now - max(started, host_last_seen())
            if idle > HOST_TIMEOUT:
                print(f"[mirror-server] host lease expired: no host alive for "
                      f"{idle:.1f}s (> {HOST_TIMEOUT:.1f}s), shutting down "
                      f"to stop beacon", flush=True)
                _shutdown_server(stop_event, "host-exit")
                return
        stop_event.wait(1.0)


def _shutdown_server(stop_event, reason: str):
    """宿主退出时的收尾: 停 beacon -> 清 watch 残留 -> 删心跳文件 -> 硬退出。"""
    stop_event.set()      # 通知 beacon 线程立即停发
    # 关闭即清理: PS 已退出, 清掉 watch 目录残余, 并删除宿主心跳文件,
    # 保证宿主关闭后本地不残留任何本程序生成的文件(os._exit 前必须完成)
    cleanup_watch_dir(reason)
    remove_host_beat()
    time.sleep(0.05)
    os._exit(0)           # 硬退出: 保证 beacon 立刻停发, 父子进程一并结束


def run_source_watchdog(stop_event):
    """活跃源看门狗: 只在"活跃 -> 不活跃"的边沿做一次 watch 目录清理。

    源离线有两种成因 —— 插件心跳超时(PS 关闭/推送停止), 或面板调 /api/deactivate;
    无论哪种, 都表现为 source_active() 由 True 变 False。此时 watch 目录里可能
    还留着本轮导出但尚未被 run_watch 消费的残片, 在边沿统一补一次清理。

    只清磁盘残留: 不改 active / active_name / last_beat, 不清内存 latest 缓存,
    也不影响 /latest 与 /api/status 既有的"源离线"关闭语义。
    """
    was_active = False
    while not stop_event.is_set():
        act = source_active()
        if was_active and not act:
            cleanup_watch_dir("source-inactive")
        was_active = act
        stop_event.wait(1.0)


def run_beacon(stop_event=None):
    """UDP 广播源发现包: 手机端监听 BEACON_PORT 即可搜到本机。

    stop_event 被置位后立即停止广播, 不再发送任何 UDP 包。
    """
    import socket as sk
    host = sk.gethostname()
    s = sk.socket(sk.AF_INET, sk.SOCK_DGRAM)
    try:
        s.setsockopt(sk.SOL_SOCKET, sk.SO_BROADCAST, 1)
    except OSError:
        pass
    while not (stop_event is not None and stop_event.is_set()):
        try:
            ips = local_ips()
            ip = ips[0] if ips else "127.0.0.1"
            act = source_active()
            with state.lock:
                seq = state.seq
                disp_name = state.name if act else ""
                src_name = state.active_name if act else ""
            payload = json.dumps({
                "type": "prism-beacon",
                "host": host,
                "ip": ip,
                "port": PORT,
                "seq": seq,
                "active": act,
                "name": disp_name,
                "active_name": src_name,
            }).encode()
            s.sendto(payload, ("255.255.255.255", BEACON_PORT))
        except OSError:
            pass
        if stop_event is not None:
            stop_event.wait(BEACON_INTERVAL)  # 可被停止信号立即唤醒
        else:
            time.sleep(BEACON_INTERVAL)
    try:
        s.close()
    except OSError:
        pass



def run_simulate(interval: float):
    """周期生成渐变图, 模拟"画板内容变化"。"""
    seq = 0
    while True:
        seq += 1
        publish_png(make_gradient_png(720, 1280, seq), f"simulate_{seq:04d}.png")
        time.sleep(interval)


WATCH_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".psd")

# watch 目录内"本程序会产生"的临时文件后缀: 与 run_watch 监听的图片后缀同源,
# 另加写入中间态后缀(.tmp/.part)。清理只认这些后缀 —— 目录内其它文件一律不碰。
WATCH_TEMP_SUFFIXES = WATCH_SUFFIXES + (".tmp", ".part")


def cleanup_watch_dir(reason: str = "") -> int:
    """统一清理 watch 目录内本程序产生的临时文件。

    调用时机(见 __main__ / run_watchdog / run_source_watchdog / Handler.do_POST):
      1. 进程启动时        —— 清理上次异常退出/崩溃遗留的半成品;
      2. 源由活跃转不活跃   —— 心跳超时, 或收到 /api/deactivate 后清理本轮残留;
      3. 宿主(PS)退出前    —— 服务端自退前清理, 保证关闭后不残留。

    安全边界:
      * 只删除 WATCH_DIR 目录**内部**、后缀命中 WATCH_TEMP_SUFFIXES 的普通文件;
      * 目录本身、子目录以及目录外的任何文件一概不动;
      * 单个文件删除失败(被占用/权限不足)只跳过, 绝不抛异常影响主流程;
      * 只做磁盘清理, 不改动 active / last_beat / 内存 latest 缓存等任何状态。
    返回本次成功删除的文件数。
    """
    removed = 0
    try:
        if not WATCH_DIR.is_dir():
            return 0
        entries = list(WATCH_DIR.iterdir())
    except OSError:
        return 0
    for f in entries:
        try:
            if not f.is_file():
                continue                     # 跳过子目录/其它非文件项
            if f.suffix.lower() not in WATCH_TEMP_SUFFIXES:
                continue                     # 只清理本程序产生的临时文件
            f.unlink()
            removed += 1
        except OSError:
            continue                         # 删除失败容错: 跳过, 不影响后续与进程
    if removed:
        print(f"[watch] cleanup({reason or 'manual'}): removed "
              f"{removed} stale file(s)", flush=True)
    return removed


def remove_host_beat() -> bool:
    """删除宿主(PS)存活心跳文件 host.beat: 宿主已退出, 该文件不再需要。

    只删 HOST_BEAT_FILE 这一个文件, 不动其所在目录、不动目录内其它任何内容;
    文件不存在或删除失败(被占用等)均返回 False, 不抛异常。
    """
    try:
        HOST_BEAT_FILE.unlink()
        return True
    except OSError:
        return False


def img_complete(data: bytes) -> bool:
    """帧完整性校验: 防读到 PS 尚未写完的半截文件(手机端解码即为撕裂/黑屏)。

    · PNG: 头部签名 + 末尾 IEND chunk(4 字节 "IEND" + 4 字节 CRC, 校验倒数第 8~5 字节)
    · JPEG: 头部 FFD8(SOI) + 末尾 FFD9(EOI)

    为什么必须两种都认: 插件侧自动跟随帧走 JPEG(帧小、PS 编码快, 主线程占用低),
    手动推送帧仍走 PNG-24(要透明与无损). 只认 PNG 会把所有跟随帧判成"半截文件"
    直接删掉 —— 现场表现就是"面板显示在推, 手机端一帧都收不到"。
    """
    n = len(data)
    if n < 12:
        return False
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data[-8:-4] == b"IEND"
    if data[:2] == b"\xff\xd8":
        return data[-2:] == b"\xff\xd9"
    return False


def display_name(fname: str) -> str:
    """把磁盘上的帧文件名还原成 PS 文档名(给面板/手机端展示)。

    自动跟随帧写成 "<文档名>.jpg"(导出器按扩展名挑编码器, JPEG 帧必须叫 .jpg),
    这里去掉末尾那层 .jpg 还给用户 PS 里的原始文档名, 例如
    "数字中台系统.psd.jpg" -> "数字中台系统.psd"。
    手动帧是 "<文档名>" 原样, 不带 .jpg, 直接透传。
    """
    low = fname.lower()
    for s in (".jpg", ".jpeg"):
        if low.endswith(s) and len(fname) > len(s):
            return fname[: -len(s)]
    return fname


# 推送帧的长边"安全阀"(px)。
# ★历史: 旧值 1080 实际充当了"清晰度上限" —— 插件端把设计稿压到 1080 再发, 手机端
#   放大看必然发糊。现在清晰度定案为"按设计稿原始像素 1:1 传输", 本常量退回纯安全阀:
#   只有帧长边超过 4096(超大画布, 几万像素级) 才等比降采样, 用来挡住手机端解码内存
#   与传输时间失控; 正常设计稿帧原样透传, 服务端一次缩放都不做。
# ★必须与插件端 PUSH_MAX_AUTO_EDGE 同步: 下游更小 = 上游按原始尺寸出的帧到这儿又被
#   截断, 只改插件等于白改(这正是"多级限制必须一起放宽"的原因)。
FRAME_MAX_EDGE = 4096
# 服务端重编码时的 JPEG 质量。只在"确实要缩放 / 裁剪"时才用到(正常帧直接透传, 不重编码),
# 取值与插件端 PUSH_JPEG_QUALITY 同档(95): 裁剪后多编一代也不会带来可见的画质下降。
JPEG_QUALITY = 95


def shrink_frame(data: bytes) -> bytes:
    """安全阀: 仅当帧长边超过 FRAME_MAX_EDGE 时才等比降采样, 否则原样透传。

    为什么放在服务端而不是插件侧: PS 侧降采样必须 duplicate 出新文档窗口才能改
    像素尺寸, 而新窗口的开/关就是用户看到的闪屏。服务端是独立进程, 缩放不碰 PS。

    ★清晰度优先: 限内的帧一律【不缩放、不重编码、原样返回】。
      旧实现会把限内的 PNG 用 Pillow 再压一遍(optimize), 像素无损, 但每帧都要付出
      CPU 与内存, 对全尺寸大画布帧是实打实的延迟; 换来的只是字节数变小, 与清晰度无关。
      现在宁可多传一点, 也要让帧"怎么来怎么走", 不引入任何一代编解码损失。
    任何异常(未装 Pillow / 非图片数据 / 内存不足)都原样返回, 绝不因降采样让帧发不出去。
    """
    try:
        import io
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            m = max(w, h)
            if m <= FRAME_MAX_EDGE:
                # 限内直传: JPEG 二次编码只掉画质; PNG 重压只省字节却要按帧付 CPU。
                return data
            is_jpeg = (im.format or "").upper() in ("JPEG", "MPO")
            s = FRAME_MAX_EDGE / float(m)
            im = im.resize((max(1, int(round(w * s))), max(1, int(round(h * s)))),
                           Image.LANCZOS)
            out = io.BytesIO()
            if is_jpeg:
                # JPEG 帧按原格式重编码(LANCZOS 后直存 JPEG_QUALITY)。不顺手转 PNG:
                # 后缀与内容不一致会让手机端按 content-type 解码出问题, 排查时更误导人。
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                im.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            else:
                im.save(out, format="PNG", optimize=True)
            new = out.getvalue()
            if len(new) < len(data):
                return new
            return data
    except Exception as e:
        print(f"[watch] shrink skipped: {e}", flush=True)
        return data


def view_crop_frame(data: bytes) -> bytes:
    """按 /api/view 上报的推送范围几何裁掉无关区域(画板 / 选区模式)。

    为什么裁剪放服务端: 插件侧要"只导某个画板", 只能复制文档再删其余画板 /
    去画板化 / crop —— 无论哪条路都要动文档结构, 文档窗口跟着开合重绘, 放在跟随帧
    路径上就是持续闪屏; 而选区模式至少要 feed 一次选区。服务端是独立进程, 收帧后
    用 Pillow 裁一刀对 PS 零副作用, 插件侧因此可以"永远直导原文档整画布"。

    换算: rect 是【PS 画布坐标系】(左上为原点, 单位像素)的矩形, 帧就是这幅画布整幅
    导出, 按导出倍率线性换算: f = 帧宽 / 画布宽, crop = (x0,y0,x1,y1) * f。
    只用帧宽求 f、刻意不引入帧高: 画布与帧必然等比, 单边换算少一个误差来源。

    任何异常(未装 Pillow / 非图片 / 帧不完整 / 帧与画布对不上)一律原样返回 ——
    裁不了宁可发整画布, 也不能让帧发不出去。
    """
    with state.lock:
        v = dict(state.panel_view) if state.panel_view else {}
    if not v:
        return data
    mode = v.get("mode")
    rect = v.get("rect") or []
    if mode not in ("artboard", "selection") or len(rect) != 4:
        return data
    try:
        cw = float(v.get("cw") or 0)
        ch = float(v.get("ch") or 0)
        x0, y0, x1, y1 = [float(t) for t in rect]
    except (TypeError, ValueError):
        return data
    if cw <= 0 or ch <= 0 or x1 <= x0 or y1 <= y0:
        return data
    try:
        import io
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            fw, fh = im.size
            if fw <= 1 or fh <= 1:
                return data
            f = float(fw) / cw
            # 帧与画布不是同一个视图(文件滞后 / 换了文档): 不裁
            if abs(ch * f - fh) > max(2.0, fh * 0.02):
                return data
            L = max(0, int(x0 * f)); T = max(0, int(y0 * f))
            R = min(fw, -int(-x1 * f // 1)); B = min(fh, -int(-y1 * f // 1))  # 右/下取整
            if R - L < 8 or B - T < 8:
                return data
            if R - L >= fw and B - T >= fh:
                return data                      # 等于整幅, 没必要重编码
            is_jpeg = (im.format or "").upper() in ("JPEG", "MPO")
            if is_jpeg:
                box = im.convert("RGB") if im.mode not in ("RGB", "L") else im
                box = box.crop((L, T, R, B))
            else:
                box = im.crop((L, T, R, B))
            out = io.BytesIO()
            if is_jpeg:
                # ★裁剪必须重编码(JPEG 无法在压缩域直接裁), 所以这里用的是与插件端
                #   同档的 JPEG_QUALITY(95): 多一代编码也不产生可见损失。旧值 85 在
                #   设计稿这种"大片平坦色 + 锐利文字边缘"的内容上会明显糊边。
                box.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            else:
                box.save(out, format="PNG", optimize=True)
            new = out.getvalue()
        print(f"[watch] view crop mode={mode} ({L},{T})-({R},{B}) of {fw}x{fh} "
              f"-> {R - L}x{B - T}, {len(data)} -> {len(new)} B", flush=True)
        return new
    except Exception as e:
        print(f"[watch] view crop skipped: {e}", flush=True)
        return data


def run_watch():
    """监听 ./watch 目录新文件(含同名覆盖), 发布后立即删除不落盘。

    PS Save for Web 是边写边生成, 若在写入中读取会拿到半截 PNG,
    手机端解码即为撕裂/黑屏。因此:
      1. 文件大小需连续两轮观测一致, 才认为写入完成;
      2. 读取后再 stat 复核大小未变化;
      3. 内容必须通过 PNG 完整性校验才发布, 损坏的半截文件直接删除不积存。

    扫描节奏: 每 WATCH_SCAN_INTERVAL(0.1s) 轮询一次, 新帧从落盘到发布只需等到
    下一次观测复检(≤1 个间隔) + 大小一致性确认(1 个间隔), 即 0.1~0.2s 量级。
    """
    WATCH_DIR.mkdir(parents=True, exist_ok=True)
    seen = {}     # name -> (mtime_ns, size)  已发布
    pending = {}  # name -> size              上一轮观测
    while True:
        try:
            files = list(WATCH_DIR.iterdir())
        except OSError:
            files = []
        for f in files:
            if f.suffix.lower() not in WATCH_SUFFIXES:
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            if st.st_size <= 0:
                continue
            key = (st.st_mtime_ns, st.st_size)
            if seen.get(f.name) == key:
                continue  # 已发布且文件未变
            if pending.get(f.name) != st.st_size:
                pending[f.name] = st.st_size  # 仍在写入: 记下大小等下一轮复检
                continue
            try:
                data = f.read_bytes()
                st2 = f.stat()
            except OSError:
                continue
            if st2.st_size != st.st_size:
                pending[f.name] = st2.st_size  # 读取过程中仍在写
                continue
            pending.pop(f.name, None)
            if not img_complete(data):
                print(f"[watch] skip incomplete {f.name} ({st.st_size} bytes)")
                try:
                    f.unlink()  # 损坏半截文件不发布, 也不积存
                except OSError:
                    pass
                continue
            shrunk = shrink_frame(data)
            # 推送范围几何(画板/选区)在服务端裁: 插件侧因此可以"永远直导原文档整画布",
            # 不再 duplicate 副本、不再切换活动文档, 跟随帧路径上零文档窗口开合。
            if state.panel_view:
                shrunk = view_crop_frame(shrunk)
            # 磁盘名 -> 展示名: 跟随帧写成 "<文档名>.jpg"(扩展名决定导出编码器),
            # 这里减掉这层后缀, 面板/手机端看到的仍是 PS 里的文档名。
            publish_png(shrunk, display_name(f.name))
            seen[f.name] = key
            print(f"[watch] published {f.name} ({len(data)} -> {len(shrunk)} bytes)")
            try:
                f.unlink()  # 发布进内存后删除, watch 目录不积存图片
                # 删除职责: 成功帧由服务端删(插件侧不删成功帧, 避免两边抢删);
                # 插件只负责删自己导出失败留下的半成品。
            except OSError:
                pass
        time.sleep(WATCH_SCAN_INTERVAL)


# ---------- HTTP 处理 ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "MirrorDemo/0.1"

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def _send(self, code: int, body: bytes, ctype: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            html = """<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Mirror Demo 预览</title></head>
<body style="margin:0;background:#222;text-align:center">
<img id="img" style="height:92vh;max-width:96vw;object-fit:contain">
<div style="color:#aaa;font:14px monospace" id="info"></div>
<script>
let lastSeq=-1;
async function refresh(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const s=await r.json();
    document.getElementById('info').textContent='seq='+s.seq+' ts='+s.ts+' file='+s.name;
    if(s.seq!==lastSeq){lastSeq=s.seq;
      const t=new Date().getTime();
      document.getElementById('img').src='/latest?ts='+t;}
  }catch(e){}
}
setInterval(refresh,500);refresh();
</script></body></html>"""
            self._send(200, html.encode(), "text/html; charset=utf-8")
        elif path == "/latest":
            if not source_active():
                # 电脑端推送源已离线(PS 关闭/插件停推): 立即清除内存旧帧,
                # 避免"上次推送的图"在手机端/面板残留。
                with state.lock:
                    if state.latest_png is not None:
                        state.latest_png = None
                        state.name = ""
                        state.ts = 0.0
                self._send(404, b"source offline", "text/plain")
                return
            with state.lock:
                data, seq, ts, name = state.latest_png, state.seq, state.ts, state.name
            if data is None:
                self._send(404, b"no image yet", "text/plain")
                return
            # 帧格式随插件侧走: 自动跟随是 JPEG, 手动推送是 PNG-24; 按内容头判定,
            # 不按文件名猜(展示名已被还原成 .psd)。
            ctype = "image/jpeg" if data[:2] == b"\xff\xd8" else "image/png"
            self._send(200, data, ctype,
                       {"X-Seq": seq, "X-Ts": f"{ts:.3f}"})
        elif path == "/api/status":
            act = source_active()
            host_ok = host_alive()   # 锁外计算: 内部会再次取 state.lock
            panel_ok = panel_alive()  # 面板节拍不新鲜 = 面板已折叠/停摆, COM 外部节拍接管
            with state.lock:
                body = json.dumps({
                    "seq": state.seq, "ts": round(state.ts, 3),
                    "name": state.name, "mode": MODE, "port": PORT, "build": SERVER_BUILD,
                    # 帧清晰度口径随状态一起回显: 现场排"到底是哪一级在压图"时,
                    # 手机端/浏览器直接读这两个值即可, 不必再猜服务端是哪一版。
                    "frame_max_edge": FRAME_MAX_EDGE, "jpeg_quality": JPEG_QUALITY,
                    "active": act,
                    "active_name": state.active_name if act else "",
                    "push_on": state.push_on,
                    "host_alive": host_ok,
                    "panel_alive": panel_ok,
                    "com_drive": bool(COM_OK),
                    # 通道不可用时把可读原因与下次重试倒计时一并给出,
                    # 便于手机端/面板直接显示"为什么没走外部节拍"
                    "com_err": ("" if COM_OK else str(COM_LAST_ERR))[:200],
                    "com_tries": COM_TRIES,
                    "com_retry_in": max(0, int(COM_NEXT_TRY - time.time())),
                    "beat_ago": round(time.time() - state.last_beat, 2),
                    "ip": (local_ips() or ["127.0.0.1"])[0],
                    "host": socket.gethostname(),
                }).encode()
            self._send(200, body, "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/heartbeat":
            length = int(self.headers.get("Content-Length") or 0)
            raw = b""
            if length > 0:
                raw = self.rfile.read(length)
            name = ""
            try:
                j = json.loads(raw or b"{}")
                name = j.get("name", "")
            except Exception:
                pass
            on_heartbeat(name)
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        elif path == "/api/host-alive":
            # 宿主(PS)存活刷新: 面板/插件保活, 只刷新宿主租约, 不动推送源语义
            on_host_alive()
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        elif path == "/api/panel-beat":
            # 面板节拍上报: 面板每拍成功驱动宿主巡检后调用(面板侧 3s 节流)。
            # 服务端据此判断"CEP 面板 JS 是否还在跑": 折叠后 window 定时器与 Worker
            # 一起停摆 -> 上报中断 -> 折叠期外部节拍(COM)接管, 见 run_com_driver。
            # 请求体带面板当前的导出参数(mode/scale), 折叠期由 COM 沿用同一套参数。
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                params = json.loads(raw or b"{}")
            except Exception:
                params = {}
            on_panel_beat(params)
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        elif path == "/api/view":
            # 推送范围几何上报: 面板/宿主把"当前画板/当前选区"相对画布的像素矩形发来,
            # 服务端收帧后照它裁剪(见 view_crop_frame)。整画布模式直接清零。
            # ★这条路只影响帧裁剪, 不参与节拍/存活判断, 失败也不能影响推流。
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                params = json.loads(raw or b"{}")
            except Exception:
                params = {}
            on_view(params)
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        elif path == "/api/com-push":
            # COM 外部节拍: 由独立进程驱动 PS 跑一次宿主巡检(注入 main.jsx + 推一帧)。
            # 同步执行会阻塞请求线程, 故放到工作线程里, 立即回 202;
            # 结果与 PS 是否真的响应, 看 data/host.beat 的刷新与 seq 变化。
            import threading
            threading.Thread(target=com_push_once, kwargs={}, daemon=True).start()
            self._send(202, json.dumps({"ok": True, "via": "com"}).encode(),
                       "application/json")
        elif path == "/api/push-enable":
            # 面板点「推送预览」: 显式登记"推送开关已打开"。
            # 此后源是否在线只取决于 PS 进程在不在(见 source_active),
            # 与面板心跳无关 —— 面板折叠导致心跳停发, 不会再被误判成"推送已停"。
            with state.lock:
                state.push_on = True
                state.active = True
                state.last_beat = time.time()
                state.host_beat = time.time()
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        elif path == "/api/deactivate":
            # 插件手动停止推送: 立即置源离线, 手机端随即搜不到该源
            with state.lock:
                state.push_on = False
                state.active = False
                state.active_name = ""
                state.last_beat = 0.0
            # 源离线: 清掉 watch 目录里未被消费的导出残片。
            # 只清磁盘, 不动上面的关闭语义与内存 latest 缓存。
            cleanup_watch_dir("deactivate")
            self._send(200, json.dumps({"ok": True}).encode(), "application/json")
        else:
            self._send(404, b"not found", "text/plain")


def local_ips():
    import socket
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips or ["127.0.0.1"]


MODE = "simulate"
PORT = 8765
# 服务端构建号: 随 py 改动一起改。它会被写进 data/server_build.txt 并出现在
# /api/status 里, 用来回答"8765 端口上蹲着的到底是哪一版服务端" —— 现场反复吃
# 亏就吃在旧打包 exe 占着端口, 新加的 COM 外部节拍 / com_drive.log 全都不存在,
# 从外部却完全看不出来。
SERVER_BUILD = "2026-09-15 R9 py-hires-frame"

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--mode", choices=["watch", "simulate"], default="simulate")
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--host-timeout", type=float, default=HOST_TIMEOUT,
                    help="宿主(PS)存活租约超时秒数, 默认 %.1f" % HOST_TIMEOUT)
    ap.add_argument("--startup-grace", type=float, default=STARTUP_GRACE,
                    help="启动宽限秒数(此期间不做宿主判定), 默认 %.1f" % STARTUP_GRACE)
    ap.add_argument("--watch-dir", default="",
                    help="覆盖 watch 中转目录(默认 <应用根>/data/watch, 应用根按自身位置推导), "
                         "由 PS 插件拉起时显式传入")
    ap.add_argument("--beat-file", default="",
                    help="覆盖宿主心跳文件(默认 <应用根>/data/host.beat), "
                         "由 PS 插件拉起时显式传入")
    ap.add_argument("--no-host-check", action="store_true",
                    help="关闭宿主(Photoshop)进程检测, 仅脱离 PS 单独调试服务端时使用")
    ap.add_argument("--host-process", default=HOST_PROCESS_NAME,
                    help="宿主进程名, 默认 %s" % HOST_PROCESS_NAME)
    args = ap.parse_args()
    MODE, PORT = args.mode, args.port
    HOST_TIMEOUT, STARTUP_GRACE = args.host_timeout, args.startup_grace
    HOST_CHECK = not args.no_host_check
    HOST_PROCESS_NAME = args.host_process
    # 仅当显式传参时才覆盖路径: 不传则用按自身位置推导出的 <应用根>/data 下的默认位置
    if args.watch_dir:
        WATCH_DIR = Path(args.watch_dir).expanduser()
    if args.beat_file:
        HOST_BEAT_FILE = Path(args.beat_file).expanduser()
    # 构建号落盘: 宿主/面板启动时读它判断端口上跑的是哪一版(是否是 py 版)。
    try:
        PRISM_HOME.mkdir(parents=True, exist_ok=True)
        (PRISM_HOME / "server_build.txt").write_text(SERVER_BUILD, encoding="utf-8")
    except OSError:
        pass

    # (0) 全新机器 / 首次运行: 运行时数据目录按需自建在 <应用根>/data 下,
    #     不依赖安装器预置, 也不依赖外部配置文件(watch 是本进程的中转目录,
    #     host.beat 由 PS 插件侧写入同根位置)。失败只告警, 不阻断启动。
    try:
        WATCH_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"[mirror-server] 警告: 无法创建 watch 目录 {WATCH_DIR}: {e}")

    # (a) 进程启动即清理上次异常退出/崩溃遗留在 watch 目录的半成品
    cleanup_watch_dir("startup")

    # 先占用监听端口: 若已有实例在跑, 这里直接抛错退出,
    # 不会启动 beacon 线程, 避免重复拉起的实例向手机端误广播源。
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)

    import threading
    stop_event = threading.Event()
    # COM 能力探测(只读): 面板折叠后节拍只能来自面板之外, COM 是唯一可行通道。
    # 启动时判一次并落盘 data/com_probe.json, 插件据此显示本机是否具备外部驱动能力。
    threading.Thread(target=run_com_probe, daemon=True).start()
    # 折叠期外部节拍: 面板节拍断供(面板被折叠)且 COM 可用时, 由本进程接管驱动宿主巡检
    threading.Thread(target=run_com_driver, args=(stop_event,), daemon=True).start()
    threading.Thread(target=run_beacon, args=(stop_event,), daemon=True).start()
    # 宿主租约看门狗: PS 退出 -> 心跳停更 -> 超时自行退出并停发 beacon
    threading.Thread(target=run_watchdog, args=(stop_event,), daemon=True).start()
    # 活跃源看门狗: 源离线(心跳超时 / deactivate)边沿清理 watch 目录残片
    threading.Thread(target=run_source_watchdog, args=(stop_event,), daemon=True).start()
    if args.mode == "simulate":
        threading.Thread(target=run_simulate, args=(args.interval,), daemon=True).start()
    else:
        threading.Thread(target=run_watch, daemon=True).start()

    print(f"[mirror-server] mode={args.mode} interval={args.interval}")
    print(f"[mirror-server] watch dir: {WATCH_DIR} (用完即删; 启动/源离线/宿主退出均兜底清理)")
    print(f"[mirror-server] host: process-check={HOST_CHECK} "
          f"target={HOST_PROCESS_NAME} | lease fallback: "
          f"timeout={HOST_TIMEOUT:.1f}s grace={STARTUP_GRACE:.1f}s "
          f"beat_file={HOST_BEAT_FILE}")
    print(f"[mirror-server] LAN URLs: " + " | ".join(
        f"http://{ip}:{args.port}/" for ip in local_ips()))
    print(f"[mirror-server] beacon udp: 255.255.255.255:{BEACON_PORT}")
    print(f"[mirror-server] status: http://127.0.0.1:{args.port}/api/status")
    srv.serve_forever()
