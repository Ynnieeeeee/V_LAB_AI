/**
 * Quản lý logic chọn môn học và hiển thị Overlay
 */

// Đảm bảo các biến toàn cục được khởi tạo
window.currentSubject = null;
window.currentConvId = null;

const SUBJECT_AUTH_TOKEN_KEY = "access_token";
let subjectLoginDialogState = null;

function getSubjectAuthToken() {
    const storedToken = localStorage.getItem(SUBJECT_AUTH_TOKEN_KEY);
    if (storedToken) return storedToken;

    const params = new URLSearchParams(window.location.search);
    return params.get("token");
}

function clearSubjectAuthState() {
    localStorage.removeItem(SUBJECT_AUTH_TOKEN_KEY);
    localStorage.removeItem("user");
}

function redirectToLogin() {
    window.location.href = "/login";
}

function ensureSubjectLoginDialog() {
    let dialog = document.getElementById("subject-login-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("div");
    dialog.id = "subject-login-dialog";
    dialog.className = "subject-login-dialog hidden";
    dialog.setAttribute("aria-hidden", "true");
    dialog.innerHTML = `
        <div class="subject-login-backdrop" data-subject-login-cancel></div>
        <div class="subject-login-card" role="dialog" aria-modal="true" aria-labelledby="subject-login-title" tabindex="-1">
            <div class="subject-login-header">
                <h2 id="subject-login-title">Đăng nhập để tiếp tục</h2>
            </div>
            <div class="subject-login-divider"></div>
            <p class="subject-login-message">
                Bạn cần đăng nhập để chọn môn học và bắt đầu phòng thí nghiệm.
            </p>
            <div class="subject-login-actions">
                <button type="button" class="subject-login-primary" data-subject-login-confirm>
                    Đăng nhập
                </button>
                <button type="button" class="subject-login-secondary" data-subject-login-cancel>
                    Hủy
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    const closeDialog = (shouldLogin) => {
        if (!subjectLoginDialogState) return;

        const { resolve } = subjectLoginDialogState;
        subjectLoginDialogState = null;

        dialog.classList.remove("is-open");
        dialog.setAttribute("aria-hidden", "true");

        setTimeout(() => {
            dialog.classList.add("hidden");
        }, 180);

        resolve(shouldLogin);
    };

    dialog.querySelector("[data-subject-login-confirm]").addEventListener("click", () => {
        closeDialog(true);
    });

    dialog.querySelectorAll("[data-subject-login-cancel]").forEach((element) => {
        element.addEventListener("click", () => {
            closeDialog(false);
        });
    });

    dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeDialog(false);
        }
    });

    return dialog;
}

function confirmLoginBeforeSelectingSubject() {
    if (subjectLoginDialogState) {
        return subjectLoginDialogState.promise;
    }

    const dialog = ensureSubjectLoginDialog();
    const card = dialog.querySelector(".subject-login-card");

    dialog.classList.remove("hidden");
    dialog.setAttribute("aria-hidden", "false");

    subjectLoginDialogState = {};
    subjectLoginDialogState.promise = new Promise((resolve) => {
        subjectLoginDialogState.resolve = resolve;
    });

    requestAnimationFrame(() => {
        dialog.classList.add("is-open");
        card?.focus();
    });

    return subjectLoginDialogState.promise;
}

async function canSelectSubject() {
    const token = getSubjectAuthToken();
    if (!token) {
        clearSubjectAuthState();
        return false;
    }

    try {
        const response = await fetch("/auth/me", {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (response.ok) return true;

        if (response.status === 401 || response.status === 404) {
            clearSubjectAuthState();
        }

        return false;
    } catch (error) {
        console.error("Unable to verify login before selecting subject", error);
        return false;
    }
}

async function requireLoginBeforeSelectingSubject() {
    if (await canSelectSubject()) return true;

    if (await confirmLoginBeforeSelectingSubject()) {
        redirectToLogin();
    }

    return false;
}

/**
 * Hàm xử lý khi người dùng chọn một môn học từ Overlay
 * @param {string} type - 'chemistry', 'physics', hoặc 'biology'
 * @param {string} name - Tên hiển thị tiếng Việt
 */
window.selectSubject = async function(type, name) {
    if (!(await requireLoginBeforeSelectingSubject())) {
        return;
    }

    console.log(`Đã chọn phòng thí nghiệm: ${name}`);
    
    // 1. Thiết lập trạng thái ban đầu
    window.currentSubject = type;
    window.currentDraftRoomKey = `${type}:${Date.now()}`;
    window.currentConvId = null; 
    localStorage.removeItem('lab_conv_id'); // Xóa ID cũ để tránh bị gộp nhầm hội thoại
    // 2. Hiệu ứng đóng Overlay mượt mà
    const overlay = document.getElementById('subject-overlay');
    if (overlay) {
        overlay.style.transition = "opacity 0.3s ease";
        overlay.classList.add('opacity-0');
        overlay.style.pointerEvents = 'none';
        
        // Đợi hiệu ứng transition kết thúc rồi mới ẩn hẳn
        setTimeout(() => {
            overlay.classList.add('hidden');
        }, 300);
    }

    // 3. Cập nhật giao diện (Status bar & Clear bàn thí nghiệm)
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.innerText = `PHÒNG THÍ NGHIỆM: ${name.toUpperCase()}`;
        statusText.classList.remove('text-pulse'); // Nếu có hiệu ứng nháy
    }

    // Luôn dọn sạch bàn 3D khi chọn môn học mới để bắt đầu
    if (window.clearLab) {
        window.clearLab();
    }

    // 3.5. Hiển thị/Ẩn tủ hóa chất tùy theo môn học
    if (type === 'chemistry') {
        if (typeof window.loadChemistryCabinet === 'function') {
            window.loadChemistryCabinet();
        }
    } else {
        if (typeof window.hideChemistryCabinet === 'function') {
            window.hideChemistryCabinet();
        }
    }

    // 4. Gửi lời chào từ hệ thống
    // Lưu ý: Hàm addMessage phải được định nghĩa trong chat_logic.js
    if (typeof addMessage === "function") {
        addMessage(`Chào mừng bạn đến với phòng thí nghiệm **${name}**. Hãy nhập dụng cụ hoặc thí nghiệm bạn muốn chuẩn bị.`, "assistant");
    }
};

/**
 * Hàm mở lại Overlay (Dùng cho nút "Tạo đoạn chat mới")
 */
window.showSubjectOverlay = async function() {
    if (!(await requireLoginBeforeSelectingSubject())) {
        return;
    }

    const overlay = document.getElementById('subject-overlay');
    if (overlay) {
        overlay.classList.remove('hidden', 'opacity-0');
        overlay.style.pointerEvents = 'auto';
        overlay.style.opacity = '1';
    }
};

// Gán sự kiện cho nút "Tạo đoạn chat mới" nếu nó tồn tại trong DOM
document.addEventListener("DOMContentLoaded", () => {
    const newChatBtn = document.getElementById("new-chat-btn");
    if (newChatBtn) {
        newChatBtn.addEventListener("click", () => {
            // Reset URL về mặc định
            window.history.pushState({}, "", "/chat");
            window.showSubjectOverlay();
        });
    }
});
