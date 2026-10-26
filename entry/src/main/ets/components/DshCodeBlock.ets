import { DshTheme } from '../theme/DshTheme';

@Component
export struct DshCodeBlock {
  @Prop @Watch('onContentChanged') contentValue: string = '';
  @Prop langValue: string = 'code';
  @Prop maxLinesValue: number = 8;
  @Prop showHeaderValue: boolean = true;
  @State expandedValue: boolean = false;
  @State lineCountValue: number = 0;

  aboutToAppear(): void {
    this.lineCountValue = this.countLines();
  }

  onContentChanged(): void {
    this.lineCountValue = this.countLines();
  }

  private countLines(): number {
    if (this.contentValue.length === 0) {
      return 0;
    }
    return this.contentValue.split('\n').length;
  }

  private needsToggle(): boolean {
    return this.maxLinesValue > 0 && this.maxLinesValue < 900 && this.lineCountValue > this.maxLinesValue;
  }

  build() {
    Column() {
      if (this.showHeaderValue || this.needsToggle()) {
        Row({ space: 8 }) {
          if (this.showHeaderValue) {
            Text(this.langValue.length > 0 ? this.langValue : 'code')
              .fontSize(10)
              .fontColor(DshTheme.faint)
              .fontFamily('monospace')
              .maxLines(1)
              .layoutWeight(1)
          } else {
            Blank()
          }
          if (this.needsToggle()) {
            Text(this.expandedValue ? '收起' : '展开')
              .fontSize(10)
              .fontColor(DshTheme.accentBright)
              .onClick(() => {
                this.expandedValue = !this.expandedValue;
              })
          }
        }
        .width('100%')
        .padding({ left: 11, right: 11, top: 7, bottom: 2 })
      }
      Scroll() {
        Text(this.contentValue)
          .fontSize(12)
          .fontFamily('monospace')
          .fontColor('#C7D2E5')
          .lineHeight(18)
          .maxLines(this.expandedValue ? 900 : (this.maxLinesValue > 0 ? this.maxLinesValue : 900))
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .copyOption(CopyOptions.LocalDevice)
          .padding({ left: 11, right: 11, top: 7, bottom: 10 })
      }
      .width('100%')
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.None)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.codeBg)
    .borderRadius(10)
    .border({ width: 1, color: '#1C2431' })
  }
}
