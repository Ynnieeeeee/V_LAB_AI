export function initChatEvents() {
    const input = document.getElementById('chat-input');
    const statusText = document.getElementById('status-text');
    const btn = document.getElementById('send-btn');

    const handleSend = async () => {
        const text = input.value.trim();

        if(!text) return;

        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        statusText.innerText = "AI đang phân tích và chuẩn bị dụng cụ...";
        statusText.classList.add('text-pulse');

        try {
            const response = await fetch('/api/lab/generate', {
                method: 'POST',
                headers: {
                    'Content-type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem("access_token")}`
                },
                body: JSON.stringify({
                    text: text,
                    id_conv: window.currentConvId,
                    subject: window.currentSubject || 'chemistry'
                })
            });

            if (response.ok){
                const result = await response.json();
                const waitingForModels = (result.data || []).some(item => !item.ready);
                window.registerPendingModelTools?.(result.data || []);
                
                // Nếu đây là chat mới, cập nhật ID và URL
                if ((!window.currentConvId || window.currentConvId === "null" || window.currentConvId === "undefined") && result.conversation_id) {
                    window.currentConvId = result.conversation_id;
                    localStorage.setItem('lab_conv_id', result.conversation_id);
                    window.history.pushState({}, "", `/chat/${result.conversation_id}`);
                    window.claimCurrentMovableTablesForRoom?.(result.conversation_id);
                    
                    // Cập nhật lại danh sách hội thoại ở sidebar (nếu hàm tồn tại)
                    if (typeof window.loadConversations === 'function') {
                        window.loadConversations();
                    }
                }

                input.value = '';
                statusText.innerText = waitingForModels
                    ? "Đang tạo mô hình 3D cho dụng cụ..."
                    : "Đang đưa dụng cụ lên bàn...";
                window.checkBackendStatus?.();
            } else {
                statusText.innerText = "Lỗi: Server báo lỗi " + response.status;
            }
        } catch (err){
            statusText.innerText = "Lỗi: Mất kết nối server";
        } finally {
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    };

    btn.onclick = handleSend;
    btn.onkeypress = (e) => {if(e.key === 'Enter') handleSend(); };

    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            handleSend();
        }
    });
    input.addEventListener('keyup', (event) => event.stopPropagation());
    input.addEventListener('keypress', (event) => event.stopPropagation());
};
