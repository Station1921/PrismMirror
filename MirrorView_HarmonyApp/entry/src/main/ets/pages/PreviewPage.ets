import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction, router, window } from '@kit.ArkUI';

const DOMAIN: number = 0x0000;
const TAG: string = 'MirrorViewPreview';
const POLL_MS: number = 600;
// 断线判定时间窗(ms): 距上次成功超过该时长才认定"已与电脑端断开"。
// 用时间窗而非"连续失败次数", 避免网络抖动/单次卡顿被误报成断连。
const LOST_MS: number = 8000;
const DEFAULT_SERVER: string = 'http://192.168.1.27:8765';
// 手动刷新超时(ms): 超时后强制收尾(停转 + 失败提示), 避免刷新图标一直转不停。
// 必须兜底的原因: 服务端返回 active=false 时 imgSrc 被清空、Image 不再渲染, onComplete 永远不会回调。
// ★配合清晰度修复(帧改为设计稿原始像素 1:1 传输)上调: 全尺寸帧单帧可能到 MB 级,
// 弱网/2.4G 下加载 1~3s 属正常, 5s 会把"正在加载大图"误报成"刷新超时"。
// 这里给到 20s, 只放宽上限, 不影响正常帧的即时收尾(加载完即刻提示)。
const REFRESH_TIMEOUT_MS: number = 20000;
// 旋转动效帧间隔与每帧角度: 20ms x 6° ≈ 300°/s, 视觉上接近匀速旋转。
// 用定时器累加角度而非 .animation({iterations:-1}), 与页面既有 setInterval 风格一致, 且能确保"停得掉、不残留"。
const REFRESH_TICK_MS: number = 20;
const REFRESH_STEP_DEG: number = 6;
// 旋转步进触发阈值(deg): 双指捏合的累计转角达到该值才步进一步。
// 不取 1° 而取 60°: 两指捏合缩放时连线本来就会轻微摆动, 阈值太小会把"缩放"误判成"旋转",
// 一误判就会重新适配尺寸, 画面跟着跳。60° 要"明确地拧"才会触发, 误判概率大幅下降;
// ★不要再加"本次手势已明显缩放就不判旋转"之类的闸门: 双指旋转时两指间距必然变化,
//    Pinch 一定会先置位, 那种闸门会让旋转彻底失效(上一版就是这么坏的)。
// 也不要太大, 否则用户得把手腕拧到极限才动一下。
const ROT_TRIGGER_DEG: number = 60;
// 捏合方向 -> 旋转方向的符号。RotationGesture 的 angle 是两指连线夹角的 arctan2 差值,
// 屏幕坐标系(y 轴向下)下正值为顺时针, 故取 +1(顺时针捏合 = 顺时针旋转 90°)。
// ★若真机上手感相反, 只需要改这一处符号, 其余逻辑无需动。
const ROT_DIR_SIGN: number = 1;
// 预览方式索引(与 fitLabels/fitModes 同序): 适应 / 全屏 / 实际
//   适应(Contain): 整张设计稿等比塞进屏幕, 看得全、看不清细节
//   全屏(Cover)  : 等比放大到填满屏幕(短边铺满、长边溢出, 溢出部分可拖动查看), 不拉伸变形
//   实际(Contain + 1:1 基准): 按原图【物理像素 1:1】显示 —— 设计稿画布 80px×80px,
//                在手机屏上就实实在在占 80 物理像素, 不随屏幕大小/密度缩放
const FIT_ADAPT: number = 0;
const FIT_FILL: number = 1;
const FIT_ACTUAL: number = 2;

interface StatusData {
  seq: number;
  ts: number;
  name: string;
  mode: string;
  port: number;
  active?: boolean;
  active_name?: string;
  host?: string;
}

interface PageParams {
  serverUrl?: string;
}

// Image.onComplete 回调事件里我们真正用到的字段(单位: px, 图像源像素尺寸)。
// 宿主 d.ts 里该回调事件是个大 union, 这里只声明用得到的两个字段, 既避免 ArkTS
// 的隐式 any 报错, 也省得把整段 SDK 类型抄进来。
interface FrameLoadEvent {
  width: number;
  height: number;
}

@Entry
@Component
struct PreviewPage {
  @State serverUrl: string = DEFAULT_SERVER;
  @State imgSrc: string = '';
  @State statusText: string = '正在连接电脑服务…';
  @State devName: string = '';
  @State lastSeq: number = 0;
  @State fitMode: number = FIT_ADAPT; // 见文件头 FIT_* 常量: 适应 / 全屏 / 实际
  // 当前帧的【原图像素尺寸】(px), 由 Image.onComplete 的 event.width/height 写入:
  // "实际"模式按它做 1:1 换算, 其余模式只用它算拖拽边界。
  // 0 = 还没拿到(首帧未回调), 此时"实际"自动按"适应"表现兜底, 不会崩也不会出 NaN。
  @State naturalW: number = 0;
  @State naturalH: number = 0;
  @State controlsVisible: boolean = true;
  @State zoom: number = 1;
  @State zoomBase: number = 1;
  @State tx: number = 0;
  @State ty: number = 0;
  @State panBaseX: number = 0;
  @State panBaseY: number = 0;
  @State viewW: number = 360;
  @State viewH: number = 780;
  @State refreshAngle: number = 0;      // 刷新图标当前旋转角度(由定时器累加)
  @State refreshing: boolean = false;   // 本次手动刷新中: 动效与结果提示的守卫标志
  // 画面旋转角(deg, 只取 0/90/180/270): 双指捏合步进。
  // ★会话级临时状态, 不做任何持久化 —— 断连/重开 App/重新进入预览页一律回到 0°(见 resetRotation() 的调用点)。
  @State rotateDeg: number = 0;
  // 状态栏(时间/电量)高度(vp): 入场时由 getWindowAvoidArea 取一次并缓存。
  // 只在"操作栏可见"时用来给操作栏让位; 之所以缓存而不实时查询, 是为了让操作栏位置在
  // 任何一次状态栏显隐中都不变(实时查询会在状态栏隐藏时变成 0, 操作栏跟着上下跳)。
  @State statusBarTop: number = 0;

  private httpReq: http.HttpRequest = http.createHttp();
  private pollTimer: number = -1;
  private seq: number = -1;
  private failCnt: number = 0;
  private busy: boolean = false;      // 上一轮 /api/status 是否仍在飞, 防请求堆积
  private lastOkMs: number = 0;       // 最近一次探测成功时间, 用于时间窗断线判定
  private win: window.Window | null = null;
  private refreshAngleTimer: number = -1;    // 旋转动效定时器
  private refreshTimeoutTimer: number = -1;  // 手动刷新超时兜底定时器
  private rotFired: boolean = false;         // 本次捏合手势是否已经步进过(一次手势只跳一步)
  /* ---- 手势互斥状态 ----
     ★修"双指捏合/拖动时画面忽大忽小、横跳"的根子: 之前 Pinch / Rotation / Pan 三个手势
       在 Parallel 组里同时生效, 一次触摸里它们各自改自己的状态, 谁也不知道对方刚干了什么 ——
       捏合视角摆动触发旋转(内容尺寸一变, 画面整体尺寸跟着跳), 单指/双指交替时平移量跳变,
       表现就是"放大→突然变小→又变大"的反复横跳。这里给三个手势加上互斥与状态同步:
       · pinching : 双指捏合中, 屏蔽单指平移, 不让两种手势同时改画面
       · rotating : 本次触摸正在步进旋转, 旋转期间挡掉单指平移(缩放不再被冻结, 见 onPinchUpdate)
       · pinchMoved: ★该闸门已删除 —— 双指旋转时两指间距必然变化、Pinch 一定先置位,
         它等于把旋转整个屏蔽掉(用户反馈"完全转不动"), 现在缩放与旋转各自独立推进 */
  private pinching: boolean = false;
  private rotating: boolean = false;
  // 上一帧 Pinch 的累计比例: -1 = 本次手势尚未建立基线(首个 update 只建基线、不动画面)
  private lastPinchScale: number = -1;
  // 最近一次捏合/旋转事件时间戳(ms): 兜底清理 pinching/rotating 的残留标志
  // (系统偶发不回调 onActionEnd 时, 残留标志会把后续整段单指拖动吃掉, 表现为"拖不动")
  private lastPinchMs: number = 0;
  private lastRotateMs: number = 0;
  // 最近一次"真的拖动了画面"的时间戳(ms): 双击缩放要避开它 —— 拖动后手顺势连点两下
  // 很容易被识别成双击, 双击把 zoom 从 1 直接翻到 3(或反过来), 看起来就是"拖一下画面突然变大又还原"
  private lastPanMs: number = 0;
  // 上一帧 Pan 的累计偏移(vp): 平移改为"按增量推进", 被屏蔽期间的位移直接吃掉,
  // 双指手势结束后松指或继续单指拖动都不会突然跳一段。
  private lastPanX: number = 0;
  private lastPanY: number = 0;

  /* 索引与 fitLabels 一一对应(顺序即单按钮的循环顺序: 适应 → 全屏 → 实际 → 适应)。
     ★★ 本轮关键改动: 不再让框架的 objectFit 去"适配/裁剪", 而是把内容尺寸自己算出来设给 Image。
       病根: objectFit 只能把内容画进【组件盒子】里, 超出盒子的部分会被框架裁掉。
         · 全屏(Cover): 内容短边贴边、长边溢出, 溢出的长边根本画不出来 —— 拖动只是把"已被裁过的
           盒子"整体移走, 盒子边缘一进屏就露黑底(用户截图的左右黑块); 
         · 实际模式: 内容远大于屏幕, 同样被裁, 而拖拽边界却按"完好的内容尺寸"算, 算的与画的对不上,
           拖动时边界失效就表现为"突然放大 / 忽大忽小"。
       现在: contentW()/contentH() 直接作为 Image 的宽高, objectFit 固定 Fill —— 尺寸已按原比例
       算好, 不会变形; 画出来的内容与算边界的尺寸严格是同一份, 黑块与尺寸跳变一并消失。 */
  private fitLabels: string[] = ['适应', '全屏', '实际'];
  private readonly MAX_ZOOM: number = 5;
  private readonly DOUBLE_ZOOM: number = 3;

  aboutToAppear(): void {
    const p: PageParams = router.getParams() as PageParams;
    if (p && p.serverUrl && p.serverUrl.length > 0) {
      this.serverUrl = p.serverUrl;
    }
    this.seq = -1;
    this.busy = false;
    this.lastOkMs = Date.now();  // 入场即开始计时, 时间窗内不误报断线
    this.resetRotation();        // 会话级旋转: 每次进入预览页都从 0°(正常设计角度)开始
    this.startPoll();
    const ctx = this.getUIContext().getHostContext();
    if (ctx) {
      try {
        window.getLastWindow(ctx).then((w: window.Window) => {
          this.win = w;
          this.ensureImmersive();
          this.applySystemBars();  // 入场时操作栏可见 -> 系统栏也显示
          // 预览页保持屏幕常亮，避免预览中锁屏
          w.setWindowKeepScreenOn(true).catch(() => {
          });
        }).catch(() => {
        });
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'get window fail: %{public}s', JSON.stringify(e));
      }
    }
  }

  // 页面每次重新显示都被调用(首次进入/从后台切回/被别的页面短暂顶掉后回来)。
  // 幂等地把窗口形态与系统栏状态对齐到"操作栏当前显隐"的应有状态:
  // 上面那些设置只在拿到 window 的那一刻生效一次, 期间若窗口被系统改回非沉浸式,
  // 只靠 aboutToAppear 是补不回来的。
  onPageShow(): void {
    this.ensureImmersive();
    this.applySystemBars();
  }

  aboutToDisappear(): void {
    this.stopPoll();
    // 页面销毁时必须清掉本次新增的两个定时器, 否则旋转动效/超时回调会残留在已销毁的页面上
    this.stopRefreshAnim();
    if (this.refreshTimeoutTimer !== -1) {
      clearTimeout(this.refreshTimeoutTimer);
      this.refreshTimeoutTimer = -1;
    }
    this.refreshing = false;
    this.resetRotation();  // 旋转是会话级状态, 离场即失效
    this.httpReq.destroy();
    if (this.win) {
      this.win.setWindowKeepScreenOn(false).catch(() => {
      });
      // 窗口形态也是预览页专属, 离场必须还原, 否则会连首页一起变成沉浸式
      this.win.setWindowSystemBarEnable(['status', 'navigation']).catch(() => {
      });
      this.win.setWindowLayoutFullScreen(false).catch(() => {
      });
    }
  }

  private startPoll(): void {
    this.pollOnce();
    this.pollTimer = setInterval(() => {
      this.pollOnce();
    }, POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  private pollOnce(): void {
    // 防重入: 上一轮请求还没回来就跳过本轮。固定 600ms 叠加请求会让连接堆积,
    // 失败计数在几百毫秒内连跳 5 次, 把"网络偶发慢一拍"误判成"已与电脑端断开"。
    if (this.busy) {
      return;
    }
    this.busy = true;
    const url: string = `${this.serverUrl}/api/status`;
    this.httpReq.request(url, {
      method: http.RequestMethod.GET,
      connectTimeout: 3000,
      readTimeout: 3000,
      header: { 'Cache-Control': 'no-store' }
    }).then((res: http.HttpResponse) => {
      this.busy = false;
      if (res.responseCode === 200) {
        this.failCnt = 0;
        this.lastOkMs = Date.now();
        const obj: StatusData = JSON.parse(res.result as string) as StatusData;
        this.devName = obj.active_name && obj.active_name.length > 0 ? obj.active_name : obj.name;
        if (obj.active === false) {
          // 电脑端推送已停止 / PS 已关闭: 立即清除残留预览图
          this.imgSrc = '';
          this.statusText = '电脑端已停止推送，请返回重新开启';
          this.resetRotation();  // 断开电脑端服务 -> 旋转作废(会话级状态)
          return;
        }
        if (obj.seq !== this.seq) {
          // ★"重连拉流"识别: imgSrc 为空说明之前根本没画面(断开过/停止过推送),
          //   这次拉到的就是重连后的第一帧 —— 按会话级规则把旋转复位为 0°(正常设计角度)。
          //   正常推送期间 imgSrc 一直非空, 不会被这条误伤, 用户在连着的时候转正的方向不会丢。
          const losingPrevFrame: boolean = this.imgSrc.length === 0;
          this.seq = obj.seq;
          this.lastSeq = obj.seq;
          this.imgSrc = `${this.serverUrl}/latest?ts=${Date.now()}`;
          if (losingPrevFrame) {
            this.resetRotation();
          }
        }
        if (this.imgSrc.length > 0) {
          this.statusText = '已连接 · ' + (this.devName.length > 0 ? this.devName : '等待推送画面');
        }
      } else {
        this.onPollFail('服务响应异常 HTTP ' + res.responseCode);
      }
    }).catch((err: Error) => {
      this.busy = false;
      this.onPollFail('连接失败，请返回首页检查服务器地址');
      hilog.warn(DOMAIN, TAG, 'poll fail: %{public}s', err.message);
    });
  }

  // 探测失败统一处理: 以"距上次成功的时间窗"判定是否真断连,
  // 未超窗只提示瞬时异常, 不清图、不报"已断开"。
  // ★真断连(清图)那一支同时把旋转复位: 断连检测是本任务要求的重置路径之一,
  //   放在"清图"同一分支里, 保证"图没了"与"旋转没了"是同一件事的两个面, 不会各漏一半。
  private onPollFail(msg: string): void {
    this.failCnt += 1;
    if (Date.now() - this.lastOkMs > LOST_MS) {
      this.imgSrc = ''; // 断开后清除残留预览图
      this.statusText = '已与电脑端断开，请返回重新选择源';
      this.resetRotation();  // 断开电脑端服务 -> 旋转作废(会话级状态)
    } else {
      this.statusText = msg;
    }
  }

  /* 切换预览方式: 单按钮循环切换 —— 适应(0) → 全屏(1) → 实际(2) → 适应(0)。
     ★只改渲染参数, 绝不动 imgSrc: 当前帧已经在本机解码好了, 切模式是纯本地重排,
       立即生效; 若顺手重新拉帧, 每点一次都要等一个网络往返, 还会白换一代图。
     ★同时复位 zoom/tx/ty: 三个模式的"基准尺寸"完全不同(适应=塞进屏幕, 全屏=铺满屏幕,
       实际=原图 1:1), 带着上一模式的缩放与位移切过去必然错位 —— 表现为"切到实际后画面
       跑到屏幕外/拖不回来"。复位后每个模式都从自己的基准重新开始, 也顺带避免了旧模式
       残留的缩放状态被下一帧继承。
     ★旋转角 rotateDeg 不在复位之列: 它属于"当前会话的看图方向", 与"用哪种模式看"正交,
       切模式时若把用户转好的方向掰回去, 反而像丢状态。 */
  private cycleFitMode(): void {
    this.setFitMode((this.fitMode + 1) % this.fitLabels.length);
  }

  private setFitMode(mode: number): void {
    if (mode === this.fitMode) {
      return;
    }
    this.fitMode = mode;
    this.zoom = 1;
    this.zoomBase = 1;   // 缩放基准跟着复位, 否则下一次捏合会以旧模式的基准起算, 一捏就跳
    this.tx = 0;
    this.ty = 0;
  }

  private goBack(): void {
    router.back();
  }

  // 强制刷新：立即重新拉取最新一帧。
  // 防连点: 正在刷新时直接忽略后续点击(复用同一次刷新), 避免叠加多个旋转定时器与多次提示。
  private forceRefresh(): void {
    if (this.serverUrl.length === 0) {
      return;
    }
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    this.startRefreshAnim();
    this.refreshTimeoutTimer = setTimeout(() => {
      this.refreshTimeoutTimer = -1;
      // 超时兜底: 新帧迟迟没加载完成时强制收尾(停转 + 失败提示)。
      // 另外, 主动刷新期间若服务端返回 active=false, imgSrc 会被清空、Image 不再渲染,
      // onComplete 永远不会触发, 只能依赖这条超时路径把状态收回来。
      this.endRefresh('刷新超时，请检查连接');
    }, REFRESH_TIMEOUT_MS);
    this.imgSrc = `${this.serverUrl}/latest?ts=${Date.now()}`;
  }

  // 启动旋转动效: 定时器累加角度, 实现持续旋转
  private startRefreshAnim(): void {
    this.stopRefreshAnim();
    this.refreshAngle = 0;
    this.refreshAngleTimer = setInterval(() => {
      this.refreshAngle = (this.refreshAngle + REFRESH_STEP_DEG) % 360;
    }, REFRESH_TICK_MS);
  }

  // 停止旋转动效: 清定时器并复位角度, 保证"能停、不残留"
  private stopRefreshAnim(): void {
    if (this.refreshAngleTimer !== -1) {
      clearInterval(this.refreshAngleTimer);
      this.refreshAngleTimer = -1;
    }
    this.refreshAngle = 0;
  }

  // 手动刷新统一收尾: 停转 + 清超时定时器 + 弹结果提示。
  // refreshing 作为去重守卫: 成功(onComplete)与失败(超时)谁先到谁生效, 只提示一次。
  private endRefresh(msg: string): void {
    if (!this.refreshing) {
      return;
    }
    if (this.refreshTimeoutTimer !== -1) {
      clearTimeout(this.refreshTimeoutTimer);
      this.refreshTimeoutTimer = -1;
    }
    this.stopRefreshAnim();
    this.refreshing = false;
    promptAction.showToast({
      message: msg,
      duration: 1200
    });
  }

  // 新帧加载完成回调。注意: 该回调不只在手动刷新时触发, 600ms 轮询换源同样会触发,
  // 所以必须用 refreshing 守卫, 只在"本次手动刷新中"才提示"刷新成功", 否则日常轮询会不断弹 toast。
  // ★顺带在此记录原图像素尺寸(event.width/height, 单位 px): "实际"模式要按它做 1:1
  //   换算, 拖拽边界也要按它算。尺寸相同就不写(赋值同值不会触发重渲染, 这里显式判一下,
  //   轮询每帧都回调, 没必要让它每次都走一遍状态变更)。
  //   与 refreshing 收尾相互独立: 就算这次不是手动刷新, 尺寸也照样要记。
  private onFrameLoaded(event?: FrameLoadEvent): void {
    if (event && event.width > 0 && event.height > 0) {
      /* ★为什么加"变化超过 2% 才认"的容差(而不是"不等就写"):
         本回调由 600ms 轮询换源驱动, 每帧都会进来一次。实际模式的内容尺寸直接等于
         px2vp(naturalW/naturalH), 只要每帧回调带回来 1~2px 的抖动(编码器/服务端缩放取整
         都会产生), 照单全收就会让画面【跟着每帧一涨一缩】—— 拖动时看起来就是"忽大忽小、反复横跳"。
         真正换了尺寸(用户改了画板大小、服务端换了传输档)必然远超 2%, 照旧立即跟随, 不会漏更新。 */
      const first: boolean = this.naturalW <= 0 || this.naturalH <= 0;
      const dw: number = first ? 1
        : Math.abs(event.width - this.naturalW) / Math.max(event.width, this.naturalW);
      const dh: number = first ? 1
        : Math.abs(event.height - this.naturalH) / Math.max(event.height, this.naturalH);
      if (dw > 0.02 || dh > 0.02) {
        this.naturalW = event.width;
        this.naturalH = event.height;
        // 原图尺寸变化会改变各模式的内容尺寸与拖拽边界(实际模式尤其明显:
        // 内容从"视口大小"变成"原图 1:1"), 旧的位移可能越界, 立即按新边界收回。
        this.clampPan();
      }
    }
    if (!this.refreshing) {
      return;
    }
    this.endRefresh('刷新成功');
  }

  /* ---------- 预览几何: 模式适配 / 旋转 / "实际(1:1 物理像素)"的换算与边界 ----------
     单位口径(本工程踩过坑, 这里写死):
       · event.width/height(Image.onComplete) = 图像源【像素 px】
       · px2vp() 是 px -> vp 的唯一正路(vp = 物理像素 / 屏幕密度)
       · onAreaChange 的 Area 与 PanGestureEvent.offsetX/Y 在本 SDK 里本来就是 vp,
         直接当 vp 用, 不要再换 —— 真正需要换算的只有"原图像素尺寸"这一处。
     旧写法只有一个 drawnW()/drawnH() 口径, 既当"实际模式换算基准"又当"拖拽边界基准"; 加了旋转
     之后必须拆成三层, 否则"宽高到底换没换"根本说不清:
       · rawW()/rawH()  : 框架按 objectFit 真正画出来的内容尺寸(vp, 不含任何 scale)
       · contentW/H()   : 本模式期望的【未旋转时】内容尺寸(vp, 不含用户 zoom)
       · visualW/H()    : 用户最终"看到"的可视占位(vp, 含用户 zoom 与旋转造成的宽高互换)
     组件上的 .scale() = zoom × baseScale(), 其中 baseScale() 把 raw 放大到 content。
     这样"实际模式 1:1"与"旋转后按真实占位算边界"两件事互不打架。 */

  // 当前帧宽高比(用原图像素算, 比值无量纲, 与单位无关); 尺寸未知时返回 0 = "算不出来"
  private frameAspect(): number {
    return (this.naturalW > 0 && this.naturalH > 0) ? this.naturalW / this.naturalH : 0;
  }

  // 是否处于"内容与视口宽高互换"的旋转角(90°/270°)。
  // 全文件只在这里判断一次语义, 避免宽高互换散落到各处各判一遍(那是这类改动最容易出错的地方)。
  private rotSwap(): boolean {
    return this.rotateDeg === 90 || this.rotateDeg === 270;
  }

  // (已删除 rawW()/rawH(): 那两个函数只服务于"让 objectFit 先画、再用 scale 补差"的旧方案,
  //  现在内容尺寸直接由 contentW()/contentH() 给到 Image, 不再需要"框架绘制尺寸"这一层口径。)

  // 本模式期望的"未旋转时"内容尺寸(vp, 不含用户 zoom)。
  // ★这两个值现在【直接作为 Image 组件的宽高】(build 里 .width(contentW()).height(contentH())),
  //   不再经过 objectFit 的中转 —— 内容真实占用多少尺寸, 组件就是多少尺寸, 边界也按它算。
  // 适应/全屏: 目标是"按【旋转后的图】重新等比适配屏幕"。旋转 90°(270°)后可视占位的宽高是互换的,
  //   把它代回适配公式解一下, 结果恰好等价于"把视口宽高也对调, 再套原来的 Contain/Cover 公式" ——
  //   所以旋转 90/270 时这里对调 viewW/viewH。旋转 0/180 时退化为原式子, 与改动前完全一致。
  // 实际: 原图物理像素 1:1(px2vp 已把 px 消化成 vp)。★与旋转角无关 —— 旋转只是把画面转过去,
  //   物理像素到 vp 的映射并没有变, 所以"旋转后 1:1 依然成立"是这个定义的直接推论, 不需要额外补偿。
  private contentW(): number {
    const a: number = this.frameAspect();
    if (this.fitMode === FIT_ACTUAL) {
      return (a > 0 && this.naturalW > 0) ? px2vp(this.naturalW) : this.viewW;
    }
    if (a <= 0) {
      return this.viewW;
    }
    const vw: number = this.rotSwap() ? this.viewH : this.viewW;
    const vh: number = this.rotSwap() ? this.viewW : this.viewH;
    return this.fitMode === FIT_FILL ? Math.max(vw, vh * a) : Math.min(vw, vh * a);
  }

  private contentH(): number {
    const a: number = this.frameAspect();
    if (this.fitMode === FIT_ACTUAL) {
      return (a > 0 && this.naturalH > 0) ? px2vp(this.naturalH) : this.viewH;
    }
    if (a <= 0) {
      return this.viewH;
    }
    const vw: number = this.rotSwap() ? this.viewH : this.viewW;
    const vh: number = this.rotSwap() ? this.viewW : this.viewH;
    return this.fitMode === FIT_FILL ? Math.max(vh, vw / a) : Math.min(vh, vw / a);
  }

  /* (已删除 baseScale()/totalScale(): 
     旧方案是"让 objectFit(Contain/Cover) 先把内容画进 100%×100% 的盒子里, 再用 scale 补一个系数
     把画面放大到本模式期望的尺寸"。这个'画一次、再缩一次'的两段式正是黑块与尺寸跳变的来源:
       · Cover 那一遍已经把溢出内容裁掉了, 后面的 scale 只能把"裁过的结果"放大, 裁掉的部分永远补不回来;
       · 实际模式下 baseScale 与拖拽边界各按一套尺寸口径算, 拖动时"能拖的范围"和"看得见的内容"对不上。
     现在内容尺寸一步到位(contentW()/contentH() 直接设成 Image 宽高), 组件上的缩放只剩"用户捏合倍数"
     zoom 这一个来源 —— 基准系数恒为 1, 不再需要换算。 */

  // 内容节点上的缩放系数 = 用户捏合倍数(唯一来源, 不再有模式基准系数)。
  private totalScale(): number {
    return this.zoom;
  }

  // 内容在屏幕上最终占用的可视尺寸(vp, 含用户 zoom, 含旋转造成的宽高互换)。
  // ★拖拽边界必须按这个尺寸算: 旋转 90°/270° 时"看得见的宽"其实是 contentH,
  //   维度用错会让画面能拖出屏幕, 或明明溢出了却拖不动。
  private visualW(): number {
    return (this.rotSwap() ? this.contentH() : this.contentW()) * this.zoom;
  }

  private visualH(): number {
    return (this.rotSwap() ? this.contentW() : this.contentH()) * this.zoom;
  }

  // 内容是否已经超出视口(有可拖动的余地)。
  // ★不能用旧的 zoom > 1 当门槛: "实际"模式下即使一次都没捏合, 大图本身就已经
  //   远超屏幕(2560px 宽的稿子约是屏宽数倍), 必须能直接拖。
  private canPan(): boolean {
    return (this.visualW() > this.viewW + 0.5) || (this.visualH() > this.viewH + 0.5);
  }

  // 点画面: 操作栏与系统栏(状态栏/导航栏)一起显隐, 做到真正的全屏沉浸预览。
  // ★只切"栏的显隐", 不动窗口布局模式 —— 画面尺寸完全不变, 所以不会出现上下位移。
  private toggleControls(): void {
    this.controlsVisible = !this.controlsVisible;
    this.applySystemBars();
    if (!this.controlsVisible) {
      promptAction.showToast({
        message: '轻点屏幕显示操作栏',
        duration: 1200
      });
    }
  }

  /* 申明"常驻沉浸式布局"窗口形态(幂等, 可反复调)。
     ★画面位移的根因与对策: 上一轮是【跟着显隐切换窗口布局模式】—— 一开一关之间,
       页面可视高度会跟着状态栏高度 ±S 变化, 整页(含画面)被重新布局, 用户看到的就是
       "点一下、画面上下跳一下"。这里改成【只设一次 true、之后永不切换】:
       页面 100%×100% 恒等于整个窗口(含状态栏所在的顶部区域), 系统栏显隐只决定
       "那层栏在不在", 不改变任何布局尺寸 —— 于是"真隐藏状态栏"与"画面不动"可以兼得。
     顺带在这里缓存状态栏高度(vp): getWindowAvoidArea 的 Rect 单位是【px】(SDK 注明),
       必须 px2vp 换算后才能当 vp 内边距用; 只取一次、不随显隐重查(操作栏位置才不跳)。 */
  private ensureImmersive(): void {
    const w: window.Window | null = this.win;
    if (!w) {
      return;
    }
    const area: window.AvoidArea = w.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
    this.statusBarTop = area.topRect.height > 0 ? px2vp(area.topRect.height) : 0;
    w.setWindowLayoutFullScreen(true).catch(() => {
    });
  }

  // 系统栏(状态栏 + 导航栏)显隐: 与操作栏同进同出。
  // 隐藏走空数组(= 一个系统栏都不启用), 恢复时按名字启用; 全程不改窗口布局模式。
  // ★这是本页唯一会改系统栏显隐的地方, 只动"栏", 不动窗口布局 —— 画面绝对不位移。
  private applySystemBars(): void {
    const w: window.Window | null = this.win;
    if (!w) {
      return;
    }
    const show: Array<'status' | 'navigation'> = ['status', 'navigation'];
    const hide: Array<'status' | 'navigation'> = [];
    w.setWindowSystemBarEnable(this.controlsVisible ? show : hide).catch(() => {
    });
  }

  private onPinchStart(): void {
    this.pinching = true;
    this.lastPinchScale = -1;   // 重新建立基线: 首个 update 只对齐基准, 不动画面
    this.lastPinchMs = Date.now();
    this.zoomBase = this.zoom;
  }

  /* 双指捏合: 按【逐帧增量比率】推进缩放。
     ★为什么不再用 zoomBase × pe.scale(旧写法, 也是"拖动/捏合时忽大忽小"的根子):
       pe.scale 是"相对本次手势起点"的累计值, 只有一个基准。一旦这个基准不可靠 ——
       手势被系统重新识别/归一化(pe.scale 悄悄跳回 1)、或 onActionStart 与首个 update 之间
       手指已经移动了一段(第一帧就带着一个较大的 pe.scale 进来) —— 用累计值算出的 zoom 会
       瞬间跳到与当前画面无关的值, 表现为"突然变大→又恢复→再变大"的反复横跳。
     增量写法只吃"本帧新增的比例": zoom ← zoom × (本帧比例 ÷ 上一帧比例), 基准每帧对齐当前值,
       中途被任何方式打断都只是"这一帧不缩放", 不会有补偿式跳变。
     突变保护: 单帧比例变化超过 25%(×1.25 / ×0.8)不可能是手指做出来的, 判定为手势被重新归一化,
       仅重建基线、本帧不动画面。
     ★与旋转的关系: 这里不再因"本次手势要旋转"而冻结缩放 —— 基准每帧对齐当前值,
       旋转改变了内容尺寸也不会让后续捏合"接着按旧基准乘", 所以可以边转边缩。 */
  private onPinchUpdate(event: GestureEvent): void {
    const pe: PinchGestureEvent = event as PinchGestureEvent;
    const s: number = pe.scale;
    if (!(s > 0)) {
      return;   // 非法比例(框架异常值): 直接忽略
    }
    this.lastPinchMs = Date.now();
    if (this.lastPinchScale <= 0) {
      this.lastPinchScale = s;   // 首个 update: 只建基线, 不动画面
      return;
    }
    const ratio: number = s / this.lastPinchScale;
    if (ratio > 1.25 || ratio < 0.8) {
      this.lastPinchScale = s;   // 单帧突变 -> 判定为重新归一化, 重建基线
      return;
    }
    this.lastPinchScale = s;
    const nz: number = Math.max(1, Math.min(this.MAX_ZOOM, this.zoom * ratio));
    if (nz === this.zoom) {
      return;   // 值没变(例如已到上下限还继续捏)就不刷新状态, 避免无谓重渲染
    }
    this.zoom = nz;
    this.clampPan();
  }

  private onPinchEnd(): void {
    this.pinching = false;
    this.lastPinchScale = -1;
    this.lastPinchMs = Date.now();
    this.zoomBase = this.zoom;   // 收尾对齐基准: 下一次捏合从当前大小起算
    this.clampPan();
  }

  private onDoubleTap(): void {
    /* ★防误触(这是"拖动时画面突然放大又恢复"的另一条路径):
       拖动结束后手很容易顺势再点两下, 这两下会被 TapGesture(count:2) 收成一次双击,
       双击直接把 zoom 从 1 翻到 3(或反过来) —— 用户看到的就是"拖一下画面突然变大, 再动一下又变回去"。
       刚真的拖动过(位移 > 2vp)则本次双击不生效, 从源头掐掉这条误触发路径。 */
    if (Date.now() - this.lastPanMs < 500) {
      return;
    }
    // 是否"已放大"只看用户叠加的缩放(zoom), 不看总变换 —— 内容尺寸现在直接由模式决定,
    // zoom=1 就是"本模式的原始大小"(实际模式下即原图 1:1)。
    if (this.zoom > 1.01) {
      this.zoom = 1;
      this.tx = 0;
      this.ty = 0;
    } else {
      this.zoom = this.DOUBLE_ZOOM;
      this.tx = 0;
      this.ty = 0;
    }
    this.zoomBase = this.zoom;   // 双击改了缩放, 基准同步, 避免下一次捏合一上来就跳
    // 双击不隐藏操作栏
    this.controlsVisible = true;
    this.applySystemBars();
  }

  private onPanStart(): void {
    // 单指落下 = 新一次拖动开始: 若上一次双指手势的标志因系统没回调 end 而残留,
    // 这里按时间兜底清掉(超过 600ms 没有新的捏合/旋转事件即认定为残留),
    // 否则残留标志会让整段拖动被吃掉, 表现为"拖不动"。
    const now: number = Date.now();
    if (this.pinching && now - this.lastPinchMs > 600) {
      this.pinching = false;
      this.lastPinchScale = -1;
    }
    if (this.rotating && now - this.lastRotateMs > 600) {
      this.rotating = false;
    }
    this.panBaseX = this.tx;
    this.panBaseY = this.ty;
    this.lastPanX = 0;
    this.lastPanY = 0;
  }

  /* 单指拖动: 按【增量】推进, 而不是"基准 + 累计偏移"。
   ★为什么改用增量(这是"拖动时画面突然放大/位置乱跳"的另一个来源):
     旧写法每帧都用 tx = panBase + offset, 而 offset 是相对手势起点的累计值。一旦中途有
     另一个手势插进来(双指捏合)或某几帧被跳过, 累计值里就含了"不该由平移负责"的位移,
     下一次继续拖动时会被一次性补上, 看起来就是画面突然跳/突然变大。
     增量写法只吃"本帧新增的位移", 双指期间的新增位移直接丢弃(记录偏移但不应用),
     松指后从当前画面继续拖, 不会有任何补偿式跳变。 */
  private onPanUpdate(event: GestureEvent): void {
    const pe: PanGestureEvent = event as PanGestureEvent;
    if (this.pinching || this.rotating) {
      // 双指手势(捏合/旋转)进行中: 本次不移动画面, 但要记住当前偏移,
      // 让这段位移被"吃掉" —— 否则手势结束后的第一帧会把双指期间的手部位移一次性补上。
      this.lastPanX = pe.offsetX;
      this.lastPanY = pe.offsetY;
      // 时间兜底: 超过 600ms 没有新的捏合/旋转事件, 说明上次双指手势的 end 没回调(标志残留),
      // 就地清掉 —— 否则残留标志会把整段单指拖动一直吃掉(表现为"拖不动")。
      const nowMs: number = Date.now();
      if (this.pinching && nowMs - this.lastPinchMs > 600) {
        this.pinching = false;
        this.lastPinchScale = -1;
      }
      if (this.rotating && nowMs - this.lastRotateMs > 600) {
        this.rotating = false;
      }
      return;
    }
    if (!this.canPan()) {
      // 内容没超出视口: 拖动没有意义(拖也只会拖出空白), 拦住并同步偏移基准
      this.lastPanX = pe.offsetX;
      this.lastPanY = pe.offsetY;
      return;
    }
    // offsetX/offsetY 在本 SDK 里单位已是 vp, 与 tx/ty 同量纲, 直接累加即可(不要再换算)
    const dx: number = pe.offsetX - this.lastPanX;
    const dy: number = pe.offsetY - this.lastPanY;
    this.lastPanX = pe.offsetX;
    this.lastPanY = pe.offsetY;
    if (dx * dx + dy * dy > 4) {
      // 位移超过 2vp 才算"真的拖了画面": 只记这种, 双击的两次轻点(几乎没有位移)不会把自己挡掉
      this.lastPanMs = Date.now();
    }
    this.tx = this.tx + dx;
    this.ty = this.ty + dy;
    this.clampPan();
  }

  private clampPan(): void {
    if (!this.canPan()) {
      this.tx = 0;
      this.ty = 0;
      return;
    }
    // 内容在屏幕上的可视占位(vp): visualW()/visualH() 已经把"模式基准 × 用户 zoom ×
    // 旋转带来的宽高互换"全部算进去了, 这里不能再自己乘一次 scale(旧写法乘的就是这个坑)。
    /* 边界 = 内容超出视口的那部分的一半。
       推导: 内容居中, 且缩放中心/旋转中心都在中心(组件是整屏的 100%×100%, 其中心即屏幕中心),
       可拖到"某一侧边缘贴住视口边缘"为止, 此时平移量 = (内容可视尺寸 - 视口尺寸) / 2。
       ★旧式子是 viewW*(zoom-1)/2 —— 它默认"内容宽度 = 视口宽度、且缩放中心在中心",
       只有在"适应模式下内容刚好铺满视口"时才成立:
         · 实际模式(内容远大于视口): 旧式子的 maxX 会大出好几倍, 画面能被拖飞、
           拖出大片空白; 而 zoom=1 时旧式子直接给 0, 又完全拖不动 —— 两头都错。
         · 适应模式窄图(内容比视口窄): 旧式子仍按 viewW 给边界, 允许把画面拖出留白。
         · 全屏(Cover)/旋转 90°/270°: 可视宽高与视口都不相等, 旧式子更无从谈起。
       新式子统一按真实可视占位算; 内容没超出时 maxX=maxY=0, 自动归零, 不会出现 NaN。 */
    const maxX: number = Math.max(0, (this.visualW() - this.viewW) / 2);
    const maxY: number = Math.max(0, (this.visualH() - this.viewH) / 2);
    this.tx = Math.max(-maxX, Math.min(maxX, this.tx));
    this.ty = Math.max(-maxY, Math.min(maxY, this.ty));
  }

  /* ---------- 会话级旋转: 双指捏合步进 90°, 一次手势只跳一步 ---------- */

  // 旋转归零。断连、重连、重开 App、重新进入本页都必须回到"正常设计角度"。
  // ★集中成一个方法, 所有需要重置的地方都调它, 避免"只在某个分支生效"。
  private resetRotation(): void {
    this.rotateDeg = 0;
    this.rotFired = false;
    this.rotating = false;   // 顺带解锁互斥标志, 避免重置后手势被残留状态卡住
    this.clampPan();  // 0° 与 90/270° 的可视占位不一样, 复位后顺手把位移收回合法范围
  }

  private onRotateStart(): void {
    // 新手势: 解锁步进。角度本身由 RotationGesture 从本次手势的起始线重新算起。
    this.rotFired = false;
    this.rotating = false;
    this.lastRotateMs = Date.now();
  }

  private onRotateUpdate(event: GestureEvent): void {
    this.lastRotateMs = Date.now();
    if (this.rotFired) {
      return;  // 一次手势只步进一步: 余下的角度一律忽略, 免得在一个长手势里连跳 90°→180°→270°
    }
    /* ★这里曾有一道"本次手势已经发生明显缩放就不再判旋转"的闸门(pinchMoved), 已删除:
       双指旋转时两指间距必然变化, Pinch 一定会先置位, 那道闸门等于把旋转整个屏蔽 ——
       真机反馈就是"旋转没了, 完全转不动"。
       现在缩放与旋转各自独立推进(旋转只看 60° 角度阈值、一次手势一步; 缩放走逐帧增量比率),
       两者不会再互相掐掉, 也不会再出现两套基准来回跳的横跳。 */
    const re: RotationGestureEvent = event as RotationGestureEvent;
    const a: number = re.angle * ROT_DIR_SIGN;
    if (a >= ROT_TRIGGER_DEG) {
      this.stepRotate(1);    // 顺时针捏合 -> 顺时针转 90°
    } else if (a <= -ROT_TRIGGER_DEG) {
      this.stepRotate(-1);   // 逆时针捏合 -> 逆时针转 90°
    }
  }

  private onRotateEnd(): void {
    this.rotFired = false;   // 手势结束, 下一次捏合可以再步进一步
    this.rotating = false;   // 解除"本次触摸正在旋转"的标记, 单指平移恢复响应
    this.lastRotateMs = Date.now();
  }

  // 步进一步(±90°)。累积取模, 角度只会在 0/90/180/270 之间循环。
  // 旋转后可视占位的宽高互换, 旧位移可能越界, 立即 clampPan() 按新边界收回。
  private stepRotate(dir: number): void {
    this.rotFired = true;
    this.lastRotateMs = Date.now();
    // 标记"本次触摸正在旋转": 旋转期间挡掉单指平移(平移的边界基准正随旋转改变)。
    // ★不再冻结缩放: 缩放已改成逐帧增量比率、基准每帧对齐当前值, 旋转改变内容尺寸
    //   也不会让后续捏合"接着按旧基准乘"(那才是旧版横跳的机制), 因此可以边转边继续缩放。
    this.rotating = true;
    this.zoomBase = this.zoom;   // 基准同步到当前值
    this.rotateDeg = ((this.rotateDeg + dir * 90) % 360 + 360) % 360;
    this.clampPan();
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      // 画面层：铺满整页，显示/隐藏操作栏不影响画面区域
      if (this.imgSrc.length > 0) {
        /* ★为什么把"平移"单独拆到外层节点: translate 在 SDK 里被定义为"组件自身坐标系内的位移",
           而组件此刻同时挂着 rotate/scale —— 到底是"先转后移(位移被一起转过去)"还是
           "先移后转(位移就是屏幕方向)", 取决于框架内部矩阵的合成顺序, 属未文档化行为。
           一旦位移跟着旋转走, 转了 90° 后手指往右拖画面会上下跑, 与 clampPan 按屏幕方向
           算出来的边界对不上。拆两层后歧义被彻底消除:
             · 内层只挂 rotate + 等比 scale: 两者都绕同一个中心(组件中心 = 屏幕中心),
               等比缩放与旋转可交换次序, 谁先谁后结果都一样 —— 无歧义;
             · 外层不挂任何旋转, 它的 translate 就是纯粹的屏幕系平移 —— 无歧义。
           内外层依旧分工明确: 外层 100%×100% 只管屏幕系平移; 内层 100%×100% 只作为"居中容器",
           真正决定画面大小的是它里面的 Image 自身尺寸(contentW × contentH)。 */
        // ★对齐方式必须显式给 Center: 内层 Stack 仍是 100%×100%, 而 Image 现在不再是
        //   100%×100%, 而是"内容自己的尺寸"。缺省对齐会把它摆到角上, 而 clampPan 的边界
        //   公式是按"内容居中于视口、缩放/旋转中心即屏幕中心"推导的 —— 居中是这套几何的前提。
        Stack({ alignContent: Alignment.Center }) {
          Image(this.imgSrc)
            /* ★★尺寸直接给"内容尺寸"(contentW/contentH, 单位 vp), 而不是 100%×100%:
               全屏模式的内容比屏幕大(长边溢出)、实际模式的大图更远超屏幕 —— 这两种情况都必须
               "组件本身就那么大", 否则框架只会在 100%×100% 的盒子里作画, 溢出的部分被裁掉,
               拖到头就把裁过的盒子边缘露出来(用户截图的左右黑块), 而裁掉的内容永远看不到。
               尺寸已由 contentW()/contentH() 按原图宽高比算好, 所以下面用 Fill 铺满自己的盒子
               就是等比显示, 不会变形。 */
            .width(this.contentW())
            .height(this.contentH())
            /* 尺寸已按原图宽高比算好 -> Fill 铺满自己的盒子即等比显示。
               ★例外(首帧保护): 原图尺寸还没回来(naturalW/H=0)时 contentW/H 退化为视口尺寸,
                 此时若用 Fill 会把图拉伸成屏幕比例(短暂变形), 所以这一小段窗口退回 Contain,
                 让框架自己按比例居中显示; 拿到尺寸后立即切回 Fill(实参一帧内即可更新)。 */
            .objectFit(this.frameAspect() > 0 ? ImageFit.Fill : ImageFit.Contain)
            // ★清晰度修复: 源帧已是设计稿原始像素, 端侧只剩"缩到屏幕"这一步。
            // 默认插值档偏"省算力", 大图缩到手机屏时边缘会出现锯齿/发虚, 把上游给足的
            // 清晰度又丢回去。High(高质量插值)让缩放这一步不吃掉细节; 帧大、缩得狠时
            // 收益最明显。端侧没有 inSampleSize/固定像素上限之类的主动降采样, 无需放宽。
            .interpolation(ImageInterpolation.High)
            /* ★缩放系数 = 用户捏合倍数(zoom), 唯一来源。
               旧写法这里是"用户缩放 × 模式基准系数", 模式基准负责把已按 objectFit 画好的内容
               再换算成"实际 1:1"或"旋转后重新适配"的尺寸 —— 那套两段式(先画再缩)带来三个毛病:
               溢出内容被前一段裁掉、缩放基准被外部事件(旋转/模式切换)改变而不同步、
               拖动边界与实际渲染尺寸对不上。现在内容尺寸一步到位, 缩放只剩用户这一个来源。
               scale 的缩放中心是组件中心 —— clampPan 的边界推导正是按中心缩放来的,
               两边必须配套(改成 .scale({centerX/centerY}) 就要同步改边界公式)。 */
            .scale({ x: this.totalScale(), y: this.totalScale() })
            /* ★旋转与缩放同挂在"内层"这一层: 组件是整屏 100%×100%, 其中心既是缩放中心
               也是旋转中心(都是屏幕中心), 绕同一点旋转不会给画面带来额外平移(无需位移补偿),
               clampPan 按"内容居中"推导的边界公式依然成立。
               rotateDeg 只会在 0/90/180/270 之间取整循环(见 stepRotate)。
               注意: 本行列的是渲染角度, 不存在隐式动画。 */
            .rotate({ angle: this.rotateDeg })
            .onComplete((event?: FrameLoadEvent) => {
              // 仅手动刷新期间会真正收尾(内部有 refreshing 守卫), 轮询换源不会弹提示;
              // 尺寸记录则每次回调都做
              this.onFrameLoaded(event);
            })
            .onError(() => {
              // 手动刷新期间加载失败立即收尾, 不必干等 5s 超时; 非刷新期间无副作用
              this.endRefresh('刷新失败，请检查连接');
            })
        }
        .width('100%')
        .height('100%')
        /* 显式声明不裁剪: Image 的尺寸就是内容尺寸, 全屏/实际模式下会比这层 100%×100% 的容器大,
           溢出部分是"用户要拖出来看的内容", 必须允许画到容器外(默认即不裁剪, 这里写明防后人误加 clip)。 */
        .clip(false)
        .translate({ x: this.tx, y: this.ty })
      } else {
        Column({ space: 12 }) {
          Text('棱镜')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor('#1DE9B6')
          Text(this.statusText)
            .fontSize(13)
            .fontColor('#78909C')
            .textAlign(TextAlign.Center)
            .padding({ left: 24, right: 24 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }

      // 手势层：单击切栏 / 双击缩放 / 捏合缩放 / 放大后拖动 / 双指捏合旋转
      Column()
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.toggleControls();
        })
        .onAreaChange((oldValue: Area, newValue: Area) => {
          this.viewW = newValue.width as number;
          this.viewH = newValue.height as number;
        })
        /* ★注：所有手势都挂在这一层(而不是 Image 上), 因为页面是常驻沉浸式布局,
           这一层 100%×100% 恒等于整个窗口 —— 状态栏显隐不会改变它的尺寸(getAreaChange
           拿到的 viewW/viewH 恒定), 画面与边界计算都不会被系统栏显隐带着走。 */
        .gesture(
          GestureGroup(GestureMode.Parallel,
            PinchGesture({ fingers: 2 })
              .onActionStart(() => {
                this.onPinchStart();
              })
              .onActionUpdate((event: GestureEvent) => {
                this.onPinchUpdate(event);
              })
              .onActionEnd(() => {
                this.onPinchEnd();
              }),
            /* 双指捏合旋转: 与 PinchGesture 同属双指手势, 放在 Parallel 组里两者可同时识别
               —— "边缩放边转"不会互相吞手势。方向由捏合角度的正负决定, 一次手势只步进 90°
               (rotFired 守卫), 多次捏合累积。 */
            RotationGesture({ fingers: 2 })
              .onActionStart(() => {
                this.onRotateStart();
              })
              .onActionUpdate((event: GestureEvent) => {
                this.onRotateUpdate(event);
              })
              .onActionEnd(() => {
                this.onRotateEnd();
              }),
            TapGesture({ count: 2 })
              .onAction(() => {
                this.onDoubleTap();
              }),
            PanGesture({ fingers: 1, direction: PanDirection.All })
              .onActionStart(() => {
                this.onPanStart();
              })
              .onActionUpdate((event: GestureEvent) => {
                this.onPanUpdate(event);
              })
          )
        )

      // 顶部半透明操作栏（悬浮于画面之上，不占布局）
      if (this.controlsVisible) {
        Row({ space: 10 }) {
          // 返回图标
          Text('‹')
            .fontSize(26)
            .fontColor('#ECEFF1')
            .width(38)
            .height(38)
            .textAlign(TextAlign.Center)
            .backgroundColor('#33000000')
            .borderRadius(19)
            .onClick(() => {
              this.goBack();
            })

          // 连接状态：主题色圆点 + 小字
          Row({ space: 5 }) {
            Column()
              .width(6)
              .height(6)
              .borderRadius(3)
              .backgroundColor('#1DE9B6')
            Text(this.statusText)
              .fontSize(10)
              .fontColor('#9AA7B4')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)

          /* 视图模式: 单按钮循环切换(适应 → 全屏 → 实际 → 适应)。
             ★从"三个并列标签"回退为单按钮, 就是把上一轮被吃掉的那段宽度还给标题/状态区:
               三个标签常驻时, Row 里的状态文字被挤到 layoutWeight(1) 的缝里, 长状态文本
               直接被省略号截断, 观感上等于"标题没了"。单按钮只占一个标签的宽度, 状态文字
               的可用宽度恢复到改动前的水平。
             字号/字色/内边距/底色/圆角全部沿用原来的单标签样式, 不改视觉语言;
             文案仍是当前模式名, 点一下切下一个。
             ★仍用 Text 而不是 Button: Button 组件(即便 ButtonType.Normal)带有主题默认高度
               40vp, 在操作栏里会比原来的标签明显高一截, 把整条栏撑胖 —— 那就不是"回退"了。
               Text 的尺寸完全由字号+内边距决定, 与原样式逐参数一致。 */
          Text(this.fitLabels[this.fitMode])
            .fontSize(11)
            .fontColor('#1DE9B6')
            .padding({ left: 12, right: 12, top: 5, bottom: 5 })
            .backgroundColor('#261DE9B6')
            .borderRadius(14)
            .onClick(() => {
              this.cycleFitMode();
            })

          // 刷新图标（刷新中按 refreshAngle 持续旋转）
          Text('⟳')
            .fontSize(22)
            .fontColor('#ECEFF1')
            .width(38)
            .height(38)
            .textAlign(TextAlign.Center)
            .backgroundColor('#33000000')
            .borderRadius(19)
            .rotate({ angle: this.refreshAngle })
            .onClick(() => {
              this.forceRefresh();
            })
        }
        .width('100%')
        /* ★上边距 = 状态栏高度 + 原来的 10vp。页面是常驻沉浸式布局(见 aboutToAppear 的说明),
           操作栏从屏幕最顶端开始排, 不补这一段就会与状态栏(时间/电量)叠在一起。
           这里用的是入场时缓存的 statusBarTop(vp), 不再随显隐变 —— 操作栏位置固定, 不会跳。 */
        .padding({ left: 12, right: 12, top: this.statusBarTop + 10, bottom: 10 })
        .backgroundColor('#5510161D')
        .onClick(() => {
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#05070A')
  }
}

