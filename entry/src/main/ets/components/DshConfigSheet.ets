import { DshConfigOption, DshConfigRow } from '../model/DshTypes';
import { DshTheme } from '../theme/DshTheme';
import { DshIconButton } from './DshIconButton';

@Component
export struct DshConfigSheet {
  @Prop @Watch('rebuildRows') optionsValue: DshConfigOption[] = [];
  @State rows: DshConfigRow[] = [];
  onChoose: (configId: string, value: string) => void = (configId: string, value: string) => {
  };
  onClose: () => void = () => {
  };

  aboutToAppear(): void {
    this.rebuildRows();
  }

  rebuildRows(): void {
    const next: DshConfigRow[] = [];
    for (let optionIndex = 0; optionIndex < this.optionsValue.length; optionIndex++) {
      const option = this.optionsValue[optionIndex];
      const header: DshConfigRow = {
        rowKey: `header-${option.id}`,
        rowKind: 'header',
        rowLabel: option.name,
        configId: option.id,
        choiceValue: '',
        selected: false
      };
      next.push(header);

      let groupName = '';
      for (let choiceIndex = 0; choiceIndex < option.choices.length; choiceIndex++) {
        const choice = option.choices[choiceIndex];
        if (choice.group.length > 0 && choice.group !== groupName) {
          groupName = choice.group;
          const groupRow: DshConfigRow = {
            rowKey: `group-${option.id}-${groupName}`,
            rowKind: 'group',
            rowLabel: groupName,
            configId: option.id,
            choiceValue: '',
            selected: false
          };
          next.push(groupRow);
        }
        const choiceRow: DshConfigRow = {
          rowKey: `choice-${option.id}-${choice.value}`,
          rowKind: 'choice',
          rowLabel: choice.name,
          configId: option.id,
          choiceValue: choice.value,
          selected: choice.value === option.currentValue
        };
        next.push(choiceRow);
      }
    }
    this.rows = next;
  }

  @Builder
  sheetHeader() {
    Row({ space: 10 }) {
      Column({ space: 3 }) {
        Text('会话设置')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(DshTheme.text)
        Text('模型与推理强度将应用到下一轮对话')
          .fontSize(11)
          .fontColor(DshTheme.muted)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      DshIconButton({
        iconValue: $r('app.media.ic_close'),
        tintValue: DshTheme.textSecondary,
        bgValue: DshTheme.surfaceHigh,
        sizeValue: 34,
        iconSizeValue: 15,
        onPress: () => {
          this.onClose();
        }
      })
    }
    .width('100%')
    .padding({ left: 20, right: 18, top: 4, bottom: 12 })
  }

  @Builder
  emptyState() {
    Column({ space: 8 }) {
      Text('当前会话没有可调整的选项')
        .fontSize(13)
        .fontColor(DshTheme.muted)
      Text('DSH 会在会话启动后上报模型目录')
        .fontSize(11)
        .fontColor(DshTheme.faint)
    }
    .width('100%')
    .padding({ top: 40, bottom: 40 })
  }

  build() {
    Column() {
      this.sheetHeader()
      if (this.rows.length === 0) {
        this.emptyState()
      } else {
        List({ space: 3 }) {
          ForEach(this.rows, (row: DshConfigRow) => {
            ListItem() {
              if (row.rowKind === 'header') {
                Text(row.rowLabel)
                  .fontSize(11)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(DshTheme.textSecondary)
                  .padding({ left: 20, right: 20, top: 14, bottom: 4 })
                  .width('100%')
              } else if (row.rowKind === 'group') {
                Text(row.rowLabel.toUpperCase())
                  .fontSize(9)
                  .fontColor(DshTheme.faint)
                  .letterSpacing(0.8)
                  .padding({ left: 20, right: 20, top: 8, bottom: 2 })
                  .width('100%')
              } else {
                Row({ space: 10 }) {
                  Column({ space: 2 }) {
                    Text(row.rowLabel)
                      .fontSize(14)
                      .fontColor(row.selected ? DshTheme.text : DshTheme.textSecondary)
                      .maxLines(1)
                    if (row.selected) {
                      Text('当前选择')
                        .fontSize(10)
                        .fontColor(DshTheme.accentBright)
                    }
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                  if (row.selected) {
                    Image($r('app.media.ic_check'))
                      .width(17)
                      .height(17)
                      .fillColor(DshTheme.accentBright)
                  }
                }
                .width('100%')
                .padding({ left: 16, right: 16, top: 11, bottom: 11 })
                .backgroundColor(row.selected ? DshTheme.accentSoft : Color.Transparent)
                .borderRadius(11)
                .onClick(() => {
                  if (!row.selected) {
                    this.onChoose(row.configId, row.choiceValue);
                  }
                })
              }
            }
            .width('100%')
            .padding({ left: 4, right: 4 })
          }, (row: DshConfigRow): string => `${row.rowKey}-${row.selected ? '1' : '0'}`)
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        .padding({ left: 14, right: 14, bottom: 20 })
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(DshTheme.surface)
  }
}
