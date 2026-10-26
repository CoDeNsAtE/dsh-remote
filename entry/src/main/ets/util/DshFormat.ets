import { DshConfigChoice, DshConfigOption, DshTextSegment } from '../model/DshTypes';

export class DshFormat {
  static normalizeWsUrl(input: string): string {
    let value = input.trim();
    if (value.length === 0) {
      return '';
    }
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) {
      value = value.substring(0, hashIndex);
    }
    const queryIndex = value.indexOf('?');
    if (queryIndex >= 0) {
      value = value.substring(0, queryIndex);
    }

    let scheme = 'ws://';
    let rest = value;
    const schemeIndex = value.indexOf('://');
    if (schemeIndex >= 0) {
      const rawScheme = value.substring(0, schemeIndex).toLowerCase();
      rest = value.substring(schemeIndex + 3);
      if (rawScheme === 'https' || rawScheme === 'wss') {
        scheme = 'wss://';
      } else if (rawScheme === 'http' || rawScheme === 'ws') {
        scheme = 'ws://';
      } else {
        return '';
      }
    }
    if (rest.length === 0) {
      return '';
    }

    const slashIndex = rest.indexOf('/');
    let authority = rest;
    let pathValue = '';
    if (slashIndex >= 0) {
      authority = rest.substring(0, slashIndex);
      pathValue = rest.substring(slashIndex);
    }
    if (authority.length === 0) {
      return '';
    }
    if (pathValue.length === 0 || pathValue === '/') {
      pathValue = '/dsh';
    }
    if (!pathValue.startsWith('/')) {
      pathValue = `/${pathValue}`;
    }
    if (pathValue.endsWith('/')) {
      pathValue = pathValue.substring(0, pathValue.length - 1);
    }
    return `${scheme}${authority}${pathValue}`;
  }

  static timeAgo(milliseconds: number): string {
    if (milliseconds <= 0) {
      return '';
    }
    const diff = Date.now() - milliseconds;
    if (diff < 60000) {
      return '刚刚';
    }
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)} 分钟前`;
    }
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)} 小时前`;
    }
    if (diff < 172800000) {
      return '昨天';
    }
    const date = new Date(milliseconds);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  static clockTime(milliseconds: number): string {
    if (milliseconds <= 0) {
      return '';
    }
    const date = new Date(milliseconds);
    const minutes = date.getMinutes();
    return `${date.getHours()}:${minutes < 10 ? '0' : ''}${minutes}`;
  }

  static shortCwd(cwd: string): string {
    if (cwd.length === 0) {
      return '未指定工作区';
    }
    const normalized = cwd.split('\\').join('/');
    const parts = normalized.split('/').filter((part: string): boolean => part.length > 0);
    if (parts.length <= 2) {
      return normalized;
    }
    return `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  static projectName(cwd: string): string {
    if (cwd.length === 0) {
      return '未指定工作区';
    }
    const parts = cwd.split('\\').join('/').split('/').filter((part: string): boolean => part.length > 0);
    if (parts.length === 0) {
      return cwd;
    }
    return parts[parts.length - 1];
  }

  static truncate(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }
    return `${text.substring(0, limit)}…`;
  }

  static modelName(options: DshConfigOption[]): string {
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      if (option.id !== 'model') {
        continue;
      }
      for (let choiceIndex = 0; choiceIndex < option.choices.length; choiceIndex++) {
        const choice = option.choices[choiceIndex];
        if (choice.value === option.currentValue) {
          return choice.name;
        }
      }
    }
    return '默认模型';
  }

  static reasoningName(options: DshConfigOption[]): string {
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      if (option.id !== 'reasoning_effort') {
        continue;
      }
      for (let choiceIndex = 0; choiceIndex < option.choices.length; choiceIndex++) {
        const choice = option.choices[choiceIndex];
        if (choice.value === option.currentValue) {
          return choice.name;
        }
      }
    }
    return '';
  }

  static parseSegments(source: string): DshTextSegment[] {
    const segments: DshTextSegment[] = [];
    let index = 0;
    let buffer = '';
    while (index < source.length) {
      const start = source.indexOf('```', index);
      if (start < 0) {
        buffer += source.substring(index);
        break;
      }
      buffer += source.substring(index, start);
      if (buffer.length > 0) {
        const textSegment: DshTextSegment = {
          key: `text-${segments.length}-${buffer.length}`,
          kind: 'text',
          content: buffer,
          lang: ''
        };
        segments.push(textSegment);
        buffer = '';
      }
      const end = source.indexOf('```', start + 3);
      if (end < 0) {
        buffer += source.substring(start);
        break;
      }
      let body = source.substring(start + 3, end);
      let language = 'code';
      const newline = body.indexOf('\n');
      if (newline >= 0) {
        const candidate = body.substring(0, newline).trim();
        if (candidate.length > 0) {
          language = candidate;
        }
        body = body.substring(newline + 1);
      }
      const codeSegment: DshTextSegment = {
        key: `code-${segments.length}-${body.length}`,
        kind: 'code',
        content: body,
        lang: language
      };
      segments.push(codeSegment);
      index = end + 3;
    }
    if (buffer.length > 0) {
      const tailSegment: DshTextSegment = {
        key: `text-${segments.length}-${buffer.length}`,
        kind: 'text',
        content: buffer,
        lang: ''
      };
      segments.push(tailSegment);
    }
    return segments;
  }

  static choiceIsSelected(choice: DshConfigChoice, option: DshConfigOption): boolean {
    return choice.value === option.currentValue;
  }
}
