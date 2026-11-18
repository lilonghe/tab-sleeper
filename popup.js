const elements = {
  enabled: document.getElementById("enabled"),
  sleeping: document.getElementById("sleeping"),
  awake: document.getElementById("awake"),
  rule: document.getElementById("rule"),
  summary: document.getElementById("summary"),
  hint: document.getElementById("hint"),
  scan: document.getElementById("scan"),
  optionsLink: document.getElementById("options-link"),
  version: document.getElementById("version")
};

/** 读取后台状态并刷新弹窗界面 */
async function render() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  if (!status || status.error) {
    elements.summary.textContent = "读取失败，请重新打开弹窗";
    return;
  }

  const { settings, total, sleeping, awake } = status;
  elements.enabled.checked = settings.enabled;
  elements.sleeping.textContent = sleeping;
  elements.awake.textContent = awake;
  elements.rule.textContent = `${settings.idleMinutes} 分钟`;
  elements.summary.textContent = total ? `共 ${total} 个标签，已休眠 ${sleeping} 个` : "当前没有打开的标签";
  elements.scan.disabled = !settings.enabled;
  elements.hint.textContent = settings.enabled
    ? `非激活标签闲置 ${settings.idleMinutes} 分钟后自动休眠。`
    : "自动休眠已暂停。";
}

/** 切换自动休眠开关，并写回设置 */
async function toggleEnabled() {
  const { settings = {} } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({ settings: { ...settings, enabled: elements.enabled.checked } });
  await render();
}

/** 立即触发一次扫描，并短暂展示结果 */
async function scanNow() {
  elements.scan.disabled = true;
  elements.scan.textContent = "正在检查…";

  const result = await chrome.runtime.sendMessage({ type: "scan" });
  elements.scan.textContent = "立即检查并休眠";
  await render();

  if (result?.slept > 0) {
    elements.hint.textContent = `已休眠 ${result.slept} 个闲置标签。`;
  } else {
    elements.hint.textContent = "暂无达到休眠条件的标签。";
  }
}

/** 初始化弹窗：绑定交互、展示版本号 */
function init() {
  elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  elements.enabled.addEventListener("change", () => {
    toggleEnabled().catch(() => {
      elements.hint.textContent = "保存设置失败，请重试。";
    });
  });
  elements.scan.addEventListener("click", () => {
    scanNow().catch(() => {
      elements.scan.disabled = false;
      elements.scan.textContent = "立即检查并休眠";
      elements.hint.textContent = "操作失败，请重试。";
    });
  });
  elements.optionsLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  render().catch(() => {
    elements.summary.textContent = "读取失败，请重新打开弹窗";
  });
}

init();
