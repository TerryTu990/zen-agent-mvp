export interface SseParser {
  /** 喂入任意切片的流文本，返回本次凑齐的 data 载荷（注释行如心跳 ": ping" 被丢弃）。 */
  push(chunk: string): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const payloads: string[] = [];
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLines = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)));
        if (dataLines.length > 0) payloads.push(dataLines.join('\n'));
      }
      return payloads;
    },
  };
}
