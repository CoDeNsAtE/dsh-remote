import { DshChatItem } from '../model/DshTypes';
import { DshTheme } from '../theme/DshTheme';
import { DshFormat } from '../util/DshFormat';
import { DshCodeBlock } from './DshCodeBlock';
import { DshLogo } from './DshLogo';
import { DshMessageText } from './DshMessageText';
import { DshStatusChip } from './DshStatusChip';

@Component
export struct DshChatItemView {
  @ObjectLink itemValue: DshChatItem;
  @State expandedValue: boolean = false;

  private statusLabel(): string {
    if (this.itemValue.status === 'in_progress' || this.itemValue.status === 'running') {
      return '执行中';
    }
    if (this.itemValue.status === 'completed') {
      return '已完成';
    }
    if (this.itemValue.status === 'failed') {
      return '失败';
    }
    if (this.itemValue.status === 'unknown') {
      return '状态未知';
    }
    return this.itemValue.status.length > 0 ? this.itemValue.status : '待处理';
  }

  private statusTone(): string {
    if (this.itemValue.status === 'completed') {
      return 'online';
    }
    if (this.itemValue.status === 'failed') {
      return 'danger';
    }
    if (this.itemValue.status === 'unknown') {
      return 'offline';
    }
    return 'warn';
  }

  private toolTitle(): string {
    return this.itemValue.label.length > 0 ? this.itemValue.label : '工具调用';
  }

  private noticeColor(): string {
    if (this.itemValue.text.indexOf('失败') >= 0 || this.itemValue.text.indexOf('错误') >= 0) {
      return DshTheme.danger;
    }
    return DshTheme.muted;
  }

  @Builder
  userBubble() {
    Row() {
      Blank()
      Column({ space: 4 }) {
        Text(this.itemValue.text)
          .fontSize(15)
          .lineHeight(23)
          .fontColor('#E9EEFF')
          .copyOption(CopyOptions.LocalDevice)
          .wordBreak(WordBreak.BREAK_WORD)
        Row() {
          Blank()
          Text(DshFormat.clockTime(this.itemValue.time))
            .fontSize(10)
            .fontColor('#8FA2D8')
        }
        .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 14, right: 14, top: 10, bottom: 9 })
      .constraintSize({ maxWidth: '86%' })
      .backgroundColor('#202E58')
      .borderRadius(16)
      .border({ width: 1, color: '#2D3F76' })
    }
    .width('100%')
  }

  @Builder
  assistantBlock() {
    Row({ space: 10 }) {
      DshLogo({ sizeValue: 30 })
      Column({ space: 6 }) {
        Row({ space: 8 }) {
          Text('DSH')
            .fontSize(11)
            .fontWeight(FontWeight.Bold)
            .fontColor(DshTheme.accentBright)
          Text(DshFormat.clockTime(this.itemValue.time))
            .fontSize(10)
            .fontColor(DshTheme.faint)
          Blank()
        }
        .width('100%')
        DshMessageText({ textValue: this.itemValue.text })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ top: 2 })
  }

  @Builder
  thoughtCard() {
    Column({ space: 7 }) {
      Row({ space: 7 }) {
        Image($r('app.media.ic_spark'))
          .width(13)
          .height(13)
          .fillColor(DshTheme.muted)
        Text('思考过程')
          .fontSize(11)
          .fontColor(DshTheme.textSecondary)
        Blank()
        Text(this.expandedValue ? '收起' : '展开')
          .fontSize(10)
          .fontColor(DshTheme.faint)
        Image($r('app.media.ic_chevron_down'))
          .width(12)
          .height(12)
          .fillColor(DshTheme.faint)
          .rotate({ angle: this.expandedValue ? 180 : 0 })
      }
      .width('100%')
      .onClick(() => {
        this.expandedValue = !this.expandedValue;
      })

      Text(this.itemValue.text)
        .fontSize(13)
        .lineHeight(20)
        .fontStyle(FontStyle.Italic)
        .fontColor(DshTheme.textSecondary)
        .copyOption(CopyOptions.LocalDevice)
        .maxLines(this.expandedValue ? 120 : 3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
    .width('100%')
    .padding(12)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('#121824')
    .borderRadius(12)
    .border({ width: 1, color: '#202838' })
  }

  @Builder
  toolCard() {
    Column({ space: 9 }) {
      Row({ space: 9 }) {
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
          Text(this.toolTitle())
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor(DshTheme.text)
            .maxLines(1)
          Text(this.itemValue.title)
            .fontSize(10)
            .fontFamily('monospace')
            .fontColor(DshTheme.faint)
            .maxLines(1)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        DshStatusChip({
          labelValue: this.statusLabel(),
          toneValue: this.statusTone(),
          showDotValue: true
        })
      }
      .width('100%')
      .onClick(() => {
        this.expandedValue = !this.expandedValue;
      })

      if (this.itemValue.input.length > 0) {
        DshCodeBlock({
          contentValue: this.itemValue.input,
          langValue: '输入',
          maxLinesValue: this.expandedValue ? 80 : 5,
          showHeaderValue: true
        })
      }
      if (this.itemValue.result.length > 0) {
        DshCodeBlock({
          contentValue: this.itemValue.result,
          langValue: '输出',
          maxLinesValue: this.expandedValue ? 120 : 5,
          showHeaderValue: true
        })
      }
      if (this.itemValue.input.length > 0 || this.itemValue.result.length > 0) {
        Row() {
          Blank()
          Text(this.expandedValue ? '收起详情' : '展开详情')
            .fontSize(10)
            .fontColor(DshTheme.faint)
            .onClick(() => {
              this.expandedValue = !this.expandedValue;
            })
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding(12)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.surfaceAlt)
    .borderRadius(14)
    .border({ width: 1, color: DshTheme.border })
  }

  @Builder
  noticeRow() {
    Row() {
      Text(this.itemValue.text)
        .fontSize(11)
        .fontColor(this.noticeColor())
        .lineHeight(18)
        .maxLines(6)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .backgroundColor('#141A24')
        .borderRadius(10)
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Column() {
      if (this.itemValue.kind === 'user') {
        this.userBubble()
      } else if (this.itemValue.kind === 'assistant') {
        this.assistantBlock()
      } else if (this.itemValue.kind === 'thought') {
        this.thoughtCard()
      } else if (this.itemValue.kind === 'tool') {
        this.toolCard()
      } else {
        this.noticeRow()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
