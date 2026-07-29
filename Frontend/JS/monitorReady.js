const params = new URLSearchParams(window.location.search);
const monitorMode = params.get("monitor") === "1";
const commandId = params.get("_command") || "";
let signaled = false;

function post(status, errorCode = null) {
  if (!monitorMode || !commandId || window.parent === window || signaled) return;
  if (status === "ready" || status === "failed") signaled = true;
  window.parent.postMessage({
    type: "epiber-monitor-ready",
    commandId,
    status,
    ...(errorCode ? { errorCode } : {}),
  }, window.location.origin);
}

export function signalMonitorReady() {
  post("ready");
}

export function signalMonitorFailed(errorCode = "APP_INIT_FAILED") {
  post("failed", errorCode);
}

export function isMonitorMode() {
  return monitorMode;
}
