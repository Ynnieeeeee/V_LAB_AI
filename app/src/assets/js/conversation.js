let deleteConversationId = null;
let deleteElement = null;
let allConversations = []; // Lưu trữ để tìm kiếm

const getIcon = (s) => ({ chemistry: "🧪", physics: "⚡", biology: "🌿" }[s] || "⚙️");

async function loadConversations() {
    window.loadConversations = loadConversations; // Expose to window
    const token = localStorage.getItem("access_token");
    if (!token) return;

    try {
        const res = await fetch("/chat/conversation", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        allConversations = await res.json();
        renderConversations(allConversations);
    } catch (err) { console.error(err); }
}

function renderConversations(data, targetId = "conversation-list") {
    const list = document.getElementById(targetId);
    if (!list) return;

    const isSearch = targetId === "searchResults";
    const textColor = isSearch ? "text-slate-900" : "text-white";
    const hoverColor = isSearch ? "hover:bg-slate-100" : "hover:bg-white/10";

    list.innerHTML = data.map(conv => `
        <div class="group flex items-center justify-between p-3 rounded-xl cursor-pointer ${hoverColor} transition-all mb-1" 
             data-id="${conv.id}" 
             data-subject="${conv.subject}">
            <div class="flex items-center space-x-3 flex-1 min-w-0 nav-link">
                <span class="text-lg">${getIcon(conv.subject)}</span>
                <span class="text-sm font-medium ${textColor} truncate title">${conv.title}</span>
            </div>
            ${!isSearch ? `
            <div class="menu-btn relative px-2">
                <i class="fa-solid fa-ellipsis opacity-0 group-hover:opacity-100 text-gray-400 p-1"></i>
                <div class="menu hidden absolute right-0 top-full mt-1 bg-[#1e293b] border border-white/10 shadow-2xl z-[100] rounded-lg w-32 overflow-hidden">
                    <div class="rename px-4 py-2 hover:bg-blue-600 text-xs text-white flex items-center space-x-2">
                        <i class="fa-solid fa-pen"></i><span>Đổi tên</span>
                    </div>
                    <div class="delete px-4 py-2 hover:bg-red-600 text-xs text-white flex items-center space-x-2">
                        <i class="fa-regular fa-trash-can"></i><span>Xóa</span>
                    </div>
                </div>
            </div>` : ''}
        </div>
    `).join('');
}

document.addEventListener("click", async (e) => {
    if (e.target.tagName === "INPUT") return;
    const token = localStorage.getItem("access_token");
    const item = e.target.closest("[data-id]");
    if (!item) return;
    const id = item.dataset.id;

    // 1. Chuyển phòng Lab
    if (e.target.closest(".nav-link")) {
        const id = item.dataset.id;
        const subject = item.dataset.subject;
        window.currentConvId = id;
        window.currentSubject = subject;
        localStorage.setItem('mascot_conv_id', id); // Đồng bộ với mascotTalk.js
        window.history.pushState({}, "", `/chat/${id}`);
        
        // Tải lại lịch sử tin nhắn và dụng cụ
        if (window.loadMessages) {
            window.loadMessages(id);
        }
        
        // Kích hoạt ngay việc tải lại dụng cụ 3D
        if (window.checkBackendStatus) {
            window.checkBackendStatus();
        }

        // Ẩn bảng chọn môn học nếu đang hiện
        const subjectOverlay = document.getElementById('subject-overlay');
        if (subjectOverlay) subjectOverlay.classList.add('hidden');

        // Đóng sidebar trên mobile
        const menuSidebar = document.getElementById("menuSidebar");
        if (menuSidebar) {
            menuSidebar.classList.add("-translate-x-full");
            menuSidebar.classList.remove("translate-x-0");
        }
        return;
    }

    // 2. Đổi tên Inline
    if (e.target.closest(".rename")) {
        item.querySelector(".menu")?.classList.add("hidden"); // Ẩn menu
        const titleEl = item.querySelector(".title");
        const oldTitle = titleEl.innerText;
        const input = document.createElement("input");
        input.value = oldTitle;
        input.className = "bg-white text-black text-sm w-full outline-none px-2 py-1 rounded border-2 border-blue-500 select-text relative z-50";
        input.style.color = "black";
        input.style.backgroundColor = "white";
        input.autocomplete = "off";
        input.onclick = (ev) => ev.stopPropagation();
        input.onfocus = (ev) => ev.target.select();
        
        titleEl.replaceWith(input);
        setTimeout(() => input.focus(), 10); // Đảm bảo focus sau khi DOM cập nhật

        const save = async () => {
            if (input.dataset.saving) return;
            input.dataset.saving = "true";
            
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== oldTitle) {
                try {
                    await fetch(`/chat/conversation/${id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                        body: JSON.stringify({ title: newTitle })
                    });
                } catch (err) {
                    console.error("Lỗi đổi tên:", err);
                }
            }
            loadConversations();
        };

        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                input.removeEventListener("blur", save); // Tránh gọi save 2 lần
                save();
            }
            if (ev.key === "Escape") {
                input.removeEventListener("blur", save);
                loadConversations(); // Hủy bỏ
            }
        });
        return;
    }

    // 3. Xóa
    if (e.target.closest(".delete")) {
        item.querySelector(".menu")?.classList.add("hidden"); // Ẩn menu đi
        deleteConversationId = id;
        deleteElement = item;
        document.getElementById("deleteModal")?.classList.remove("hidden");
        return;
    }

    // 4. Mở Menu (Ellipsis icon)
    if (e.target.closest(".menu-btn")) {
        const menu = item.querySelector(".menu");
        // Nếu click vào nút ellipsis thì mới toggle, còn click vào menu items thì đã return ở trên
        document.querySelectorAll(".menu").forEach(m => m !== menu && m.classList.add("hidden"));
        menu.classList.toggle("hidden");
        return;
    }
});

// Logic xác nhận xóa
async function confirmDeleteConversation() {
    window.confirmDeleteConversation = confirmDeleteConversation;
    const token = localStorage.getItem("access_token");
    await fetch(`/chat/conversation/${deleteConversationId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
    });
    if (window.currentConvId === deleteConversationId) {
        window.currentConvId = null;
        localStorage.removeItem('mascot_conv_id');
        window.history.pushState({}, "", "/chat");
        window.clearLab();
        document.getElementById('subject-overlay')?.classList.remove('hidden');
    }
    loadConversations();
    document.getElementById("deleteModal")?.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
    loadConversations();

    // Sự kiện tạo đoạn chat mới
    const newChatBtn = document.getElementById("newChatBtn");
    if (newChatBtn) {
        newChatBtn.addEventListener("click", () => {
            window.currentConvId = null;
            localStorage.removeItem('mascot_conv_id');
            window.history.pushState({}, "", "/chat");
            if (window.clearLab) window.clearLab();
            
            //hiện lại bảng chọn môn học
            if (window.showSubjectOverlay) {
                window.showSubjectOverlay();
            } else {
                const subjectOverlay = document.getElementById('subject-overlay');
                if (subjectOverlay) {
                    subjectOverlay.classList.remove('hidden', 'opacity-0');
                    subjectOverlay.style.pointerEvents = 'auto';
                    subjectOverlay.style.opacity = '1';
                }
            }
            
            // Đóng sidebar (nếu đang mở trên mobile/tablet)
            const menuSidebar = document.getElementById("menuSidebar");
            if (menuSidebar) {
                menuSidebar.classList.add("-translate-x-full");
                menuSidebar.classList.remove("translate-x-0");
            }
        });
    }

    // Sự kiện tìm kiếm
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.toLowerCase().trim();
            const filtered = allConversations.filter(c => 
                c.title.toLowerCase().includes(query)
            );
            renderConversations(filtered, "searchResults");
        });
    }
});