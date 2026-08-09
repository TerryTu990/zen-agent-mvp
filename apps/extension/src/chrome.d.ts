/** 本插件实际触达的 chrome.* 最小面（MV3 Promise 形态）；不引 @types/chrome 全量类型。 */
declare namespace chrome {
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
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
      active?: boolean;
      /** 'loading' | 'complete' 等；URL 未 commit 的加载页据此暂缓 assistable 判定。 */
      status?: string;
      /** 导航已发起但 URL 尚未 commit 时的目标地址。 */
      pendingUrl?: string;
    }
    /** 新开标签页；ADR-013 批次④ navigate 客户端据此在本组窗口开目标页。 */
    function create(createProperties: { url: string; windowId?: number; active?: boolean }): Promise<Tab>;
    /** 把 tab 并入标签组；省略 groupId 时新建组并返回其 id。 */
    function group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
    /** 向指定标签页的内容脚本单发一次性消息（激活握手用）。 */
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      windowId?: number;
      /** 按标签组过滤（navigate 复用决策查组内成员）。 */
      groupId?: number;
    }): Promise<Tab[]>;
    /** 更新标签页：换 URL（同源复用导航）/ 置为活动页。 */
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    /** 按 id 取标签页当前状态（含 groupId）：事件只给 tabId 时据此判定面板可见性。 */
    function get(tabId: number): Promise<Tab>;
    /**
     * 当前脚本所在的标签页。**Side Panel 中运行时返回 undefined**（面板不是标签页），
     * 被当普通标签页打开时返回该标签页——面板据此区分运行形态（实测：标签页形态返回 {id, groupId:-1}）。
     */
    function getCurrent(): Promise<Tab | undefined>;
    interface TabChangeInfo {
      status?: string;
      url?: string;
      title?: string;
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
    /**
     * 按标签页开关面板：`enabled:false` 使该标签页不显示面板（面板正开着且该页被激活时即收起）。
     * manifest 的 `side_panel.default_path` 让面板默认对全部标签页可用，故组外标签页须显式关掉。
     */
    function setOptions(options: {
      /** 省略 = 设置默认行为（对所有未单独设置的标签页生效）。 */
      tabId?: number;
      path?: string;
      enabled?: boolean;
    }): Promise<void>;
    /** 关闭面板（Chrome 141+）；已关闭时为 no-op。旧版本无此方法，调用点须自行兜底。 */
    function close(options: { tabId?: number; windowId?: number }): Promise<void>;
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
    function getAll(): Promise<Alarm[]>;
    const onAlarm: { addListener(callback: (alarm: Alarm) => void): void };
  }
}
