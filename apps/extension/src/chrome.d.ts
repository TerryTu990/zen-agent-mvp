/** 本插件实际触达的 chrome.* 最小面（MV3 Promise 形态）；不引 @types/chrome 全量类型。 */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace runtime {
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(callback: (message: unknown) => void): void };
      onDisconnect: { addListener(callback: () => void): void };
    }
    function connect(connectInfo?: { name?: string }): Port;
    const onConnect: { addListener(callback: (port: Port) => void): void };
  }
}
