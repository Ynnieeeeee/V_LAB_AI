// Fixed text-only mascot chat panel.
// It updates the existing panel without playback, auto-hide, or repeated DOM node churn.

function getCurrentConvId() {
    return window.currentConvId || localStorage.getItem('mascot_conv_id') || null;
}

function ensurePanel() {
    if (typeof window.ensureMascotPanel === 'function') {
        return window.ensureMascotPanel();
    }

    const dialog = document.getElementById('mascot-dialog');
    const text = document.getElementById('mascot-text');
    const input = document.getElementById('mascot-input');
    const sendBtn = document.getElementById('mascot-send-btn');

    document.getElementById('mascot-container')?.classList.remove('hidden');
    dialog?.classList.remove('hidden');
    if (dialog) {
        dialog.style.display = 'block';
        dialog.style.opacity = '1';
        dialog.style.visibility = 'visible';
    }

    return { dialog, text, input, sendBtn, history: document.getElementById('mascot-history') };
}

function mascotTalk(message) {
    const text = String(message || '').trim();
    if (!text) return;

    if (typeof window.triggerMascotSpeech === 'function') {
        window.triggerMascotSpeech(text);
        return;
    }

    const panel = ensurePanel();
    if (panel.text) panel.text.textContent = text;
    if (panel.dialog) panel.dialog.scrollTop = panel.dialog.scrollHeight;
}

window.mascotTalk = mascotTalk;

async function sendMascotMessage(question) {
    const mascotInput = document.getElementById('mascot-input');
    const mascotSendBtn = document.getElementById('mascot-send-btn');

    mascotTalk('Đang suy nghĩ...');
    if (mascotInput) mascotInput.disabled = true;
    if (mascotSendBtn) mascotSendBtn.disabled = true;

    try {
        const token = localStorage.getItem('access_token');
        if (!token) {
            mascotTalk('Bạn cần đăng nhập để trò chuyện với mình nhé!');
            return;
        }

        const response = await fetch('http://127.0.0.1:8000/message/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                id_conv: getCurrentConvId(),
                question: `${question} (Hãy trả lời bằng tiếng Việt)`,
                subject: window.currentSubject || 'Chemistry'
            })
        });

        if (!response.ok) throw new Error(`Server error ${response.status}`);

        const data = await response.json();
        const newId = data.id_conversation;
        if (newId) {
            window.currentConvId = newId;
            localStorage.setItem('mascot_conv_id', newId);
        }

        if (typeof window.loadConversations === 'function') {
            window.loadConversations();
        }

        mascotTalk(data.answer);
    } catch (error) {
        console.error(error);
        mascotTalk('Rất tiếc, mình gặp lỗi khi kết nối với hệ thống. Bạn thử lại nhé!');
    } finally {
        if (mascotInput) {
            mascotInput.disabled = false;
            mascotInput.focus();
        }
        if (mascotSendBtn) mascotSendBtn.disabled = false;
    }
}

function handleMascotChat() {
    const mascotInput = document.getElementById('mascot-input');
    const message = mascotInput?.value.trim();
    if (!message) return;

    sendMascotMessage(message);
    mascotInput.value = '';
}

async function loadMessages(id) {
    if (!id) return;
    window.currentConvId = id;

    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/message/full_history/${id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) return;

        const data = await response.json();
        const instructions = data.mascot_instructions || [];
        if (instructions.length > 0) {
            const recent = instructions.slice(-6);
            recent.forEach(msg => mascotTalk(msg.context));
        } else {
            mascotTalk('Chào mừng bạn trở lại! Bạn muốn tiếp tục thí nghiệm gì nào?');
        }
    } catch (error) {
        console.error('Mascot history load error:', error);
    }
}

window.loadMessages = loadMessages;

document.addEventListener('DOMContentLoaded', () => {
    ensurePanel();

    const mascotInput = document.getElementById('mascot-input');
    const mascotSendBtn = document.getElementById('mascot-send-btn');

    mascotSendBtn?.addEventListener('click', handleMascotChat);
    mascotInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleMascotChat();
    });

    const pathParts = window.location.pathname.split('/');
    const idFromUrl = pathParts[pathParts.length - 1];
    if (idFromUrl && idFromUrl.length > 30) {
        window.currentConvId = idFromUrl;
        localStorage.setItem('mascot_conv_id', idFromUrl);
        loadMessages(idFromUrl);

        window.setTimeout(() => {
            if (window.checkBackendStatus) window.checkBackendStatus();
        }, 1000);
    }
});
