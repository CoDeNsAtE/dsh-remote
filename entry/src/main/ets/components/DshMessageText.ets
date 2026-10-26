import { DshTextSegment } from '../model/DshTypes';
import { DshTheme } from '../theme/DshTheme';
import { DshFormat } from '../util/DshFormat';
import { DshCodeBlock } from './DshCodeBlock';

@Component
export struct DshMessageText {
  @Prop @Watch('rebuildSegments') textValue: string = '';
  @State segments: DshTextSegment[] = [];

  aboutToAppear(): void {
    this.rebuildSegments();
  }

  rebuildSegments(): void {
    this.segments = DshFormat.parseSegments(this.textValue);
  }

  build() {
    Column({ space: 8 }) {
      ForEach(this.segments, (segment: DshTextSegment) => {
        if (segment.kind === 'code') {
          DshCodeBlock({
            contentValue: segment.content,
            langValue: segment.lang,
            maxLinesValue: 0,
            showHeaderValue: true
          })
        } else {
          Text(segment.content)
            .fontSize(15)
            .lineHeight(24)
            .fontColor(DshTheme.text)
            .copyOption(CopyOptions.LocalDevice)
            .wordBreak(WordBreak.BREAK_WORD)
            .width('100%')
        }
      }, (segment: DshTextSegment): string => segment.key)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
