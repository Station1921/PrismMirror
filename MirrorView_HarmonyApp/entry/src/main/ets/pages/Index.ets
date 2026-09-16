import { http, socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { wifiManager } from '@kit.ConnectivityKit';
import { router, window, promptAction, display } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';

const DOMAIN: number = 0x0000;
const TAG: string = 'MirrorView';
const POLL_MS: number = 1500;
const UDP_PORT: number = 8787;
const BEACON_LIMIT_MS: number = 10000;
// HTTP 轮询失败的容忍期: 期间仍收到 beacon/近期成功过则保持在线, 避免单次抖动闪"离线"
const OFFLINE_GRACE_MS: number = 5000;
const DEFAULT_KEY: string = '192.168.1.27:8765';
const DEFAULT_PORT: number = 8765;

interface StatusData {
  seq: number;
  ts: number;
  name: string;
  mode: string;
  port: number;
  active?: boolean;
  active_name?: string;
  ip?: string;
  host?: string;
}

interface BeaconData {
  type?: string;
  host?: string;
  ip?: string;
  port?: number;
  seq?: number;
  active?: boolean;
  name?: string;
  active_name?: string;
}

interface SourceInfo {
  key: string;
  ip: string;
  port: number;
  host: string;
  active: boolean;
  reachable: boolean;
  name: string;
  devMode: string;
  lastSeq: number;
  manual: boolean;
  lastSeen: number;
  // 最近一次 HTTP /api/status 探测成功的时间戳(ms), 0 表示从未成功
  lastOk: number;
}

@CustomDialog
struct AddressDialog {
  controller?: CustomDialogController;
  url: string = '';
  onOk: (v: string) => void = (v: string) => {};
  @State val: string = '';

  aboutToAppear(): void {
    this.val = this.url;
  }

  build() {
    Column({ space: 14 }) {
      Text('Wi-Fi 直连电脑端')
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor('#ECEFF1')
      TextInput({ placeholder: '192.168.1.100:8765', text: this.val })
        .width('100%')
        .height(46)
        .fontSize(14)
        .fontColor('#ECEFF1')
        .placeholderColor('#78909C')
        .caretColor('#1DE9B6')
        .backgroundColor('#0E1216')
        .borderRadius(10)
        .onChange((v: string) => {
          this.val = v.trim();
        })
      Row({ space: 12 }) {
        Button('取消')
          .layoutWeight(1)
          .height(42)
          .fontSize(15)
          .backgroundColor('#2A3542')
          .onClick(() => {
            if (this.controller) {
              this.controller.close();
            }
          })
        Button('保存')
          .layoutWeight(1)
          .height(42)
          .fontSize(15)
          .fontColor('#0E1216')
          .backgroundColor('#1DE9B6')
          .onClick(() => {
            this.onOk(this.val);
            if (this.controller) {
              this.controller.close();
            }
          })
      }
      .width('100%')
    }
    .width('86%')
    .padding(20)
    .backgroundColor('#1B232E')
    .borderRadius(18)
  }
}

@Component
struct ScanRings {
  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private ctx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private timer: number = -1;
  private phase: number = 0;
  @State sizeVp: number = 0;
  @State canvasReady: boolean = false;

  private queryScreenSize(): void {
    try {
      const d: display.Display = display.getDefaultDisplaySync();
      if (d && d.width > 0) {
        this.sizeVp = px2vp(d.width);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'query screen size fail: %{public}s', JSON.stringify(e));
      this.sizeVp = 360;
    }
  }

  aboutToAppear(): void {
    this.queryScreenSize();
    this.timer = setInterval(() => {
      this.phase = (this.phase + 1) % 60;
      if (this.canvasReady && this.sizeVp > 0) {
        this.drawFrame();
      }
    }, 100);
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  private drawFrame(): void {
    const s: number = this.sizeVp;
    if (s <= 0) {
      return;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, s, s);
    const cx: number = s / 2;
    const cy: number = s / 2;
    const minR: number = Math.max(12, s * 0.06);
    // 最大环扩到画布边缘：圆直径 = 画布宽度(手机屏宽)
    const maxR: number = s / 2;
    for (let i = 0; i < 5; i++) {
      const prog: number = (this.phase + i * 12) % 60;
      const t: number = prog / 59;
      const radius: number = minR + (maxR - minR) * t;
      // 透明度随半径递增从 0.85 线性降至边缘 0.10
      const alpha: number = 0.85 - 0.75 * t;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(45, 227, 181, ' + alpha.toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // 呼吸大圆：柔光圆斑，直径接近半个屏幕宽度，随相位周期呼吸
    const breath: number = 0.5 + 0.5 * Math.sin((this.phase / 60) * Math.PI * 4);
    const softR: number = s * (0.21 + 0.04 * breath);
    const grad: CanvasGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, softR);
    grad.addColorStop(0, 'rgba(45, 227, 181, 0.55)');
    grad.addColorStop(0.5, 'rgba(45, 227, 181, 0.18)');
    grad.addColorStop(1, 'rgba(45, 227, 181, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, softR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    // 中心实色圆：保持原有实色圆心
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.05, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(45, 227, 181, 0.95)';
    ctx.fill();
  }

  build() {
    Canvas(this.ctx)
      .width(this.sizeVp)
      .height(this.sizeVp)
      .onReady(() => {
        this.queryScreenSize();
        this.canvasReady = true;
        if (this.sizeVp > 0) {
          this.drawFrame();
        }
      })
  }
}

@Entry
@Component
struct Index {
  @State sources: SourceInfo[] = [];
  @State statusText: string = '正在查找可用设备源';
  @State selectedKey: string = '';
  @State localIp: string = '';
  @State statusBarTop: number = 0;
  @State listHint: string = '';

  private running: boolean = false;
  private pollTimer: number = -1;
  private pruneTimer: number = -1;
  private udp: socket.UDPSocket | null = null;
  private decoder: util.TextDecoder = new util.TextDecoder('utf-8');
  private dialogController: CustomDialogController = new CustomDialogController({
    builder: AddressDialog({
      url: DEFAULT_KEY,
      onOk: (v: string) => {
        this.addManualSource(v);
      }
    }),
    autoCancel: true,
    customStyle: true
  });

  aboutToAppear(): void {
    this.localIp = this.getLocalIp();
    this.queryTopAvoid();
    this.start();
  }

  aboutToDisappear(): void {
    this.stopAll();
  }

  private queryTopAvoid(): void {
    try {
      const ctx = this.getUIContext().getHostContext();
      if (ctx) {
        window.getLastWindow(ctx).then((w: window.Window) => {
          const area: window.AvoidArea = w.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
          this.statusBarTop = area.topRect.height > 0 ? area.topRect.height : 0;
        }).catch(() => {
        });
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'query avoid area fail: %{public}s', JSON.stringify(e));
    }
  }

  private getLocalIp(): string {
    try {
      const info: wifiManager.IpInfo = wifiManager.getIpInfo();
      const n: number = info.ipAddress;
      return ((n >>> 24) & 0xFF) + '.' + ((n >>> 16) & 0xFF) + '.' + ((n >>> 8) & 0xFF) + '.' + (n & 0xFF);
    } catch (e) {
      return '未连Wi-Fi';
    }
  }

  private start(): void {
    this.running = true;
    this.setupUdp();
    this.pollAll();
    this.pollTimer = setInterval(() => {
      this.pollAll();
    }, POLL_MS);
    this.pruneTimer = setInterval(() => {
      this.pruneSources();
    }, 3000);
  }

  private stopAll(): void {
    this.running = false;
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
    if (this.pruneTimer !== -1) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = -1;
    }
    this.closeUdp();
  }

  /* ---------- UDP 广播发现 ---------- */
  private setupUdp(): void {
    try {
      this.udp = socket.constructUDPSocketInstance();
      this.udp.on('message', (info: socket.SocketMessageInfo) => {
        this.onBeacon(info);
      });
      this.udp.bind({
        address: '0.0.0.0',
        family: 1,
        port: UDP_PORT
      }).catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'udp bind fail(no beacon discover): %{public}s', err.message);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'udp setup fail: %{public}s', JSON.stringify(e));
    }
  }

  private closeUdp(): void {
    try {
      if (this.udp) {
        this.udp.off('message');
        this.udp.close().catch(() => {
        });
        this.udp = null;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'udp close fail: %{public}s', JSON.stringify(e));
    }
  }

  private onBeacon(info: socket.SocketMessageInfo): void {
    try {
      const buf: ArrayBuffer = info.message;
      const text: string = this.decoder.decodeToString(new Uint8Array(buf));
      const b: BeaconData = JSON.parse(text) as BeaconData;
      if (!b || b.type !== 'prism-beacon' || !b.ip || !b.port) {
        return;
      }
      const key: string = b.ip + ':' + b.port;
      const now: number = Date.now();
      const arr: SourceInfo[] = this.sources.slice();
      const idx: number = arr.findIndex((s: SourceInfo) => s.key === key);
      if (idx >= 0) {
        const s: SourceInfo = arr[idx];
        s.host = b.host || s.host;
        s.lastSeen = now;
        // beacon 是服务端权威广播: 收到即证明服务端在线(可就近判为可达),
        // 且 active 字段直接决定"推送中/未推送"。两种状态都要实时吃进来,
        // 不能只处理 active=true —— 否则关掉推送后卡片会一直停留在"在线"。
        s.reachable = true;
        if (b.active === true) {
          s.active = true;
          s.lastOk = now;
          if (b.active_name && b.active_name.length > 0) {
            s.name = b.active_name;
          } else if (b.name && b.name.length > 0) {
            s.name = b.name;
          }
        } else {
          s.active = false;
        }
        arr[idx] = s;
      } else {
        arr.push({
          key: key,
          ip: b.ip,
          port: b.port,
          host: b.host || '电脑端',
          active: b.active === true,
          reachable: b.active === true,
          name: (b.active_name && b.active_name.length > 0) ? b.active_name : '',
          devMode: '',
          lastSeq: -1,
          manual: false,
          lastSeen: now,
          lastOk: 0
        });
      }
      this.sources = arr;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'beacon parse fail: %{public}s', JSON.stringify(e));
    }
  }

  /* ---------- 源状态 HTTP 轮询 ---------- */
  private async pollAll(): Promise<void> {
    if (!this.running) {
      return;
    }
    const keys: string[] = [];
    for (const s of this.sources) {
      keys.push(s.key);
    }
    for (const k of keys) {
      await this.pollSource(k);
    }
    this.syncStatusText();
  }

  private async pollSource(key: string): Promise<void> {
    const req = http.createHttp();
    try {
      const res: http.HttpResponse = await req.request('http://' + key + '/api/status', {
        method: http.RequestMethod.GET,
        connectTimeout: 2000,
        readTimeout: 2000,
        header: { 'Cache-Control': 'no-store' }
      });
      if (res.responseCode === 200) {
        const obj: StatusData = JSON.parse(res.result as string) as StatusData;
        this.updateSource(key, true, obj);
      } else {
        this.updateSource(key, false, null);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'poll %{public}s fail: %{public}s', key, JSON.stringify(e));
      this.updateSource(key, false, null);
    } finally {
      req.destroy();
    }
  }

  private updateSource(key: string, reachable: boolean, obj: StatusData | null): void {
    const arr: SourceInfo[] = this.sources.slice();
    const idx: number = arr.findIndex((s: SourceInfo) => s.key === key);
    if (idx < 0) {
      return;
    }
    const s: SourceInfo = arr[idx];
    const nowMs: number = Date.now();
    // HTTP 探测瞬时失败容忍: 近期成功过且仍在容忍期内则保持在线, 避免 poll 单次抖动闪"离线"
    if (!reachable && s.reachable && nowMs - s.lastOk < OFFLINE_GRACE_MS) {
      arr[idx] = s;
      this.sources = arr;
      return;
    }
    s.reachable = reachable;
    // 老服务端无 active 字段时视为可用；新服务端 active=false 表示电脑端未开启推送
    s.active = reachable && (obj === null || obj.active !== false);
    if (reachable) {
      s.lastOk = nowMs;
      s.lastSeen = nowMs;
    }
    if (obj) {
      s.name = obj.active_name && obj.active_name.length > 0 ? obj.active_name : obj.name;
      // 连上真实电脑后, 用服务端上报的主机名替换"手动添加"等占位名
      if (obj.host && obj.host.length > 0) {
        s.host = obj.host;
      }
      s.devMode = obj.mode;
      if (obj.seq !== undefined) {
        s.lastSeq = obj.seq;
      }
    }
    arr[idx] = s;
    // active 源排前，保持列表稳定
    arr.sort((a: SourceInfo, b: SourceInfo): number => {
      if (a.active !== b.active) {
        return a.active ? -1 : 1;
      }
      return 0;
    });
    this.sources = arr;
    // 自动选中第一个可用源
    const selIdx: number = arr.findIndex((x: SourceInfo) => x.key === this.selectedKey);
    if (selIdx < 0 || !arr[selIdx].active) {
      const f = arr.find((x: SourceInfo) => x.active);
      this.selectedKey = f ? f.key : '';
    }
  }

  private pruneSources(): void {
    const now: number = Date.now();
    const keep: SourceInfo[] = [];
    for (const s of this.sources) {
      if (s.manual) {
        keep.push(s);
        continue;
      }
      // 15 秒内没有任何 beacon/HTTP 心跳的自动发现源移除
      if (now - s.lastSeen < 15000) {
        keep.push(s);
      }
    }
    if (keep.length !== this.sources.length) {
      this.sources = keep;
      this.syncStatusText();
    }
  }

  private syncStatusText(): void {
    const activeCount: number = this.sources.filter((s: SourceInfo) => s.active).length;
    const onlineCount: number = this.sources.filter((s: SourceInfo) => s.reachable || s.active).length;
    if (activeCount > 0) {
      this.statusText = '已找到 ' + activeCount + ' 个可用设备源';
      this.listHint = '点击源卡片选中，可切换预览电脑';
    } else if (onlineCount > 0) {
      this.statusText = '设备源在线，等待电脑端开启推送';
      this.listHint = '请在电脑端插件点击「推送预览」开启服务';
    } else {
      this.statusText = '正在查找可用设备源';
      this.listHint = '确保电脑已安装棱镜插件并处于同一 Wi-Fi';
    }
  }

  /* ---------- 手动直连 ---------- */
  private normalizeAddr(v: string): string {
    let s: string = v.trim();
    if (s.length === 0) {
      return '';
    }
    const protoIdx: number = s.indexOf('://');
    if (protoIdx >= 0) {
      s = s.substring(protoIdx + 3);
    }
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    if (s.indexOf(':') < 0) {
      s = s + ':' + DEFAULT_PORT;
    }
    return s;
  }

  private addManualSource(v: string): void {
    const key: string = this.normalizeAddr(v);
    if (key.length === 0) {
      promptAction.showToast({ message: '地址格式不正确' });
      return;
    }
    const parts: string[] = key.split(':');
    const ipPart: string = parts[0];
    const portPart: string = parts.length > 1 ? parts[1] : String(DEFAULT_PORT);
    const arr: SourceInfo[] = this.sources.slice();
    const idx: number = arr.findIndex((s: SourceInfo) => s.key === key);
    if (idx >= 0) {
      arr[idx].manual = true;
      arr[idx].lastSeen = 0;
    } else {
      arr.push({
        key: key,
        ip: ipPart,
        port: parseInt(portPart, 10) || DEFAULT_PORT,
        host: '手动添加',
        active: false,
        reachable: false,
        name: '',
        devMode: '',
        lastSeq: -1,
        manual: true,
        lastSeen: 0,
        lastOk: 0
      });
    }
    this.sources = arr;
    this.selectedKey = key;
    promptAction.showToast({ message: '已添加直连地址 ' + key });
    // 立即探测一次
    this.pollAll();
  }

  /** 源列表可视高度: 单源显示一张卡, 多源显示一个半(可滑动) */
  private sourceListHeight(): number {
    const n: number = this.sources.length;
    if (n <= 0) {
      return 0;
    }
    if (n === 1) {
      return 74;
    }
    return 111;
  }

  private openPreview(): void {
    const sel: SourceInfo | undefined = this.sources.find((s: SourceInfo) => s.key === this.selectedKey);
    if (!sel || !sel.active) {
      promptAction.showToast({ message: '未搜索到可用设备源，请先在电脑端开启推送' });
      return;
    }
    router.pushUrl({
      url: 'pages/PreviewPage',
      params: { serverUrl: 'http://' + sel.key }
    });
  }

  private sourceDotColor(s: SourceInfo): string {
    if (s.active) {
      return '#1DE9B6';
    }
    if (s.reachable) {
      return '#F5B041';
    }
    return '#546E7A';
  }

  private sourceStateText(s: SourceInfo): string {
    if (s.active) {
      return '在线 · 推送中';
    }
    if (s.reachable) {
      return '在线 · 未推送';
    }
    return '离线';
  }

  build() {
    Column() {
      // 标题行：下移避让系统状态栏
      Text('实时预览你的设计')
        .width('100%')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#ECEFF1')
        .textAlign(TextAlign.Center)
        .margin({ top: Math.max(0, this.statusBarTop - 88) })

      // 主视觉区
      Column() {
        ScanRings()
          .margin({ top: 0 })
        Text(this.statusText)
          .fontSize(16)
          .fontColor(this.sources.some((s: SourceInfo) => s.active) ? '#1DE9B6' : '#B0BEC5')
          .textAlign(TextAlign.Center)
          .width('100%')
          .padding({ left: 30, right: 30 })
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 4 })

        // 设备源列表(高度自适应: 单源显示一张卡, 多源显示一个半可滑动)
        Column() {
          if (this.sources.length === 0) {
            Text('暂无设备源，请确认电脑端已安装棱镜插件')
              .fontSize(13)
              .fontColor('#5C6B7A')
              .margin({ top: 10, bottom: 10 })
              .width('100%')
              .textAlign(TextAlign.Center)
          } else {
            Scroll() {
              Column() {
                ForEach(this.sources, (s: SourceInfo) => {
              Row() {
                Column()
                  .width(10)
                  .height(10)
                  .borderRadius(5)
                  .backgroundColor(this.sourceDotColor(s))
                Column({ space: 3 }) {
                  Row({ space: 8 }) {
                    Text(s.host && s.host.length > 0 ? s.host : (s.ip + ':' + s.port))
                      .fontSize(15)
                      .fontWeight(FontWeight.Medium)
                      .fontColor('#ECEFF1')
                    Text(s.manual ? '手动' : '发现')
                      .fontSize(10)
                      .fontColor('#78909C')
                      .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                      .backgroundColor('#1B2530')
                      .borderRadius(4)
                  }
                  Text(this.sourceStateText(s))
                    .fontSize(13)
                    .fontColor(this.sourceDotColor(s))
                    .fontWeight(FontWeight.Medium)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                .margin({ left: 10 })
              }
              .width('100%')
              .padding({ left: 14, right: 14, top: 12, bottom: 12 })
              .backgroundColor(this.selectedKey === s.key ? '#14303A' : '#18222D')
              .borderRadius(12)
              .border({ width: 1, color: this.selectedKey === s.key ? '#1DE9B6' : '#1E2B36' })
              .margin({ bottom: 8 })
              .onClick(() => {
                this.selectedKey = s.key;
                // 手动离线源点击立即探测
                if (!s.active) {
                  this.pollAll();
                }
              })
                }, (s: SourceInfo) => s.key + '|' + (s.active ? 'a' : (s.reachable ? 'r' : 'o')))
              }
              .width('100%')
            }
            .scrollable(ScrollDirection.Vertical)
            .scrollBar(BarState.Off)
            .edgeEffect(EdgeEffect.Spring)
            .height(this.sourceListHeight())
          }

          Text(this.listHint)
            .fontSize(11)
            .fontColor('#5C6B7A')
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 6 })
        }
        .width('88%')
        .padding({ left: 12, right: 12, top: 12, bottom: 10 })
        .backgroundColor('#111920')
        .borderRadius(14)
        .margin({ top: 14 })

        // Wi-Fi 直连地址卡片
        Row() {
          Text('Wi-Fi 直连')
            .fontSize(12)
            .fontColor('#78909C')
          Text(this.selectedKey && this.selectedKey.length > 0 ? this.selectedKey : DEFAULT_KEY)
            .fontSize(15)
            .fontColor('#ECEFF1')
            .layoutWeight(1)
            .textAlign(TextAlign.End)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text('修改')
            .fontSize(12)
            .fontColor('#1DE9B6')
            .margin({ left: 8 })
        }
        .width('88%')
        .padding({ left: 16, right: 16, top: 12, bottom: 12 })
        .backgroundColor('#141B24')
        .borderRadius(14)
        .margin({ top: 10 })
        .onClick(() => {
          this.dialogController.open();
        })
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ top: 8, bottom: 10 })
      .justifyContent(FlexAlign.Center)

      // 底部导航
      Column() {
        Text('本机 IP：' + this.localIp)
          .fontSize(12)
          .fontColor('#78909C')
          .margin({ bottom: 20 })
        Row() {
          Text('预览')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#0E1216')
            .opacity(this.sources.some((s: SourceInfo) => s.active) ? 1 : 0.45)
            .padding({ left: 34, right: 34, top: 10, bottom: 10 })
            .backgroundColor('#1DE9B6')
            .borderRadius(22)
            .onClick(() => {
              this.openPreview();
            })
        }
        .width('100%')
        .height(66)
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#0B1015')
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0E1216')
  }
}
