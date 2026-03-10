// --- ASKÖ Piberbach – Ranglisten-Pyramide ---
// Ermöglicht das Tauschen der Feldinhalte durch Drag & Drop.

document.addEventListener("DOMContentLoaded", () => {
  const boxes = document.querySelectorAll(".box");
  let dragged = null;

  boxes.forEach((box) => {
    box.addEventListener("dragstart", (e) => {
      dragged = box;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", box.innerHTML); // Pflicht für Firefox
      box.classList.add("dragging");
    });

    box.addEventListener("dragend", () => {
      box.classList.remove("dragging");
      dragged = null;
    });

    box.addEventListener("dragover", (e) => {
      // erlaubt Drops auf anderen Boxen
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    box.addEventListener("dragenter", (e) => {
      e.preventDefault();
      box.classList.add("drop-target");
    });

    box.addEventListener("dragleave", () => {
      box.classList.remove("drop-target");
    });

    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("drop-target");
      if (dragged && dragged !== box) {
        const temp = box.innerHTML;
        box.innerHTML = dragged.innerHTML;
        dragged.innerHTML = temp;
      }
    });
  });
});


