import { DshDefaults, DshSessionSummary } from '../model/DshTypes';
import { DshTheme } from '../theme/DshTheme';
import { DshFormat } from '../util/DshFormat';
import { DshLogo } from './DshLogo';

@Component
export struct DshSessionCard {
  @Prop sessionValue: DshSessionSummary = DshDefaults.session();
  onOpen: (session: DshSessionSummary) => void = (session: DshSessionSummary) => {
  };

  private previewText(): string {
    if (this.sessionValue.preview.length > 0) {
      return this.sessionValue.preview;
    }
    return this.sessionValue.hasTranscript ? '暂无消息' : '手机端暂无历史记录';
  }

  private timeText(): string {
    if (this.sessionValue.updatedAt > 0) {
      return DshFormat.timeAgo(this.sessionValue.updatedAt);
    }
    return '';
  }

  build() {
    Column({ space: 11 }) {
      Row({ space: 11 }) {
        DshLogo({ sizeValue: 40 })

        Column({ space: 4 }) {
          Row({ space: 7 }) {
            Text(this.sessionValue.title.length > 0 ? this.sessionValue.title : '会话')
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor(DshTheme.text)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            if (this.sessionValue.running) {
              Row({ space: 4 }) {
                Text('●')
                  .fontSize(6)
                  .fontColor(DshTheme.success)
                Text('运行中')
                  .fontSize(10)
                  .fontColor(DshTheme.success)
              }
              .padding({ left: 7, right: 7, top: 3, bottom: 3 })
              .backgroundColor('#102A23')
              .borderRadius(10)
            }
          }
          .width('100%')

          Text(this.previewText())
            .fontSize(12)
            .fontColor(DshTheme.muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Image($r('app.media.ic_back'))
          .width(14)
          .height(14)
          .fillColor(DshTheme.faint)
          .rotate({ angle: 180 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: 8 }) {
        Text(DshFormat.shortCwd(this.sessionValue.cwd))
          .fontSize(10)
          .fontColor(DshTheme.faint)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.timeText().length > 0) {
          Text(this.timeText())
            .fontSize(10)
            .fontColor(DshTheme.faint)
        }
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 13, right: 13, top: 13, bottom: 11 })
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.surface)
    .borderRadius(16)
    .border({ width: 1, color: DshTheme.border })
    .onClick(() => {
      this.onOpen(this.sessionValue);
    })
  }
}
