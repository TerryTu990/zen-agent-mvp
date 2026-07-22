/** 本插件实际触达的 chrome.* 最小面（MV3 Promise 形态）；不引 @types/chrome 全量类型。 */
declare namespace chrome {
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    /** 跨 SW 重启存活、随浏览器关闭清除；会话存根的正确层（adr-012）。 */
    const session: StorageArea;
    const onChanged: {
      addListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      windowId?: number;
      groupId?: number;
    }
    /** 新开标签页；ADR-013 批次④ navigate 客户端据此在本组窗口开目标页。 */
    function create(createProperties: { url: string; windowId?: number; active?: boolean }): Promise<Tab>;
    /** 把 tab 并入标签组；省略 groupId 时新建组并返回其 id。 */
    function group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
    /** 向指定标签页的内容脚本单发一次性消息（激活握手用）。 */
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<Tab[]>;
    interface TabChangeInfo {
      status?: string;
      url?: string;
      /** 标签页组成员变化（拖入/移出组）即以此字段上报；-1=离组。 */
      groupId?: number;
    }
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
  }

  namespace sidePanel {
    /** 只能在用户手势（如 action 点击）内调用。 */
    function open(options: { tabId?: number; windowId?: number }): Promise<void>;
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
    const onRemoved: { addListener(callback: (group: { id: number }) => void): void };
  }

  namespace action {
    /** 无 default_popup 时点击工具栏图标触发；tab 为当前活动页。 */
    const onClicked: { addListener(callback: (tab: tabs.Tab) => void): void };
  }

  namespace runtime {
    interface MessageSender {
      /** groupId：-1=未分组（TAB_GROUP_ID_NONE）。 */
      tab?: { id?: number; url?: string; windowId?: number; groupId?: number };
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
    /** 一次性消息（激活握手）：content→background；background 侧经 onMessage 收 sender.tab。 */
    function sendMessage(message: unknown): Promise<unknown>;
    const onConnect: { addListener(callback: (port: Port) => void): void };
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ): void;
    };
    const onStartup: { addListener(callback: () => void): void };
    const onInstalled: { addListener(callback: () => void): void };
  }

  namespace alarms {
    interface Alarm { name: string }
    function create(name: string, alarmInfo: { periodInMinutes: number }): void;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(callback: (alarm: Alarm) => void): void };
  }
}
