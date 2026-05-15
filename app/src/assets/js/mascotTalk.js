// Biến lưu trữ ID hội thoại hiện tại - Ưu tiên lấy từ window.currentConvId để đồng bộ với Lab
let currentMascotInterval = null;

// Hàm lấy ID hội thoại hiện tại
function getCurrentConvId() {
    return window.currentConvId || localStorage.getItem('mascot_conv_id') || null;
}

// 1. Hàm hiển thị câu trả lời với hiệu ứng đánh máy
function mascotTalk(message) {
    if (!message) return; // Bảo vệ nếu message undefined/null

    // Gọi hàm phát âm thanh (TTS) đã được khai báo bên mascot.js
    if (typeof window.triggerMascotSpeech === 'function') {
        window.triggerMascotSpeech(message);
    }

    const dialog = document.getElementById('mascot-dialog');
    const textEl = document.getElementById('mascot-text');
    
    if (currentMascotInterval) clearInterval(currentMascotInterval);
    
    dialog.classList.remove('hidden');
    textEl.textContent = "";
    
    let i = 0;
    // Tăng tốc nếu tin nhắn dài
    const speed = message.length > 200 ? 5 : 20;

    currentMascotInterval = setInterval(() => {
        if (i < message.length) {
            textEl.textContent += message[i];
            i++;
            // Tự động cuộn xuống nếu nội dung vượt quá chiều cao
            dialog.scrollTop = dialog.scrollHeight;
        } else {
            clearInterval(currentMascotInterval);
            currentMascotInterval = null;
        }
    }, speed);
}

// 2. Hàm gửi tin nhắn lên Server
async function sendMascotMessage(question) {
    const mascotInput = document.getElementById('mascot-input');
    const mascotSendBtn = document.getElementById('mascot-send-btn');

    // Hiệu ứng chờ đợi
    mascotTalk("Đang suy nghĩ...");
    mascotInput.disabled = true;
    mascotSendBtn.disabled = true;

    try {
        const token = localStorage.getItem('access_token');
        if (!token) {
            mascotTalk("Bạn cần đăng nhập để trò chuyện với mình nhé!");
            return;
        }

        const response = await fetch("http://127.0.0.1:8000/message/send", { // Thay đổi URL nếu cần
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}` 
            },
            body: JSON.stringify({
                id_conv: getCurrentConvId(),
                question: question + " (Hãy trả lời bằng tiếng Việt)", // Ép AI trả lời tiếng Việt
                subject: window.currentSubject || "Chemistry" 
            })
        });

        if (!response.ok) throw new Error("Lỗi kết nối server");

        const data = await response.json();

        // Cập nhật ID hội thoại để duy trì ngữ cảnh (context)
        const newId = data.id_conversation;
        window.currentConvId = newId;
        localStorage.setItem('mascot_conv_id', newId);

        // Nếu đây là hội thoại mới, load lại sidebar
        if (typeof window.loadConversations === 'function') {
            window.loadConversations();
        }

        // Hiển thị câu trả lời từ AI
        mascotTalk(data.answer);

    } catch (error) {
        console.error(error);
        mascotTalk("Rất tiếc, mình gặp lỗi khi kết nối với hệ thống. Bạn thử lại nhé!");
    } finally {
        mascotInput.disabled = false;
        mascotSendBtn.disabled = false;
        mascotInput.focus();
    }
}

// 3. Xử lý sự kiện nhập liệu
const mascotInput = document.getElementById('mascot-input');
const mascotSendBtn = document.getElementById('mascot-send-btn');

function handleMascotChat() {
    const message = mascotInput.value.trim();
    if (message) {
        sendMascotMessage(message);
        mascotInput.value = ""; 
    }
}

// 4. Hàm tải lịch sử tin nhắn
async function loadMessages(id) {
    if (!id) return;
    window.currentConvId = id; // Cập nhật ID hội thoại hiện tại
    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/message/full_history/${id}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            
            // Hiển thị tin nhắn cuối cùng của Mascot nếu có
            if (data.mascot_instructions && data.mascot_instructions.length > 0) {
                const lastMsg = data.mascot_instructions[data.mascot_instructions.length - 1];
                mascotTalk(lastMsg.context);
            } else {
                mascotTalk("Chào mừng bạn trở lại! Bạn muốn tiếp tục thí nghiệm gì nào?");
            }
        }
    } catch (error) {
        console.error("Lỗi tải lịch sử:", error);
    }
}

window.loadMessages = loadMessages;

// Khởi tạo khi trang web load
document.addEventListener('DOMContentLoaded', () => {
    const pathParts = window.location.pathname.split('/');
    const idFromUrl = pathParts[pathParts.length - 1];
    
    // Nếu URL có dạng /chat/{uuid}
    if (idFromUrl && idFromUrl.length > 30) {
        window.currentConvId = idFromUrl;
        localStorage.setItem('mascot_conv_id', idFromUrl);
        loadMessages(idFromUrl);
        
        // Đợi lab_logic.js sẵn sàng rồi gọi checkBackendStatus
        setTimeout(() => {
            if (window.checkBackendStatus) window.checkBackendStatus();
        }, 1000);
    }
});

mascotSendBtn.addEventListener('click', handleMascotChat);
mascotInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleMascotChat();
});