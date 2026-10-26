@Component
export struct DshLogo {
  @Prop sizeValue: number = 40;

  build() {
    Stack() {
      Text('DS')
        .fontSize(this.sizeValue * 0.33)
        .fontWeight(FontWeight.Bold)
        .fontColor('#FFFFFF')
        .letterSpacing(0.4)
    }
    .width(this.sizeValue)
    .height(this.sizeValue)
    .borderRadius(this.sizeValue * 0.3)
    .linearGradient({
      angle: 135,
      colors: [['#8AA1FF', 0.0], ['#4562E6', 0.58], ['#24379C', 1.0]]
    })
    .border({ width: 1, color: '#526BCB' })
    .shadow({ radius: 14, color: '#552B3FA8', offsetX: 0, offsetY: 5 })
  }
}
