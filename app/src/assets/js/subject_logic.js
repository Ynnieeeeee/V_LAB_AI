/**
 * Quản lý logic chọn môn học và hiển thị Overlay
 */

// Đảm bảo các biến toàn cục được khởi tạo
window.currentSubject = null;
window.currentConvId = null;

/**
 * Hàm xử lý khi người dùng chọn một môn học từ Overlay
 * @param {string} type - 'chemistry', 'physics', hoặc 'biology'
 * @param {string} name - Tên hiển thị tiếng Việt
 */
window.selectSubject = function(type, name) {
    console.log(`Đã chọn phòng thí nghiệm: ${name}`);
    
    // 1. Thiết lập trạng thái ban đầu
    window.currentSubject = type;
    window.currentConvId = null; 
    localStorage.removeItem('mascot_conv_id'); // Xóa ID cũ để tránh bị gộp nhầm hội thoại
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

    // 4. Gửi lời chào từ Assistant
    // Lưu ý: Hàm addMessage phải được định nghĩa trong chat_logic.js
    if (typeof addMessage === "function") {
        addMessage(`Chào mừng bạn đến với phòng thí nghiệm **${name}**. Tôi có thể giúp bạn tạo dụng cụ hay thực hiện thí nghiệm nào?`, "assistant");
    }
};

/**
 * Hàm mở lại Overlay (Dùng cho nút "Tạo đoạn chat mới")
 */
window.showSubjectOverlay = function() {
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