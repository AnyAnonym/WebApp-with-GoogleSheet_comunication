import { signalMonitorFailed, signalMonitorReady } from "./monitorReady.js";

const image = document.getElementById("sponsoren-image");

if (image.complete) {
  if (image.naturalWidth > 0) signalMonitorReady();
  else signalMonitorFailed("SPONSOR_IMAGE_LOAD_FAILED");
} else {
  image.addEventListener("load", signalMonitorReady, { once: true });
  image.addEventListener("error", () => signalMonitorFailed("SPONSOR_IMAGE_LOAD_FAILED"), { once: true });
}
