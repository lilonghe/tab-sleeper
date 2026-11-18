const ALARM_NAME = "tab-sleeper:scan";
const LAST_ACTIVE_KEY = "lastActiveAt";
const ACTIVE_TAB_KEY = "activeTabByWindow";
const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  idleMinutes: 5,
  skipPinned: true,
  skipAudible: true
});

const SLEEPABLE_PROTOCOLS = ["http:", "https:", "file:"];

let lastActiveCache = null;
let activeTabCache = null;

/** 读取设置；存储中缺失的字段用默认值补齐，避免旧版本数据导致规则失效 */
async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

/** 读取标签最后活跃时间（tabId -> 毫秒时间戳），service worker 重启后从 session 存储恢复 */
async function getLastActiveMap() {
  if (lastActiveCache) return lastActiveCache;
  const stored = await chrome.storage.session.get(LAST_ACTIVE_KEY);
  lastActiveCache = stored[LAST_ACTIVE_KEY] || {};
  return lastActiveCache;
}

/** 把活跃时间缓存写回 session 存储 */
async function saveLastActiveMap() {
  await chrome.storage.session.set({ [LAST_ACTIVE_KEY]: lastActiveCache });
}

/** 读取每个窗口当前激活的标签，用于在切换时记录上一个标签的离开时间 */
async function getActiveTabMap() {
  if (activeTabCache) return activeTabCache;
  const stored = await chrome.storage.session.get(ACTIVE_TAB_KEY);
  activeTabCache = stored[ACTIVE_TAB_KEY] || {};
  return activeTabCache;
}

/** 把窗口激活标签缓存写回 session 存储 */
async function saveActiveTabMap() {
  await chrome.storage.session.set({ [ACTIVE_TAB_KEY]: activeTabCache });
}

/** 记录某个标签刚刚活跃过 */
async function touchTab(tabId) {
  if (typeof tabId !== "number") return;
  const map = await getLastActiveMap();
  map[String(tabId)] = Date.now();
  await saveLastActiveMap();
}

/** 切换标签时，把上一个标签的离开时间和新标签的激活时间都记为当前时间 */
async function handleTabActivated({ tabId, windowId }) {
  if (typeof tabId !== "number" || typeof windowId !== "number") return;

  const now = Date.now();
  const lastActive = await getLastActiveMap();
  const activeTabs = await getActiveTabMap();
  const previousTabId = activeTabs[String(windowId)];

  if (typeof previousTabId === "number" && previousTabId !== tabId) {
    lastActive[String(previousTabId)] = now;
  }
  activeTabs[String(windowId)] = tabId;
  lastActive[String(tabId)] = now;
  await Promise.all([saveLastActiveMap(), saveActiveTabMap()]);
}

/** 用当前时间重置所有标签的活跃时间，避免暂停后恢复时集中休眠 */
async function resetAllTabs() {
  const now = Date.now();
  lastActiveCache = {};
  activeTabCache = {};

  const windows = await chrome.windows.getAll({ populate: true });
  for (const window of windows) {
    for (const tab of window.tabs || []) {
      if (typeof tab.id !== "number") continue;
      lastActiveCache[String(tab.id)] = now;
      if (tab.active) activeTabCache[String(window.id)] = tab.id;
    }
  }
  await Promise.all([saveLastActiveMap(), saveActiveTabMap()]);
}

/** 判断标签是否允许休眠：跳过当前激活、固定、发声以及浏览器内部页面 */
function isSleepable(tab, settings) {
  if (typeof tab.id !== "number" || tab.discarded || tab.active) return false;
  if (tab.autoDiscardable === false) return false;
  if (settings.skipPinned && tab.pinned) return false;
  if (settings.skipAudible && tab.audible) return false;

  const url = tab.url || tab.pendingUrl || "";
  if (!url) return false;
  try {
    return SLEEPABLE_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** 扫描所有窗口，休眠超过设定时长未激活的标签 */
async function sleepIdleTabs() {
  const settings = await getSettings();
  if (!settings.enabled) {
    const tabs = await chrome.tabs.query({});
    return { checked: 0, slept: 0, sleeping: countSleeping(tabs) };
  }

  const idleMinutes = Number.isFinite(settings.idleMinutes) && settings.idleMinutes > 0
    ? settings.idleMinutes
    : DEFAULT_SETTINGS.idleMinutes;
  const timeoutMs = idleMinutes * 60 * 1000;
  const now = Date.now();

  const lastActive = await getLastActiveMap();
  const windows = await chrome.windows.getAll({ populate: true });
  const nextLastActive = {};
  const nextActiveTabs = {};
  let checked = 0;
  let slept = 0;
  let sleeping = 0;

  for (const window of windows) {
    for (const tab of window.tabs || []) {
      if (typeof tab.id !== "number") continue;

      const key = String(tab.id);
      if (typeof lastActive[key] !== "number") lastActive[key] = now;
      nextLastActive[key] = lastActive[key];
      if (tab.active) nextActiveTabs[String(window.id)] = tab.id;
      if (tab.discarded) sleeping++;

      if (!isSleepable(tab, settings)) continue;
      checked++;
      if (now - lastActive[key] < timeoutMs) continue;

      try {
        await chrome.tabs.discard(tab.id);
        slept++;
      } catch (error) {
        console.warn(`休眠标签 ${tab.id} 失败`, error);
      }
    }
  }

  lastActiveCache = nextLastActive;
  activeTabCache = nextActiveTabs;
  await Promise.all([saveLastActiveMap(), saveActiveTabMap()]);
  return { checked, slept, sleeping };
}

/** 统计已休眠标签数量 */
function countSleeping(tabs) {
  return tabs.filter((tab) => tab.discarded).length;
}

/** 汇总弹窗需要的状态数据 */
async function getStatus() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const sleeping = countSleeping(tabs);
  return {
    settings,
    total: tabs.length,
    sleeping,
    awake: tabs.length - sleeping
  };
}

/** 保证扫描定时器存在且只创建一次 */
async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 1 });
  }
}

/** 首次安装：写入默认设置并初始化标签时间戳 */
async function initialize() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  await resetAllTabs();
  await ensureAlarm();
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => console.error("初始化失败", error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => console.error("启动初始化失败", error));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  handleTabActivated({ tabId, windowId }).catch((error) => console.error("记录标签切换时间失败", error));
});

chrome.tabs.onCreated.addListener((tab) => {
  touchTab(tab.id).catch((error) => console.error("记录新标签活跃时间失败", error));
});

chrome.tabs.onReplaced.addListener((addedTabId) => {
  touchTab(addedTabId).catch((error) => console.error("记录替换标签活跃时间失败", error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getLastActiveMap()
    .then((map) => {
      delete map[String(tabId)];
      return saveLastActiveMap();
    })
    .catch((error) => console.error("清理标签活跃时间失败", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    sleepIdleTabs().catch((error) => console.error("自动休眠失败", error));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  const before = changes[SETTINGS_KEY].oldValue || {};
  const after = changes[SETTINGS_KEY].newValue || {};
  if (before.enabled === false && after.enabled === true) {
    resetAllTabs().catch((error) => console.error("恢复休眠失败", error));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "scan") {
    sleepIdleTabs().then(sendResponse, (error) => {
      console.error("立即休眠失败", error);
      sendResponse({ checked: 0, slept: 0, error: String(error) });
    });
    return true;
  }
  if (message?.type === "status") {
    getStatus().then(sendResponse, (error) => {
      console.error("读取状态失败", error);
      sendResponse({ error: String(error) });
    });
    return true;
  }
  return false;
});
