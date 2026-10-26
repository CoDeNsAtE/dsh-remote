import {
  DshChatItem,
  DshChatParams,
  DshConfigOption,
  DshOpenResult,
  DshWireFrame
} from '../model/DshTypes';
import { DshChatItemView } from '../components/DshChatItemView';
import { DshConfigSheet } from '../components/DshConfigSheet';
import { DshIconButton } from '../components/DshIconButton';
import { DshLogo } from '../components/DshLogo';
import { DshClient } from '../service/DshClient';
import { DshTheme } from '../theme/DshTheme';
import { DshFormat } from '../util/DshFormat';

@Component
export struct ChatPage {
  @Prop chatParams: DshChatParams = new DshChatParams('', '', '');
  @State items: DshChatItem[] = [];
  @State loading: boolean = true;
  @State openError: string = '';
  @State warning: string = '';
  @State attached: boolean = true;
  @State running: boolean = false;
  @State cancelling: boolean = false;
  @State transportOnline: boolean = true;
  @State agentOnline: boolean = true;
  @State sessionTitleValue: string = '';
  @State sessionCwd: string = '';
  @State draft: string = '';
  @State configOptions: DshConfigOption[] = [];
  @State showConfig: boolean = false;
  @State modelLabel: string = '模型';
  @State reasoningLabel: string = '';
  @State usageUsed: number = 0;
  @State usageSize: number = 0;
  @State configBusy: boolean = false;
  @State reconnecting: boolean = false;

  private navStack: NavPathStack = new NavPathStack();
  private scroller: Scroller = new Scroller();
  private client: DshClient = DshClient.getInstance();
  private removeListener: (() => void) | undefined = undefined;

  aboutToAppear(): void {
    this.sessionTitleValue = this.chatParams.sessionTitle;
    this.sessionCwd = this.chatParams.cwd;
    this.transportOnline = this.client.isConnected();
    this.removeListener = this.client.addEventListener((frame: DshWireFrame) => {
      this.handleEvent(frame);
    });
    this.prepare();
  }

  aboutToDisappear(): void {
    if (this.removeListener !== undefined) {
      this.removeListener();
      this.removeListener = undefined;
    }
  }

  private async prepare(): Promise<void> {
    if (!this.transportOnline) {
      try {
        await this.client.reconnect();
        this.transportOnline = true;
      } catch (error) {
        this.openError = `无法连接网关：${(error as Error).message}`;
        this.loading = false;
        return;
      }
    }
    await this.loadSession();
  }

  private async loadSession(): Promise<void> {
    this.loading = true;
    this.openError = '';
    try {
      const result: DshOpenResult = await this.client.openSession(this.chatParams.sessionId, this.chatParams.cwd);
      const mapped: DshChatItem[] = [];
      for (let index = 0; index < result.items.length; index++) {
        mapped.push(this.toItem(result.items[index]));
      }
      this.items = mapped;
      this.applyConfigs(result.configOptions);
      this.attached = result.attached;
      this.agentOnline = result.attached;
      this.warning = result.warning;
      this.running = result.session.running;
      this.sessionTitleValue = result.session.title.length > 0 ? result.session.title : this.chatParams.sessionTitle;
      this.sessionCwd = result.session.cwd.length > 0 ? result.session.cwd : this.chatParams.cwd;
      this.transportOnline = true;
      this.loading = false;
      this.scrollToBottom();
    } catch (error) {
      this.openError = (error as Error).message;
      this.attached = false;
      this.agentOnline = false;
      this.running = false;
      this.loading = false;
    }
  }

  private handleEvent(frame: DshWireFrame): void {
    if (frame.event === 'connection.status') {
      this.transportOnline = frame.online === true;
      if (!this.transportOnline) {
        this.running = false;
        this.cancelling = false;
        this.agentOnline = false;
      }
      return;
    }
    if (frame.event === 'bridge.status') {
      this.agentOnline = frame.online === true;
      return;
    }
    if (frame.sessionId !== undefined && frame.sessionId !== this.chatParams.sessionId) {
      return;
    }
    if (frame.event === 'session.updated' && frame.session !== undefined) {
      if (frame.session.sessionId !== this.chatParams.sessionId) {
        return;
      }
      if (frame.session.title.length > 0) {
        this.sessionTitleValue = frame.session.title;
      }
      this.running = frame.session.running;
      return;
    }
    if (frame.event === 'turn.status') {
      this.agentOnline = true;
      this.running = frame.status === 'running';
      if (!this.running) {
        this.cancelling = false;
      }
      return;
    }
    if (frame.event === 'item.upsert' && frame.item !== undefined) {
      this.agentOnline = true;
      this.upsertItem(frame.item);
      return;
    }
    if (frame.event === 'config.updated') {
      this.applyConfigs(frame.configOptions ?? []);
      return;
    }
    if (frame.event === 'usage.updated') {
      this.usageUsed = frame.used ?? 0;
      this.usageSize = frame.size ?? 0;
      return;
    }
  }

  private applyConfigs(options: DshConfigOption[]): void {
    this.configOptions = options;
    this.modelLabel = DshFormat.modelName(options);
    this.reasoningLabel = DshFormat.reasoningName(options);
  }

  private toItem(source: DshChatItem): DshChatItem {
    const target = new DshChatItem();
    this.copyInto(target, source);
    return target;
  }

  private copyInto(target: DshChatItem, source: DshChatItem): void {
    target.id = source.id ?? '';
    target.kind = source.kind ?? 'notice';
    target.text = source.text ?? '';
    target.time = source.time ?? 0;
    target.title = source.title ?? '';
    target.label = source.label ?? '';
    target.status = source.status ?? '';
    target.toolCallId = source.toolCallId ?? '';
    target.input = source.input ?? '';
    target.result = source.result ?? '';
    target.collapsed = source.collapsed === true;
  }

  private upsertItem(item: DshChatItem): void {
    for (let index = 0; index < this.items.length; index++) {
      if (this.items[index].id === item.id) {
        this.copyInto(this.items[index], item);
        this.scrollToBottom();
        return;
      }
    }
    const next = this.items.slice();
    next.push(this.toItem(item));
    this.items = next;
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      try {
        this.scroller.scrollEdge(Edge.Bottom);
      } catch (error) {
        // The list may not be mounted yet.
      }
    }, 40);
  }

  private canInteract(): boolean {
    return this.transportOnline && this.agentOnline && this.attached && !this.loading;
  }

  private canSend(): boolean {
    return this.canInteract() && !this.running && this.draft.trim().length > 0;
  }

  private async sendPrompt(): Promise<void> {
    if (!this.canSend()) {
      return;
    }
    const text = this.draft.trim();
    if (text.length === 0) {
      return;
    }
    this.draft = '';
    this.running = true;
    this.cancelling = false;
    try {
      await this.client.prompt(this.chatParams.sessionId, text);
      this.running = false;
      this.cancelling = false;
    } catch (error) {
      this.running = false;
      this.cancelling = false;
      this.showToast(`发送失败：${(error as Error).message}`);
    }
  }

  private async cancelTurn(): Promise<void> {
    if (!this.running || this.cancelling) {
      return;
    }
    this.cancelling = true;
    try {
      await this.client.cancel(this.chatParams.sessionId);
    } catch (error) {
      this.cancelling = false;
      this.showToast(`取消失败：${(error as Error).message}`);
    }
  }

  private async changeConfig(configId: string, value: string): Promise<void> {
    if (this.configBusy || !this.canInteract()) {
      return;
    }
    this.configBusy = true;
    try {
      const options = await this.client.setConfig(this.chatParams.sessionId, configId, value);
      this.applyConfigs(options);
      this.showToast('会话设置已更新');
    } catch (error) {
      this.showToast(`设置失败：${(error as Error).message}`);
    } finally {
      this.configBusy = false;
    }
  }

  private async retryConnection(): Promise<void> {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.openError = '';
    try {
      if (!this.client.isConnected()) {
        await this.client.reconnect();
        this.transportOnline = true;
      }
      await this.loadSession();
    } catch (error) {
      this.openError = (error as Error).message;
      this.loading = false;
    } finally {
      this.reconnecting = false;
    }
  }

  private showToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 2200 });
    } catch (error) {
      // A toast failure must not interrupt the conversation flow.
    }
  }

  private bannerVisible(): boolean {
    return !this.transportOnline || !this.agentOnline || !this.attached || this.warning.length > 0 || this.openError.length > 0;
  }

  private bannerIsError(): boolean {
    return !this.transportOnline || this.openError.length > 0;
  }

  private bannerText(): string {
    if (!this.transportOnline) {
      return '与网关的连接已断开，重连后可继续当前会话。';
    }
    if (this.openError.length > 0) {
      return this.openError;
    }
    if (!this.agentOnline) {
      return 'DSH 进程未就绪，重试会重新拉起 Harness 并恢复会话。';
    }
    if (!this.attached) {
      return this.warning.length > 0 ? this.warning : 'DSH 暂时无法恢复该会话，当前显示手机端缓存，发送已禁用。';
    }
    return this.warning;
  }

  private usageText(): string {
    if (this.usageSize <= 0) {
      return '';
    }
    const percent = Math.round((this.usageUsed / this.usageSize) * 100);
    return `上下文 ${percent}%`;
  }

  private subtitleText(): string {
    let value = this.modelLabel;
    if (this.reasoningLabel.length > 0) {
      value = `${value} · ${this.reasoningLabel}`;
    }
    if (this.running) {
      value = this.cancelling ? `${value} · 正在取消` : `${value} · 运行中`;
    }
    return value;
  }

  @Builder
  headerBar() {
    Row({ space: 8 }) {
      DshIconButton({
        iconValue: $r('app.media.ic_back'),
        tintValue: DshTheme.textSecondary,
        bgValue: DshTheme.surface,
        sizeValue: 36,
        iconSizeValue: 18,
        onPress: () => {
          this.navStack.pop();
        }
      })
      Column({ space: 2 }) {
        Text(this.sessionTitleValue.length > 0 ? this.sessionTitleValue : '会话')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(DshTheme.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Row({ space: 5 }) {
          if (this.running) {
            Text('●')
              .fontSize(6)
              .fontColor(this.cancelling ? DshTheme.warning : DshTheme.success)
          }
          Text(this.subtitleText())
            .fontSize(10)
            .fontColor(DshTheme.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      DshIconButton({
        iconValue: $r('app.media.ic_settings'),
        tintValue: this.canInteract() ? DshTheme.textSecondary : DshTheme.faint,
        bgValue: DshTheme.surface,
        sizeValue: 36,
        iconSizeValue: 18,
        onPress: () => {
          if (this.canInteract()) {
            this.showConfig = true;
          }
        }
      })
    }
    .width('100%')
    .padding({ left: 10, right: 12, top: 6, bottom: 8 })
  }

  @Builder
  warningBanner() {
    Row({ space: 8 }) {
      Text('!')
        .fontSize(10)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.bannerIsError() ? DshTheme.danger : DshTheme.warning)
        .textAlign(TextAlign.Center)
        .width(18)
        .height(18)
        .borderRadius(9)
        .backgroundColor(this.bannerIsError() ? '#2D171C' : '#33260F')
      Text(this.bannerText())
        .fontSize(11)
        .lineHeight(16)
        .fontColor(this.bannerIsError() ? DshTheme.danger : DshTheme.warning)
        .layoutWeight(1)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.reconnecting) {
        LoadingProgress()
          .width(14)
          .height(14)
          .color(DshTheme.accentBright)
      } else {
        Text('重试')
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(DshTheme.accentBright)
          .onClick(() => {
            this.retryConnection();
          })
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .backgroundColor(this.bannerIsError() ? '#241216' : '#241D12')
    .borderRadius(12)
    .border({ width: 1, color: this.bannerIsError() ? '#45222A' : '#42321A' })
  }

  @Builder
  loadingState() {
    Column({ space: 12 }) {
      LoadingProgress()
        .width(26)
        .height(26)
        .color(DshTheme.accentBright)
      Text('正在恢复会话…')
        .fontSize(12)
        .fontColor(DshTheme.muted)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  errorState() {
    Column({ space: 12 }) {
      Text('会话暂时打不开')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(DshTheme.text)
      Text(this.openError)
        .fontSize(12)
        .lineHeight(19)
        .fontColor(DshTheme.muted)
        .textAlign(TextAlign.Center)
        .padding({ left: 24, right: 24 })
      Button() {
        Text('重试')
          .fontSize(13)
          .fontColor('#FFFFFF')
      }
      .height(38)
      .padding({ left: 18, right: 18 })
      .borderRadius(12)
      .backgroundColor(DshTheme.accent)
      .onClick(() => {
        this.retryConnection();
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  suggestionRow(textValue: string) {
    Row({ space: 9 }) {
      Image($r('app.media.ic_spark'))
        .width(14)
        .height(14)
        .fillColor(DshTheme.accentBright)
      Text(textValue)
        .fontSize(12)
        .fontColor(DshTheme.textSecondary)
        .layoutWeight(1)
      Image($r('app.media.ic_back'))
        .width(12)
        .height(12)
        .fillColor(DshTheme.faint)
        .rotate({ angle: 180 })
    }
    .width('100%')
    .padding({ left: 13, right: 13, top: 11, bottom: 11 })
    .backgroundColor(DshTheme.surface)
    .borderRadius(12)
    .border({ width: 1, color: DshTheme.border })
    .onClick(() => {
      this.draft = textValue;
    })
  }

  @Builder
  emptyState() {
    Column({ space: 13 }) {
      DshLogo({ sizeValue: 52 })
      Text('从当前工作区开始')
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor(DshTheme.text)
      Text(DshFormat.shortCwd(this.sessionCwd))
        .fontSize(11)
        .fontColor(DshTheme.faint)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Column({ space: 8 }) {
        this.suggestionRow('总结这个项目，并列出三个风险点')
        this.suggestionRow('检查当前构建错误并修复')
        this.suggestionRow('解释最近的改动，给出提交说明')
      }
      .width('100%')
      .constraintSize({ maxWidth: 460 })
      .margin({ top: 6 })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 20, right: 20, bottom: 16 })
  }

  @Builder
  messageList() {
    List({ scroller: this.scroller, space: 14 }) {
      ForEach(this.items, (item: DshChatItem) => {
        ListItem() {
          DshChatItemView({ itemValue: item })
        }
      }, (item: DshChatItem): string => item.id)
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .padding({ left: 14, right: 14, top: 8, bottom: 12 })
  }

  @Builder
  composer() {
    Column({ space: 7 }) {
      Row({ space: 9 }) {
        TextArea({ placeholder: this.attached ? '继续给 DSH 下指令…' : '当前为只读历史', text: $$this.draft })
          .fontSize(15)
          .fontColor(DshTheme.text)
          .placeholderColor(DshTheme.faint)
          .caretColor(DshTheme.accentBright)
          .backgroundColor(Color.Transparent)
          .constraintSize({ minHeight: 42, maxHeight: 128 })
          .padding({ left: 2, right: 2, top: 8, bottom: 8 })
          .maxLength(20000)
          .enabled(this.canInteract())
          .onChange((value: string) => {
            this.draft = value;
          })
          .layoutWeight(1)

        if (this.running) {
          Button() {
            if (this.cancelling) {
              LoadingProgress()
                .width(18)
                .height(18)
                .color('#FFFFFF')
            } else {
              Image($r('app.media.ic_stop'))
                .width(18)
                .height(18)
                .fillColor('#FFFFFF')
            }
          }
          .width(44)
          .height(44)
          .borderRadius(22)
          .backgroundColor(this.cancelling ? DshTheme.surfaceHigh : DshTheme.danger)
          .enabled(!this.cancelling)
          .onClick(() => {
            this.cancelTurn();
          })
        } else {
          Button() {
            Image($r('app.media.ic_send'))
              .width(19)
              .height(19)
              .fillColor('#FFFFFF')
          }
          .width(44)
          .height(44)
          .borderRadius(22)
          .backgroundColor(this.canSend() ? DshTheme.accent : DshTheme.surfaceHigh)
          .enabled(this.canSend())
          .onClick(() => {
            this.sendPrompt();
          })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Bottom)

      Row({ space: 6 }) {
        Image($r('app.media.ic_lock'))
          .width(10)
          .height(10)
          .fillColor(DshTheme.faint)
        Text(this.attached ? '工具调用需审批 · 支持多轮任务' : '只读缓存 · 重连后可继续')
          .fontSize(9)
          .fontColor(DshTheme.faint)
        Blank()
        if (this.usageText().length > 0) {
          Text(this.usageText())
            .fontSize(9)
            .fontColor(DshTheme.faint)
        }
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 9, bottom: 9 })
    .backgroundColor(DshTheme.surface)
    .border({ width: 1, color: DshTheme.border })
    .borderRadius(18)
  }

  @Builder
  configSheet() {
    DshConfigSheet({
      optionsValue: this.configOptions,
      onChoose: (configId: string, value: string) => {
        this.changeConfig(configId, value);
      },
      onClose: () => {
        this.showConfig = false;
      }
    })
  }

  build() {
    NavDestination() {
      Row() {
        Column() {
          this.headerBar()
          if (this.bannerVisible()) {
            Row() {
              this.warningBanner()
            }
            .width('100%')
            .padding({ left: 14, right: 14, bottom: 8 })
          }
          if (this.loading) {
            this.loadingState()
          } else if (this.openError.length > 0 && this.items.length === 0) {
            this.errorState()
          } else if (this.items.length === 0) {
            this.emptyState()
          } else {
            this.messageList()
          }
          this.composer()
        }
        .width('100%')
        .height('100%')
        .constraintSize({ maxWidth: 780 })
        .padding({ top: 4 })
        .bindSheet($$this.showConfig, this.configSheet(), {
          detents: [SheetSize.MEDIUM, SheetSize.LARGE],
          dragBar: true,
          showClose: false,
          backgroundColor: DshTheme.surface
        })
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .backgroundColor(DshTheme.bg)
    }
    .hideTitleBar(true)
    .backgroundColor(DshTheme.bg)
    .onReady((context: NavDestinationContext) => {
      this.navStack = context.pathStack;
    })
  }
}
