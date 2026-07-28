(function () {
  const footerContainer = document.getElementById("footer-container");
  if (!footerContainer) return;

  const footer = document.createElement("footer");
  footer.className = "footer";

  const clock = document.createElement("div");
  clock.id = "clock";
  clock.className = "footer-clock";

  const version = document.createElement("span");
  version.id = "footer-version";
  version.textContent = `v${window.APP_VERSION}`;

  footer.append(clock, " |\u2003© ASKÖ Piberbach – Tennis\u2003|\u2003", version);
  footerContainer.replaceChildren(footer);

  const el = clock;

  function update() {
    el.textContent = window.getCurrentDateTimeString();
  }

  update();
  //setInterval(update, 60000);
  
})();
