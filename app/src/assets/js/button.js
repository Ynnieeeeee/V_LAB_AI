const sidebarBtn = document.getElementById("sidebarBtn");
const menuSidebar = document.getElementById("menuSidebar");
const closeSearchModal = document.getElementById("closeSearchModal");
const searchModal = document.getElementById("searchModal");
const searchBtn = document.getElementById("searchBtn");
const fpsBtn = document.getElementById("fpsBtn");

sidebarBtn.addEventListener("click", () => {
    menuSidebar.classList.toggle("-translate-x-full");
    menuSidebar.classList.toggle("translate-x-0");
});

searchBtn.addEventListener("click", () => {
    searchModal.classList.toggle("hidden");
});

closeSearchModal.addEventListener("click", () => {
    searchModal.classList.toggle("hidden");
});

fpsBtn.addEventListener("mousedown", () => fpsBtn.classList.add("scale-95"));
fpsBtn.addEventListener("mouseup", () => fpsBtn.classList.remove("scale-95"));




