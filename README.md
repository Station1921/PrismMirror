# 棱镜 · 设计稿实时预览（PrismMirror）

把 Photoshop 里正在编辑的**画板 / 选区**实时推送到手机（HarmonyOS）上预览。改一版、看一眼，不用再「导出 PNG → 传微信 → 手机点开」来回折腾。

> 项目由三个部分组成：Photoshop CEP 插件 + 电脑端本地服务 + HarmonyOS 手机端。三者通过局域网协作，手机与电脑在同一个 Wi-Fi 下即可使用。

---

## 功能特性

- **实时推送**：PS 画板/选区内容变化后自动推送，手机端看到的是最新画面。
- **推送范围可选**：`当前画板` / `当前选区`（旧版本客户端仍可传 `整个画布`，服务端保持兼容）。
- **手机端三种预览方式**
  - **适应**：整张设计稿等比缩放进屏幕，看得全。
  - **全屏**：等比放大铺满屏幕，溢出部分可拖动查看，不拉伸变形。
  - **实际**：按设计稿**物理像素 1:1** 显示，用于看真实尺寸与细节。
- **手势操作**：双指捏合缩放、拖动平移、双指旋转（按 90° 步进）。缩放/平移/旋转三者互斥，避免画面跳动。
- **局域网自动发现**：服务端每秒 UDP 广播一次，手机端自动列出可用电脑；也支持手动输入 `电脑IP:端口`。
- **随 PS 生灭**：以 Photoshop 进程为宿主判据——PS 在则服务在，PS 关闭则服务自动退出。
- **不残留临时文件**：帧图中转目录「用完即删」，进程启动、源下线、宿主退出三个时机兜底清理。
- **面板折叠推送不停**：CEP 面板被折叠/遮挡时 `setInterval` 会被节流，插件改用 Web Worker 节拍 + PS 宿主调度器 + COM 外部节拍兜底，保证推送链不断。
- **离线联调模式**：不装 PS 也能跑（`--mode simulate` 自动生成变化测试图）。

---

## 系统架构

| 模块 | 目录 | 技术栈 | 职责 |
| --- | --- | --- | --- |
| PS 插件 | `PSPlugin/` | CEP（HTML/CSS/JS）+ ExtendScript | 从 PS 导出画板/选区帧、面板预览与日志、心跳上报、自动拉起并守护服务端 |
| 电脑端服务 | `server/` | Python 3（标准库 HTTP/UDP，可选 `pywin32`） | 接收帧并发布最新画面、HTTP 服务、UDP 广播发现、宿主存活守护与自动退出 |
| 手机端 App | `MirrorView_HarmonyApp/` | ArkTS / ArkUI（HarmonyOS） | 发现设备、轮询拉取画面、手势浏览与状态提示 |

### 数据流

```
Photoshop 画板/选区
      │  main.jsx 导出 PNG（按推送范围与缩放）
      ▼
data/watch/  ← 帧图中转目录（服务端读取后立即删除）
      │  服务端发布到内存（保留最新一帧）
      ▼
HTTP GET /latest  ← 手机端每 600ms 轮询 /api/status，发现新序号即拉取
      ▼
HarmonyOS 预览页（适应 / 全屏 / 实际，支持缩放、拖动、旋转）
```

---

## 环境要求

| 端 | 要求 |
| --- | --- |
| PS 插件 | Windows + Photoshop 2023（24.0）及以上（CEP 11 / CSXS 9.0） |
| 电脑端服务 | Windows 10 / 11 + Python 3.11；打包为独立 exe 后无需 Python。可选 `pywin32`（用于面板折叠时的 COM 外部节拍通道） |
| 手机端 | HarmonyOS 设备 + DevEco Studio（ArkTS 工程，`hvigorw` 构建） |
| 网络 | 手机与电脑处于同一局域网（同一 Wi-Fi / 热点） |

---

## 快速开始

### 1. 部署 PS 插件（CEP）

将 `PSPlugin/` 整个目录复制到 CEP 扩展目录，并把目录名保持为清单中的 `ExtensionBundleId`：

```
%APPDATA%\Adobe\CEP\extensions\com.prism.mirror.ps\
```

未签名的扩展需要开启调试模式（写入注册表 `HKCU\Software\Adobe\CSXS.11` 的 `PlayerDebugMode = 1`，数字随 PS 版本对应 CSXS 版本变化）。

### 2. 启动电脑端服务

```bash
# 源码方式（开发/调试）
python server/mirror_server.py --port 8765

# 或使用打包好的独立可执行文件
server\MirrorServer.exe
```

正常情况下无需手动启动——插件面板会在需要时自动拉起服务端，并持续守护。

### 3. 在 Photoshop 中开始推送

打开 PS → `窗口 > 扩展（旧版）> 棱镜 · 推送预览`，在面板中：

1. 选择推送范围（当前画板 / 当前选区）；
2. 点击 **推送预览**；
3. 面板会显示本机 IP、服务地址、最近一帧的名称与推送日志，并展示当前帧缩略图。

### 4. 手机端查看

手机连接同一 Wi-Fi，打开 App：

- App 会自动发现局域网内的电脑（UDP 8787 广播），点击设备卡片进入预览；
- 或手动输入 `电脑IP:8765`（例如 `192.168.1.100:8765`）。

进入预览页后可用底部模式切换**适应 / 全屏 / 实际**，双指缩放、拖动平移、双指旋转。

---

## HTTP / UDP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 简易预览页（浏览器直接验证用） |
| GET | `/latest` | 返回最新一帧图片，响应头 `X-Ts` / `X-Seq` 便于判断是否有更新 |
| GET | `/api/status` | 状态 JSON：活跃源、图片序号、文件名、本机 IP 等 |
| POST | `/api/heartbeat` | 插件心跳：注册当前活跃推送源 |
| POST | `/api/host-alive` | 宿主（PS）存活心跳：只刷新宿主租约，不改推送源语义 |
| POST | `/api/push-enable` | 开启推送（面板点「推送预览」） |
| POST | `/api/deactivate` | 关闭推送，源随即离线 |
| POST | `/api/panel-beat` | 面板节拍上报（面板侧 3s 节流） |
| POST | `/api/view` | 上报本次推送范围几何（出帧前调用） |
| POST | `/api/com-push` | COM 外部节拍：面板折叠/停摆时由服务端驱动 PS 出帧 |
| UDP | `:8787` | 每秒广播 `prism-beacon` JSON 包（`host` / `ip` / `port` / `active`），供手机端发现 |

### 服务端启动参数

| 参数 | 说明 |
| --- | --- |
| `--port` | HTTP 服务端口（默认 `8765`） |
| `--mode` | `watch`：监视中转目录中的新图片（默认）；`simulate`：定时生成渐变测试图，便于无 PS 联调 |
| `--interval` | `simulate` 模式下出图间隔（秒） |
| `--no-host-check` | 关闭 PS 进程判据，脱离 PS 单独调试服务端 |
| `--host-process` | 自定义宿主进程名（默认 `Photoshop.exe`） |
| `--watch-dir` / `--beat-file` | 覆盖帧图中转目录与宿主租约文件路径（隔离测试用） |

---

## 目录结构

```
PrismMirror/
├─ PSPlugin/                      # Photoshop CEP 扩展
│  ├─ CSXS/manifest.xml           # 扩展清单（面板菜单名、尺寸、CEF 反节流参数）
│  ├─ client/                     # 面板前端：index.html / css / js（含 CSInterface.js）
│  ├─ host/main.jsx               # ExtendScript：画板/选区导出、调度器与宿主节拍
│  └─ icons/                      # 面板图标
├─ server/
│  └─ mirror_server.py            # 电脑端服务：帧发布 + HTTP + UDP 广播 + 宿主守护
├─ MirrorView_HarmonyApp/         # HarmonyOS 手机端（ArkTS）
│  ├─ AppScope/                   # 应用级配置与图标
│  └─ entry/src/main/
│     ├─ module.json5             # 模块配置（网络 / Wi-Fi 权限）
│     └─ ets/
│        ├─ entryability/         # 应用入口
│        └─ pages/
│           ├─ Index.ets          # 设备发现与地址输入
│           └─ PreviewPage.ets    # 预览页：轮询、三种适配模式、手势
└─ data/
   └─ server_build.txt            # 服务端构建标记（用于插件校验服务端版本）
```

`data/watch/`（帧图中转目录）与 `data/host.beat`（宿主租约文件）为运行时生成，不纳入版本控制，进程退出时会自动清理。

---

## 构建说明

**手机端（HarmonyOS）**

```bash
cd MirrorView_HarmonyApp
hvigorw assembleHap            # 产物在 entry/build/.../outputs/ 下
hdc install -r <产物.hap>      # 真机安装
```

**服务端（打包独立 exe）**

```bash
pyinstaller -F -n MirrorServer server/mirror_server.py
```

**PS 插件**：CEP 扩展无需编译，复制到扩展目录并在 CEP 调试面板中重新加载即可。

---

## 隐私与安全

- 服务端**无鉴权**，设计定位是可信局域网内的临时预览通道。**请勿将其暴露到公网**，也不要在不可信的公共网络中长期运行。
- 帧图仅保留最新一帧在内存中，中转目录中的帧图发布后立即删除，不落盘留存。
- 手机端不持久化任何画面，旋转等浏览状态为会话级临时状态，退出预览页即复位。
- 插件仅在局域网广播服务信息（主机名 / IP / 端口 / 活跃状态），不含任何用户数据。

---

## 已知限制

- 目前仅支持 Windows：服务端的宿主存活判据依赖 Windows 进程枚举，外部节拍通道依赖 COM。
- 无鉴权、无加密，仅适用于可信任局域网。
- 不是视频流：帧率取决于 PS 导出耗时与网络带宽，大尺寸画布首帧加载可能较慢。
- 手机端旋转为 90° 步进（双指捏合累计转角触发），不支持任意角度。
- 推送范围中的「整个画布」为旧版客户端的兼容分支，新面板不再提供该选项。

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

## 声明

本项目为个人技术验证与自用工具，非 Adobe 官方产品，与 Adobe 无关联。Adobe、Photoshop 是 Adobe Inc. 的商标。
