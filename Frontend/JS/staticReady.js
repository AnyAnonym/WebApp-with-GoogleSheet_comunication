import { signalMonitorReady } from "./monitorReady.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", signalMonitorReady, { once: true });
} else {
  signalMonitorReady();
}
