import { DshTheme } from '../theme/DshTheme';

@Component
export struct DshStatusChip {
  @Prop labelValue: string = '未连接';
  @Prop toneValue: string = 'offline';
  @Prop showDotValue: boolean = true;

  private dotColor(): string {
    if (this.toneValue === 'online') {
      return DshTheme.success;
    }
    if (this.toneValue === 'warn') {
      return DshTheme.warning;
    }
    if (this.toneValue === 'accent') {
      return DshTheme.accentBright;
    }
    if (this.toneValue === 'danger') {
      return DshTheme.danger;
    }
    return DshTheme.muted;
  }

  private fillColor(): string {
    if (this.toneValue === 'online') {
      return '#112B25';
    }
    if (this.toneValue === 'warn') {
      return '#2C2414';
    }
    if (this.toneValue === 'accent') {
      return '#18234A';
    }
    if (this.toneValue === 'danger') {
      return '#2D171C';
    }
    return '#191E28';
  }

  private strokeColor(): string {
    if (this.toneValue === 'online') {
      return '#1E4A3C';
    }
    if (this.toneValue === 'warn') {
      return '#4A3A19';
    }
    if (this.toneValue === 'accent') {
      return '#293B7A';
    }
    if (this.toneValue === 'danger') {
      return '#55262E';
    }
    return '#262D3B';
  }

  build() {
    Row({ space: 6 }) {
      if (this.showDotValue) {
        Text('●')
          .fontSize(7)
          .fontColor(this.dotColor())
      }
      Text(this.labelValue)
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.dotColor())
        .maxLines(1)
    }
    .padding({ left: 9, right: 9, top: 5, bottom: 5 })
    .backgroundColor(this.fillColor())
    .borderRadius(20)
    .border({ width: 1, color: this.strokeColor() })
  }
}
