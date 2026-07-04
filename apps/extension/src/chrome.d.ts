/** 本插件实际触达的 chrome.* 最小面（MV3 Promise 形态）；不引 @types/chrome 全量类型。 */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    /** 跨 SW 重启存活、随浏览器关闭清除；会话存根的正确层（adr-012）。 */
    const session: StorageArea;
  }

  namespace tabs {
    /** 把 tab 并入标签组；省略 groupId 时新建组并返回其 id。 */
    function group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
  }

  namespace tabGroups {
    interface TabGroup {
      id: number;
      title?: string;
      windowId: number;
    }
    function query(queryInfo: { title?: string; windowId?: number }): Promise<TabGroup[]>;
    function update(
      groupId: number,
      updateProperties: { title?: string; color?: string; collapsed?: boolean },
    ): Promise<TabGroup>;
  }

  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; url?: string; windowId?: number };
      url?: string;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(callback: (message: unknown) => void): void };
      onDisconnect: { addListener(callback: () => void): void };
    }
    function connect(connectInfo?: { name?: string }): Port;
    const onConnect: { addListener(callback: (port: Port) => void): void };
  }
}
