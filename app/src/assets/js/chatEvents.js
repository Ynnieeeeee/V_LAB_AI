export function initChatEvents() {
    const input = document.getElementById('chat-input');
    const statusText = document.getElementById('status-text');
    const btn = document.getElementById('send-btn');
    const uploadBtn = document.getElementById('image-upload-btn');
    const imageInput = document.getElementById('model-image-input');

    if (!input || !btn) {
        console.warn('Khong the khoi tao chat: thieu #chat-input hoac #send-btn.');
        return;
    }

    const setStatus = (message) => {
        if (statusText) statusText.textContent = message;
    };

    const setBusy = (isBusy) => {
        [btn, uploadBtn].filter(Boolean).forEach((element) => {
            element.disabled = isBusy;
            element.classList.toggle('opacity-50', isBusy);
            element.classList.toggle('cursor-not-allowed', isBusy);
        });
    };

    const authHeaders = (extra = {}) => {
        const token = localStorage.getItem('access_token');
        return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
    };

    const hasActiveConversation = () => (
        window.currentConvId &&
        window.currentConvId !== 'null' &&
        window.currentConvId !== 'undefined'
    );

    const claimConversation = (result) => {
        if (hasActiveConversation() || !result.conversation_id) return;

        window.currentConvId = result.conversation_id;
        localStorage.setItem('lab_conv_id', result.conversation_id);
        window.history.pushState({}, '', `/chat/${result.conversation_id}`);
        window.claimCurrentMovableTablesForRoom?.(result.conversation_id);
        window.claimCurrentRoomLayoutForRoom?.(result.conversation_id)?.catch?.((error) => {
            console.warn('[RoomLayout] failed to claim layout for new room:', error);
        });

        if (typeof window.loadConversations === 'function') {
            window.loadConversations();
        }
    };

    const responseDetail = async (response) => {
        let detail = `Server bao loi ${response.status}`;
        try {
            const payload = await response.json();
            detail = payload?.detail || payload?.error || detail;
        } catch (_) {}
        return detail;
    };

    const finishSuccessfulRequest = (result, pendingMessage, readyMessage) => {
        const items = result.data || [];
        const waitingForModels = items.some((item) => !item.ready);
        window.registerPendingModelTools?.(items);
        claimConversation(result);
        input.value = '';
        setStatus(waitingForModels ? pendingMessage : readyMessage);
        window.checkBackendStatus?.({ force: true });
    };

    const handleSend = async () => {
        const text = input.value.trim();
        if (!text) return;

        setBusy(true);
        setStatus('AI dang phan tich va chuan bi dung cu...');
        statusText?.classList.add('text-pulse');

        try {
            const response = await fetch('/api/lab/generate', {
                method: 'POST',
                headers: authHeaders({ 'Content-type': 'application/json' }),
                body: JSON.stringify({
                    text,
                    id_conv: window.currentConvId,
                    subject: window.currentSubject || 'chemistry'
                })
            });

            if (response.ok) {
                const result = await response.json();
                finishSuccessfulRequest(
                    result,
                    'Dang tao mo hinh 3D cho dung cu...',
                    'Dang dua dung cu len ban...'
                );
            } else {
                setStatus('Loi: ' + await responseDetail(response));
            }
        } catch (err) {
            setStatus('Loi: Mat ket noi server');
        } finally {
            setBusy(false);
            statusText?.classList.remove('text-pulse');
        }
    };

    const handleImageUpload = async () => {
        const file = imageInput?.files?.[0];
        if (!file) return;
        imageInput.value = '';

        if (file.type && !file.type.startsWith('image/')) {
            setStatus('Loi: File duoc chon khong phai anh');
            return;
        }

        const formData = new FormData();
        const toolName = input.value.trim();
        formData.append('image', file);
        formData.append('id_conv', window.currentConvId || '');
        formData.append('subject', window.currentSubject || 'chemistry');
        if (toolName) formData.append('tool_name', toolName);

        setBusy(true);
        setStatus('Dang tai anh va tao tac vu 3D...');
        statusText?.classList.add('text-pulse');

        try {
            const response = await fetch('/api/lab/upload-model-image', {
                method: 'POST',
                headers: authHeaders(),
                body: formData
            });

            if (response.ok) {
                const result = await response.json();
                finishSuccessfulRequest(
                    result,
                    'Dang tao mo hinh 3D tu anh vua tai len...',
                    'Anh da san sang tao mo hinh 3D.'
                );
            } else {
                setStatus('Loi: ' + await responseDetail(response));
            }
        } catch (err) {
            setStatus('Loi: Khong the tai anh len server');
        } finally {
            setBusy(false);
            statusText?.classList.remove('text-pulse');
        }
    };

    btn.onclick = handleSend;
    btn.onkeypress = (event) => {
        if (event.key === 'Enter') handleSend();
    };

    uploadBtn?.addEventListener('click', () => imageInput?.click());
    imageInput?.addEventListener('change', handleImageUpload);

    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            handleSend();
        }
    });
    input.addEventListener('keyup', (event) => event.stopPropagation());
    input.addEventListener('keypress', (event) => event.stopPropagation());
}
