const DEFAULT_SETTINGS = {
  enabled: true,
  idleMinutes: 5,
  skipPinned: true,
  skipAudible: true
};

const elements = {
  form: document.getElementById("settings-form"),
  enabled: document.getElementById("enabled"),
  idleMinutes: document.getElementById("idle-minutes"),
  skipPinned: document.getElementById("skip-pinned"),
  skipAudible: document.getElementById("skip-audible"),
  status: document.getElementById("save-status")
};

let statusTimer = null;

/** 把设置填充到表单控件 */
function fillForm(settings) {
  elements.enabled.checked = settings.enabled;
  elements.idleMinutes.value = settings.idleMinutes;
  elements.skipPinned.checked = settings.skipPinned;
  elements.skipAudible.checked = settings.skipAudible;
}

/** 校验并读取表单值，非法分钟数返回 null */
function readForm() {
  const idleMinutes = Number(elements.idleMinutes.value);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 240) return null;
  return {
    enabled: elements.enabled.checked,
    idleMinutes,
    skipPinned: elements.skipPinned.checked,
    skipAudible: elements.skipAudible.checked
  };
}

/** 展示保存结果提示 */
function showStatus(text, isError = false) {
  clearTimeout(statusTimer);
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
  elements.status.classList.add("visible");
  statusTimer = setTimeout(() => elements.status.classList.remove("visible"), 2000);
}

/** 保存设置到同步存储 */
async function saveSettings(event) {
  event.preventDefault();
  const settings = readForm();
  if (!settings) {
    showStatus("请输入 1–240 之间的整数分钟数", true);
    elements.idleMinutes.focus();
    return;
  }
  await chrome.storage.sync.set({ settings });
  showStatus("已保存");
}

/** 加载已有设置，缺失字段使用默认值 */
async function init() {
  const stored = await chrome.storage.sync.get("settings");
  fillForm({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
  elements.form.addEventListener("submit", (event) => {
    saveSettings(event).catch(() => showStatus("保存失败，请重试", true));
  });
}

init().catch(() => showStatus("读取设置失败，请刷新页面", true));
