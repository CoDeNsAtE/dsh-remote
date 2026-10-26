import { DshTheme } from '../theme/DshTheme';

@Component
export struct DshIconButton {
  @Prop iconValue: Resource = $r('app.media.ic_plus');
  @Prop tintValue: string = DshTheme.text;
  @Prop bgValue: string = 'transparent';
  @Prop sizeValue: number = 38;
  @Prop iconSizeValue: number = 19;
  onPress: () => void = () => {
  };

  build() {
    Button() {
      Image(this.iconValue)
        .width(this.iconSizeValue)
        .height(this.iconSizeValue)
        .fillColor(this.tintValue)
        .objectFit(ImageFit.Contain)
    }
    .width(this.sizeValue)
    .height(this.sizeValue)
    .padding(0)
    .borderRadius(this.sizeValue / 3)
    .backgroundColor(this.bgValue)
    .stateEffect(true)
    .onClick(() => {
      this.onPress();
    })
  }
}
