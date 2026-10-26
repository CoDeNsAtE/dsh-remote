import { DshApprovalRequest, DshChatParams, DshDefaults, DshHelloInfo, DshOpenResult, DshSessionSummary, DshSessionsResult, DshWireFrame } from '../model/DshTypes';
import { DshClient } from '../service/DshClient';
import { DshCredentials } from '../service/DshCredentials';
import { DshTheme } from '../theme/DshTheme';
import { DshFormat } from '../util/DshFormat';
import { DshIconButton } from '../components/DshIconButton';
import { DshLogo } from '../components/DshLogo';
import { DshSessionCard } from '../components/DshSessionCard';
import { DshStatusChip } from '../components/DshStatusChip';
import { ChatPage } from './ChatPage';

@Entry
@Component
struct Index {
  @State booting: boolean = true;
  @State workspaceActive: boolean = false;
  @State transportOnline: boolean = false;
  @State agentOnline: boolean = false;
  @State agentMessage: string = '';
  @State serverUrl: string = '';
  @State tokenValue: string = '';
  @State connectError: string = '';
  @State connecting: boolean = false;
  @State sessions: DshSessionSummary[] = [];
  @State sessionsLoading: boolean = false;
  @State sessionWarning: string = '';
  @State creatingSession: boolean = false;
  @State hasApproval: boolean = false;
  @State approvalData: DshApprovalRequest = DshDefaults.approval();
  @State approvalQueue: DshApprovalRequest[] = [];
  @State approvalBusy: boolean = false;
  @State showSettings: boolean = false;
  @State bridgeVersion: string = '';
  @State agentVersion: string = '';
  @State defaultCwd: string = '';

  private pathStack: NavPathStack = new NavPathStack();
  private client: DshClient = DshClient.getInstance();
  private removeListener: (() => void) | undefined = undefined;

  aboutToAppear(): void {
    this.removeListener = this.client.addEventListener((frame: DshWireFrame) => {
      this.handleEvent(frame);
    });
    this.bootstrap();
  }

  aboutToDisappear(): void {
    if (this.removeListener !== undefined) {
      this.removeListener();
      this.removeListener = undefined;
    }
  }

  private async bootstrap(): Promise<void> {
    const savedUrl = await DshCredentials.loadServerUrl();
    const savedToken = await DshCredentials.loadToken();
    this.serverUrl = savedUrl;
    this.tokenValue = savedToken;
    if (savedUrl.length > 0 && savedToken.length > 0) {
      this.workspaceActive = true;
      await this.doConnect(savedUrl, savedToken, true);
    }
    this.booting = false;
  }

  private async doConnect(url: string, token: string, autoConnect: boolean): Promise<void> {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.connectError = '';
    try {
      const hello = await this.client.connect(url, token);
      this.applyHello(hello);
      this.serverUrl = this.client.getServerUrl();
      this.workspaceActive = true;
      this.transportOnline = true;
      await DshCredentials.saveServerUrl(this.serverUrl);
      await DshCredentials.saveToken(token);
      await this.loadSessions();
    } catch (error) {
      const message = (error as Error).message;
      this.connectError = message.length > 0 ? message : '连接失败';
      this.transportOnline = false;
      if (autoConnect) {
        this.workspaceActive = false;
      }
    } finally {
      this.connecting = false;
    }
  }

  private applyHello(hello: DshHelloInfo): void {
    this.agentOnline = hello.online;
    this.agentMessage = hello.online ? '' : 'DSH 尚未就绪';
    this.bridgeVersion = hello.version;
    this.agentVersion = hello.agentVersion;
    this.defaultCwd = hello.defaultCwd;
  }

  private async loadSessions(): Promise<void> {
    this.sessionsLoading = true;
    try {
      const result: DshSessionsResult = await this.client.listSessions();
      this.sessions = result.sessions;
      this.agentOnline = result.online;
      this.sessionWarning = result.warning;
      if (!result.online && result.warning.length > 0) {
        this.agentMessage = result.warning;
      }
    } catch (error) {
      const message = (error as Error).message;
      this.sessionWarning = message;
    } finally {
      this.sessionsLoading = false;
    }
  }

  private handleEvent(frame: DshWireFrame): void {
    if (frame.event === 'connection.status') {
      this.transportOnline = frame.online === true;
      if (!this.transportOnline) {
        this.agentOnline = false;
        this.agentMessage = frame.message ?? '连接已断开';
        this.hasApproval = false;
        this.approvalQueue = [];
        this.approvalBusy = false;
      }
      return;
    }
    if (frame.event === 'bridge.status') {
      this.agentOnline = frame.online === true;
      this.agentMessage = frame.message ?? '';
      return;
    }
    if (frame.event === 'session.updated' && frame.session !== undefined) {
      this.mergeSession(frame.session);
      return;
    }
    if (frame.event === 'turn.status') {
      this.markRunning(frame.sessionId ?? '', frame.status === 'running');
      return;
    }
    if (frame.event === 'approval.request') {
      const request: DshApprovalRequest = {
        requestId: frame.requestId ?? '',
        sessionId: frame.sessionId ?? '',
        toolCallId: frame.toolCallId ?? '',
        title: frame.title ?? '工具调用',
        label: frame.label ?? '',
        input: frame.input ?? '',
        options: frame.options ?? []
      };
      this.enqueueApproval(request);
      return;
    }
    if (frame.event === 'approval.resolved') {
      this.removeApproval(frame.requestId ?? '');
      return;
    }
  }

  private enqueueApproval(request: DshApprovalRequest): void {
    if (this.hasApproval) {
      const queue = this.approvalQueue.slice();
      queue.push(request);
      this.approvalQueue = queue;
      return;
    }
    this.approvalData = request;
    this.hasApproval = true;
    this.approvalBusy = false;
  }

  private removeApproval(requestId: string): void {
    if (this.approvalData.requestId === requestId) {
      this.advanceApproval();
      return;
    }
    const queue = this.approvalQueue.filter((item: DshApprovalRequest): boolean => item.requestId !== requestId);
    this.approvalQueue = queue;
  }

  private advanceApproval(): void {
    this.approvalBusy = false;
    const queue = this.approvalQueue.slice();
    if (queue.length > 0) {
      this.approvalData = queue[0];
      this.approvalQueue = queue.slice(1);
      this.hasApproval = true;
    } else {
      this.approvalData = DshDefaults.approval();
      this.hasApproval = false;
    }
  }

  private mergeSession(session: DshSessionSummary): void {
    const next = this.sessions.slice();
    let found = -1;
    for (let index = 0; index < next.length; index++) {
      if (next[index].sessionId === session.sessionId) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      next[found] = session;
    } else {
      next.unshift(session);
    }
    next.sort((left: DshSessionSummary, right: DshSessionSummary): number => right.updatedAt - left.updatedAt);
    this.sessions = next;
  }

  private markRunning(sessionId: string, running: boolean): void {
    if (sessionId.length === 0) {
      return;
    }
    const next = this.sessions.slice();
    let changed = false;
    for (let index = 0; index < next.length; index++) {
      const current = next[index];
      if (current.sessionId === sessionId && current.running !== running) {
        const updated: DshSessionSummary = {
          sessionId: current.sessionId,
          cwd: current.cwd,
          title: current.title,
          preview: current.preview,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          running: running,
          hasTranscript: current.hasTranscript
        };
        next[index] = updated;
        changed = true;
      }
    }
    if (changed) {
      this.sessions = next;
    }
  }

  private allowOptionId(): string {
    for (let index = 0; index < this.approvalData.options.length; index++) {
      const option = this.approvalData.options[index];
      if (option.kind === 'allow_once' || option.optionId.indexOf('allow') >= 0) {
        return option.optionId;
      }
    }
    return '';
  }

  private rejectOptionId(): string {
    for (let index = 0; index < this.approvalData.options.length; index++) {
      const option = this.approvalData.options[index];
      if (option.kind === 'reject_once' || option.optionId.indexOf('reject') >= 0) {
        return option.optionId;
      }
    }
    return '';
  }

  private respondApproval(optionId: string): void {
    if (this.approvalBusy || !this.hasApproval) {
      return;
    }
    const requestId = this.approvalData.requestId;
    this.approvalBusy = true;
    this.client.respondApproval(requestId, optionId)
      .then(() => {
        this.removeApproval(requestId);
      })
      .catch((error: Error) => {
        this.approvalBusy = false;
        this.showToast(`授权失败：${error.message}`);
      });
  }

  private async createSession(): Promise<void> {
    if (this.creatingSession) {
      return;
    }
    if (!this.transportOnline) {
      this.showToast('网关已断开，请先重连');
      return;
    }
    this.creatingSession = true;
    try {
      const result: DshOpenResult = await this.client.newSession(this.defaultCwd);
      this.mergeSession(result.session);
      this.openChat(result.session);
    } catch (error) {
      this.showToast(`新建会话失败：${(error as Error).message}`);
    } finally {
      this.creatingSession = false;
    }
  }

  private openChat(session: DshSessionSummary): void {
    if (session.sessionId.length === 0) {
      return;
    }
    const params: DshChatParams = new DshChatParams(session.sessionId, session.cwd, session.title);
    this.pathStack.pushPathByName('Chat', params);
  }

  private openSettings(): void {
    this.showSettings = true;
  }

  private async reconnectNow(): Promise<void> {
    this.showSettings = false;
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.connectError = '';
    try {
      const hello = await this.client.reconnect();
      this.applyHello(hello);
      this.transportOnline = true;
      await this.loadSessions();
      this.showToast('已重新连接');
    } catch (error) {
      this.transportOnline = false;
      this.agentOnline = false;
      this.agentMessage = (error as Error).message;
      this.showToast(`重连失败：${(error as Error).message}`);
    } finally {
      this.connecting = false;
    }
  }

  private editConnection(): void {
    this.showSettings = false;
    this.client.disconnect();
    this.transportOnline = false;
    this.agentOnline = false;
    this.workspaceActive = false;
    this.approvalQueue = [];
    this.hasApproval = false;
  }

  private disconnectNow(): void {
    this.showSettings = false;
    this.client.disconnect();
    this.transportOnline = false;
    this.agentOnline = false;
    this.agentMessage = '网关连接已断开，工作区缓存仍可查看。';
    this.workspaceActive = true;
  }

  private showAbout(): void {
    this.showSettings = false;
    this.getUIContext().showAlertDialog({
      title: 'DSH Remote',
      message: 'DeepSeek Harness 移动远程控制台\n通过 ACP 网关连接桌面端 Harness，保留插件、工具与审批流。\n\nBridge ' + this.bridgeVersion + '\nHarness ' + this.agentVersion,
      buttons: [
        {
          value: '知道了',
          action: () => {
          }
        }
      ]
    });
  }

  private showToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 2200 });
    } catch (error) {
      // A toast failure must not interrupt the connection flow.
    }
  }

  private statusLabel(): string {
    if (!this.transportOnline) {
      return '已断开';
    }
    if (!this.agentOnline) {
      return 'DSH 离线';
    }
    return '已连接';
  }

  private statusTone(): string {
    if (!this.transportOnline) {
      return 'offline';
    }
    if (!this.agentOnline) {
      return 'warn';
    }
    return 'online';
  }

  private warningText(): string {
    if (!this.transportOnline) {
      return this.agentMessage.length > 0 ? this.agentMessage : '网关连接已断开，工作区缓存仍可查看。';
    }
    if (!this.agentOnline) {
      return this.agentMessage.length > 0 ? this.agentMessage : 'DSH 进程尚未就绪，新任务暂时无法启动。';
    }
    return this.sessionWarning;
  }

  @Builder
  stepRow(numberValue: string, titleValue: string, bodyValue: string) {
    Row({ space: 11 }) {
      Text(numberValue)
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(DshTheme.accentBright)
        .textAlign(TextAlign.Center)
        .width(24)
        .height(24)
        .borderRadius(12)
        .backgroundColor('#182247')
        .border({ width: 1, color: '#28386B' })
      Column({ space: 3 }) {
        Text(titleValue)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(DshTheme.textSecondary)
        Text(bodyValue)
          .fontSize(11)
          .lineHeight(17)
          .fontColor(DshTheme.muted)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  serverField() {
    Column({ space: 5 }) {
      Text('网关地址')
        .fontSize(11)
        .fontColor(DshTheme.muted)
      TextInput({ placeholder: 'ws://192.168.1.10:8787/dsh', text: $$this.serverUrl })
        .placeholderColor(DshTheme.faint)
        .fontColor(DshTheme.text)
        .fontSize(14)
        .backgroundColor(Color.Transparent)
        .padding({ left: 0, right: 0, top: 3, bottom: 3 })
        .caretColor(DshTheme.accentBright)
        .onChange((value: string) => {
          this.serverUrl = value;
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 14, right: 14, top: 11, bottom: 11 })
    .backgroundColor(DshTheme.surfaceAlt)
    .borderRadius(13)
    .border({ width: 1, color: DshTheme.border })
  }

  @Builder
  tokenField() {
    Column({ space: 5 }) {
      Text('访问令牌')
        .fontSize(11)
        .fontColor(DshTheme.muted)
      TextInput({ placeholder: '粘贴网关终端打印的 Token', text: $$this.tokenValue })
        .type(InputType.Password)
        .showPasswordIcon(true)
        .placeholderColor(DshTheme.faint)
        .fontColor(DshTheme.text)
        .fontSize(14)
        .backgroundColor(Color.Transparent)
        .padding({ left: 0, right: 0, top: 3, bottom: 3 })
        .caretColor(DshTheme.accentBright)
        .onChange((value: string) => {
          this.tokenValue = value;
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 14, right: 14, top: 11, bottom: 11 })
    .backgroundColor(DshTheme.surfaceAlt)
    .borderRadius(13)
    .border({ width: 1, color: DshTheme.border })
  }

  @Builder
  bootView() {
    Column({ space: 16 }) {
      DshLogo({ sizeValue: 58 })
      Text('DSH Remote')
        .fontSize(23)
        .fontWeight(FontWeight.Bold)
        .fontColor(DshTheme.text)
      LoadingProgress()
        .width(22)
        .height(22)
        .color(DshTheme.accentBright)
      Text('正在恢复连接…')
        .fontSize(12)
        .fontColor(DshTheme.muted)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor(DshTheme.bg)
  }

  @Builder
  connectView() {
    Scroll() {
      Row() {
        Column({ space: 18 }) {
          Row({ space: 12 }) {
            DshLogo({ sizeValue: 52 })
            Column({ space: 3 }) {
              Text('DSH Remote')
                .fontSize(22)
                .fontWeight(FontWeight.Bold)
                .fontColor(DshTheme.text)
              Text('DeepSeek Harness 远程控制台')
                .fontSize(11)
                .fontColor(DshTheme.muted)
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            DshStatusChip({
              labelValue: this.connecting ? '连接中' : '未连接',
              toneValue: this.connecting ? 'accent' : 'offline',
              showDotValue: true
            })
          }
          .width('100%')

          Column({ space: 7 }) {
            Text('把整个 Agent\n装进口袋')
              .fontSize(30)
              .fontWeight(FontWeight.Bold)
              .fontColor(DshTheme.text)
              .lineHeight(37)
            Text('连接桌面端 DSH 网关，继续同一批会话、模型和插件。工具调用会在手机上等待你的批准。')
              .fontSize(13)
              .lineHeight(20)
              .fontColor(DshTheme.textSecondary)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Row({ space: 7 }) {
            Text('ACP')
              .fontSize(10)
              .fontColor(DshTheme.accentBright)
              .padding({ left: 9, right: 9, top: 5, bottom: 5 })
              .backgroundColor('#182247')
              .borderRadius(20)
              .border({ width: 1, color: '#28386B' })
            Text('工具审批')
              .fontSize(10)
              .fontColor(DshTheme.textSecondary)
              .padding({ left: 9, right: 9, top: 5, bottom: 5 })
              .backgroundColor(DshTheme.surface)
              .borderRadius(20)
              .border({ width: 1, color: DshTheme.border })
            Text('插件生态')
              .fontSize(10)
              .fontColor(DshTheme.textSecondary)
              .padding({ left: 9, right: 9, top: 5, bottom: 5 })
              .backgroundColor(DshTheme.surface)
              .borderRadius(20)
              .border({ width: 1, color: DshTheme.border })
          }
          .width('100%')

          Column({ space: 13 }) {
            Row({ space: 8 }) {
              Image($r('app.media.ic_lock'))
                .width(14)
                .height(14)
                .fillColor(DshTheme.accentBright)
              Text('连接设置')
                .fontSize(13)
                .fontWeight(FontWeight.Medium)
                .fontColor(DshTheme.text)
              Blank()
              Text('令牌仅保存在本机安全存储')
                .fontSize(10)
                .fontColor(DshTheme.faint)
            }
            .width('100%')

            this.serverField()
            this.tokenField()

            if (this.connectError.length > 0) {
              Text(this.connectError)
                .fontSize(11)
                .lineHeight(17)
                .fontColor(DshTheme.danger)
                .width('100%')
            }

            Button() {
              Row({ space: 8 }) {
                if (this.connecting) {
                  LoadingProgress()
                    .width(17)
                    .height(17)
                    .color('#FFFFFF')
                } else {
                  Image($r('app.media.ic_send'))
                    .width(16)
                    .height(16)
                    .fillColor('#FFFFFF')
                }
                Text(this.connecting ? '正在连接…' : '连接网关')
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#FFFFFF')
              }
              .justifyContent(FlexAlign.Center)
            }
            .width('100%')
            .height(50)
            .borderRadius(14)
            .backgroundColor(this.connecting ? '#3F55B8' : DshTheme.accent)
            .stateEffect(true)
            .enabled(!this.connecting)
            .onClick(() => {
              this.doConnect(this.serverUrl, this.tokenValue, false);
            })
          }
          .width('100%')
          .padding(15)
          .alignItems(HorizontalAlign.Start)
          .backgroundColor(DshTheme.surface)
          .borderRadius(20)
          .border({ width: 1, color: DshTheme.border })

          Column({ space: 13 }) {
            Text('怎么连接')
              .fontSize(13)
              .fontWeight(FontWeight.Medium)
              .fontColor(DshTheme.textSecondary)
            this.stepRow('1', '启动电脑端网关', '进入 bridge 目录执行 npm install，再运行 node dsh-mobile-bridge.mjs，保持终端不关闭。')
            this.stepRow('2', '手机与电脑同一网络', '把终端打印的 WebSocket 地址和 Token 填到上方，建议使用 5GHz Wi-Fi。')
            this.stepRow('3', '开始操控', '网关通过 ACP 驱动 dsh --profile acp，插件与工具审批原样保留。')
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Row({ space: 7 }) {
            Image($r('app.media.ic_shield'))
              .width(13)
              .height(13)
              .fillColor(DshTheme.faint)
            Text('端到端局域网直连 · 令牌只保存在本机')
              .fontSize(10)
              .fontColor(DshTheme.faint)
          }
          .width('100%')
          .justifyContent(FlexAlign.Center)
          .padding({ top: 4, bottom: 12 })
        }
        .width('100%')
        .constraintSize({ maxWidth: 560 })
        .padding({ left: 20, right: 20, top: 16, bottom: 20 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .linearGradient({
      angle: 165,
      colors: [['#14214A', 0.0], ['#0A0C11', 0.52], ['#0A0C11', 1.0]]
    })
  }

  @Builder
  sessionsHeader() {
    Row({ space: 10 }) {
      DshLogo({ sizeValue: 36 })
      Column({ space: 2 }) {
        Text('DSH Remote')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(DshTheme.text)
        Text('远程工作台')
          .fontSize(10)
          .fontColor(DshTheme.faint)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      DshStatusChip({
        labelValue: this.statusLabel(),
        toneValue: this.statusTone(),
        showDotValue: true
      })
      DshIconButton({
        iconValue: $r('app.media.ic_settings'),
        tintValue: DshTheme.textSecondary,
        bgValue: DshTheme.surface,
        sizeValue: 36,
        iconSizeValue: 18,
        onPress: () => {
          this.openSettings();
        }
      })
    }
    .width('100%')
  }

  @Builder
  workspaceCard() {
    Column({ space: 12 }) {
      Row({ space: 10 }) {
        Stack() {
          Image($r('app.media.ic_tool'))
            .width(17)
            .height(17)
            .fillColor(DshTheme.accentBright)
        }
        .width(32)
        .height(32)
        .borderRadius(10)
        .backgroundColor('#19213A')
        .border({ width: 1, color: '#27335A' })

        Column({ space: 2 }) {
          Text('当前工作区')
            .fontSize(10)
            .fontColor(DshTheme.muted)
          Text(DshFormat.projectName(this.defaultCwd))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor(DshTheme.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button() {
          Row({ space: 5 }) {
            if (this.creatingSession) {
              LoadingProgress()
                .width(14)
                .height(14)
                .color('#FFFFFF')
            } else {
              Image($r('app.media.ic_plus'))
                .width(14)
                .height(14)
                .fillColor('#FFFFFF')
            }
            Text(this.creatingSession ? '创建中' : '新会话')
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .fontColor('#FFFFFF')
          }
          .justifyContent(FlexAlign.Center)
        }
        .height(36)
        .padding({ left: 12, right: 12 })
        .borderRadius(11)
        .backgroundColor(DshTheme.accent)
        .stateEffect(true)
        .enabled(!this.creatingSession)
        .onClick(() => {
          this.createSession();
        })
      }
      .width('100%')

      Row({ space: 6 }) {
        Text(`${this.sessions.length}`)
          .fontSize(10)
          .fontWeight(FontWeight.Bold)
          .fontColor(DshTheme.accentBright)
        Text('个会话')
          .fontSize(10)
          .fontColor(DshTheme.faint)
        Blank()
        if (this.transportOnline && this.agentOnline) {
          Text('ACP 通道正常')
            .fontSize(10)
            .fontColor(DshTheme.success)
        } else {
          Text(this.transportOnline ? '等待 DSH 就绪' : '等待网关重连')
            .fontSize(10)
            .fontColor(DshTheme.warning)
        }
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.surface)
    .borderRadius(18)
    .border({ width: 1, color: DshTheme.border })
  }

  @Builder
  warningBanner() {
    Row({ space: 9 }) {
      Text('!')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(DshTheme.warning)
        .textAlign(TextAlign.Center)
        .width(20)
        .height(20)
        .borderRadius(10)
        .backgroundColor('#3A2B13')
      Text(this.warningText())
        .fontSize(11)
        .lineHeight(17)
        .fontColor(DshTheme.warning)
        .layoutWeight(1)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(this.transportOnline ? '重试' : '重连')
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(DshTheme.accentBright)
        .onClick(() => {
          if (this.transportOnline) {
            this.loadSessions();
          } else {
            this.reconnectNow();
          }
        })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .backgroundColor('#241D12')
    .borderRadius(13)
    .border({ width: 1, color: '#42321A' })
  }

  @Builder
  emptySessions() {
    Column({ space: 12 }) {
      Stack() {
        Image($r('app.media.ic_spark'))
          .width(28)
          .height(28)
          .fillColor(DshTheme.accentBright)
      }
      .width(64)
      .height(64)
      .borderRadius(22)
      .backgroundColor('#141D35')
      .border({ width: 1, color: '#243257' })
      Text('还没有会话')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(DshTheme.text)
      Text('在工作区里启动第一个任务，\n工具调用会在手机上等待审批。')
        .fontSize(12)
        .lineHeight(19)
        .fontColor(DshTheme.muted)
        .textAlign(TextAlign.Center)
      Button() {
        Row({ space: 6 }) {
          Image($r('app.media.ic_plus'))
            .width(14)
            .height(14)
            .fillColor('#FFFFFF')
          Text('新建会话')
            .fontSize(13)
            .fontColor('#FFFFFF')
        }
      }
      .height(40)
      .padding({ left: 16, right: 16 })
      .borderRadius(12)
      .backgroundColor(DshTheme.accent)
      .onClick(() => {
        this.createSession();
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ bottom: 40 })
  }

  @Builder
  sessionsView() {
    Row() {
      Column({ space: 13 }) {
        this.sessionsHeader()
        this.workspaceCard()
        if (this.warningText().length > 0) {
          this.warningBanner()
        }
        Row({ space: 8 }) {
          Text('会话')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor(DshTheme.text)
          Text(`${this.sessions.length}`)
            .fontSize(10)
            .fontColor(DshTheme.muted)
            .padding({ left: 7, right: 7, top: 2, bottom: 2 })
            .backgroundColor(DshTheme.surface)
            .borderRadius(9)
          Blank()
          if (this.sessionsLoading) {
            LoadingProgress()
              .width(16)
              .height(16)
              .color(DshTheme.accentBright)
          } else {
            DshIconButton({
              iconValue: $r('app.media.ic_refresh'),
              tintValue: DshTheme.textSecondary,
              bgValue: DshTheme.surface,
              sizeValue: 32,
              iconSizeValue: 16,
              onPress: () => {
                this.loadSessions();
              }
            })
          }
        }
        .width('100%')

        if (this.sessions.length === 0 && !this.sessionsLoading) {
          this.emptySessions()
        } else {
          List({ space: 10 }) {
            ForEach(this.sessions, (session: DshSessionSummary) => {
              ListItem() {
                DshSessionCard({
                  sessionValue: session,
                  onOpen: (value: DshSessionSummary) => {
                    this.openChat(value);
                  }
                })
              }
            }, (session: DshSessionSummary): string => `${session.sessionId}-${session.updatedAt}-${session.running ? '1' : '0'}`)
          }
          .width('100%')
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
          .padding({ bottom: 16 })
        }
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: DshTheme.pageMaxWidth })
      .padding({ left: 16, right: 16, top: 12 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor(DshTheme.bg)
  }

  @Builder
  infoRow(labelValue: string, valueValue: string) {
    Column({ space: 3 }) {
      Text(labelValue)
        .fontSize(10)
        .fontColor(DshTheme.muted)
      Text(valueValue)
        .fontSize(12)
        .fontColor(DshTheme.textSecondary)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 7, bottom: 7 })
  }

  @Builder
  actionRow(labelValue: string, dangerValue: boolean, arrowValue: boolean) {
    Row({ space: 8 }) {
      Text(labelValue)
        .fontSize(14)
        .fontColor(dangerValue ? DshTheme.danger : DshTheme.text)
        .layoutWeight(1)
      if (arrowValue) {
        Image($r('app.media.ic_back'))
          .width(13)
          .height(13)
          .fillColor(DshTheme.faint)
          .rotate({ angle: 180 })
      }
    }
    .width('100%')
    .padding({ left: 4, right: 4, top: 13, bottom: 13 })
  }

  @Builder
  settingsSheet() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('连接设置')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(DshTheme.text)
          .layoutWeight(1)
        DshIconButton({
          iconValue: $r('app.media.ic_close'),
          tintValue: DshTheme.textSecondary,
          bgValue: DshTheme.surfaceHigh,
          sizeValue: 34,
          iconSizeValue: 15,
          onPress: () => {
            this.showSettings = false;
          }
        })
      }
      .width('100%')
      .padding({ top: 4, bottom: 4 })

      Scroll() {
        Column({ space: 4 }) {
          this.infoRow('网关地址', this.serverUrl)
          this.infoRow('工作区', this.defaultCwd)
          this.infoRow('Harness', `${this.agentVersion.length > 0 ? this.agentVersion : '未连接'}${this.agentOnline ? ' · 在线' : ' · 离线'}`)
          this.infoRow('Bridge', this.bridgeVersion.length > 0 ? this.bridgeVersion : '未连接')

          Divider()
            .color(DshTheme.border)
            .margin({ top: 8, bottom: 8 })

          Column() {
            this.actionRow('重新连接', false, true)
          }
          .width('100%')
          .onClick(() => {
            this.reconnectNow();
          })

          Column() {
            this.actionRow('修改连接', false, true)
          }
          .width('100%')
          .onClick(() => {
            this.editConnection();
          })

          Column() {
            this.actionRow('关于 DSH Remote', false, true)
          }
          .width('100%')
          .onClick(() => {
            this.showAbout();
          })

          Column() {
            this.actionRow('断开连接', true, false)
          }
          .width('100%')
          .onClick(() => {
            this.disconnectNow();
          })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 20, right: 20, bottom: 20 })
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.surface)
  }

  @Builder
  approvalOverlay() {
    Column() {
      Blank()
      Row() {
        Column({ space: 12 }) {
          Row({ space: 10 }) {
            Stack() {
              Image($r('app.media.ic_shield'))
                .width(19)
                .height(19)
                .fillColor(DshTheme.warning)
            }
            .width(36)
            .height(36)
            .borderRadius(11)
            .backgroundColor('#33260F')
            .border({ width: 1, color: '#4E3A18' })

            Column({ space: 2 }) {
              Text('需要你的授权')
                .fontSize(16)
                .fontWeight(FontWeight.Bold)
                .fontColor(DshTheme.text)
              Text(`${this.approvalData.label.length > 0 ? this.approvalData.label : '工具调用'} · ${this.approvalData.title}`)
                .fontSize(11)
                .fontColor(DshTheme.muted)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)

            if (this.approvalQueue.length > 0) {
              Text(`+${this.approvalQueue.length}`)
                .fontSize(10)
                .fontColor(DshTheme.warning)
                .padding({ left: 7, right: 7, top: 3, bottom: 3 })
                .backgroundColor('#33260F')
                .borderRadius(9)
            }
          }
          .width('100%')

          if (this.approvalData.input.length > 0) {
            Scroll() {
              Text(this.approvalData.input)
                .fontSize(11)
                .fontFamily('monospace')
                .fontColor('#C7D2E5')
                .lineHeight(17)
                .copyOption(CopyOptions.LocalDevice)
                .padding(10)
                .width('100%')
            }
            .width('100%')
            .constraintSize({ maxHeight: 168 })
            .scrollBar(BarState.Off)
            .backgroundColor(DshTheme.codeBg)
            .borderRadius(10)
            .border({ width: 1, color: '#1C2431' })
          }

          Text('批准后，该工具将以网关进程权限执行。10 分钟内未处理会自动取消。')
            .fontSize(10)
            .lineHeight(16)
            .fontColor(DshTheme.faint)
            .width('100%')

          Row({ space: 10 }) {
            Button() {
              Text('拒绝')
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .fontColor(DshTheme.textSecondary)
            }
            .layoutWeight(1)
            .height(46)
            .borderRadius(13)
            .backgroundColor(DshTheme.surfaceHigh)
            .border({ width: 1, color: DshTheme.border })
            .enabled(!this.approvalBusy)
            .onClick(() => {
              this.respondApproval(this.rejectOptionId());
            })

            Button() {
              Row({ space: 7 }) {
                if (this.approvalBusy) {
                  LoadingProgress()
                    .width(15)
                    .height(15)
                    .color('#FFFFFF')
                } else {
                  Image($r('app.media.ic_check'))
                    .width(15)
                    .height(15)
                    .fillColor('#FFFFFF')
                }
                Text('允许一次')
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#FFFFFF')
              }
            }
            .layoutWeight(1)
            .height(46)
            .borderRadius(13)
            .backgroundColor(this.allowOptionId().length > 0 ? DshTheme.accent : DshTheme.surfaceHigh)
            .enabled(!this.approvalBusy && this.allowOptionId().length > 0)
            .onClick(() => {
              this.respondApproval(this.allowOptionId());
            })
          }
          .width('100%')
        }
        .width('100%')
        .constraintSize({ maxWidth: 560 })
        .padding(16)
        .alignItems(HorizontalAlign.Start)
        .backgroundColor(DshTheme.surface)
        .borderRadius(22)
        .border({ width: 1, color: DshTheme.borderStrong })
        .shadow({ radius: 26, color: '#AA000000', offsetX: 0, offsetY: 10 })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 16, right: 16, bottom: 16 })
    .backgroundColor(DshTheme.overlay)
  }

  @Builder
  pageMapBuilder(name: string, param: Object) {
    if (name === 'Chat') {
      ChatPage({ chatParams: param as DshChatParams })
    }
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Navigation(this.pathStack) {
        if (this.booting) {
          this.bootView()
        } else if (this.workspaceActive) {
          this.sessionsView()
        } else {
          this.connectView()
        }
      }
      .mode(NavigationMode.Stack)
      .hideTitleBar(true)
      .hideToolBar(true)
      .navDestination(this.pageMapBuilder)
      .width('100%')
      .height('100%')
      .backgroundColor(DshTheme.bg)

      if (this.hasApproval) {
        this.approvalOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(DshTheme.bg)
    .bindSheet($$this.showSettings, this.settingsSheet(), {
      height: 440,
      dragBar: true,
      showClose: false,
      backgroundColor: DshTheme.surface
    })
  }
}
