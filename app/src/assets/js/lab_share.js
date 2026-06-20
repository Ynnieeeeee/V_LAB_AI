// =========================================================
// Lab Share Module
// - Quản lý shared lab mode (khi truy cập via /share/lab/:token)
// - Quản lý nút "Chia sẻ" và modal share cho chủ phòng
// =========================================================

(function () {
    // ------- 1. Phát hiện chế độ Shared Lab -------
    const match = window.location.pathname.match(/^\/share\/lab\/([^/]+)\/?$/);
    window.isSharedLabMode = Boolean(match);
    window.labShareToken = match ? decodeURIComponent(match[1]) : null;

    // PUBLIC_BASE_URL lấy từ /api/config — được set trong backend .env
    // Đảm bảo link share luôn dùng đúng IP/domain kể cả khi user mở qua localhost
    window._publicBaseUrl = "";

    async function fetchPublicBaseUrl() {
        try {
            const res = await fetch("/api/config");
            if (!res.ok) return;
            const data = await res.json();
            if (data.public_base_url && data.public_base_url.trim()) {
                window._publicBaseUrl = data.public_base_url.trim().replace(/\/$/, "");
                console.log("[LabShare] Public base URL:", window._publicBaseUrl);
            }
        } catch (e) {
            console.warn("[LabShare] Could not fetch /api/config", e);
        }
    }

    // Build share URL: dùng public_base_url từ config nếu có,
    // nếu không có hoặc là localhost thì dùng window.location.origin
    function buildShareUrl(token) {
        const base = window._publicBaseUrl;
        if (base && !/localhost|127\.0\.0\.1/.test(base)) {
            return `${base}/share/lab/${token}`;
        }
        // Fallback: dùng origin của browser
        // (sẽ đúng nếu user mở app qua IP LAN)
        return `${window.location.origin}/share/lab/${token}`;
    }

    // ------- 2. Helper tạo header cho mọi request -------
    function hasLabAccessHeader(headers = {}) {
        return Boolean(headers.Authorization || headers["X-Lab-Share-Token"]);
    }
    window.hasLabAccessHeader = hasLabAccessHeader;

    window.labAuthHeaders = function labAuthHeaders(baseHeaders = {}) {
        const headers = { ...baseHeaders };
        if (window.isSharedLabMode && window.labShareToken) {
            headers["X-Lab-Share-Token"] = window.labShareToken;
            return headers;
        }
        const token = localStorage.getItem("access_token");
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    };

    window.hasLabAccess = function hasLabAccess() {
        return Boolean(
            (window.isSharedLabMode && window.labShareToken) ||
            localStorage.getItem("access_token")
        );
    };

    // ------- 3. Shared Lab Chrome (ẩn UI không cần thiết) -------
    function setHidden(id, hidden = true) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle("hidden", hidden);
        el.style.display = hidden ? "none" : "";
    }

    function applySharedChrome() {
        document.body.classList.add("shared-lab-mode");
        setHidden("sidebarBtn");
        setHidden("menuSidebar");
        setHidden("shareRoomBtn");
        setHidden("addTableBtn");

        const userArea = document.getElementById("user-area");
        if (userArea) userArea.style.display = "none";

        const inputShell = document.getElementById("chat-input-shell");
        if (inputShell) inputShell.style.display = "none";

        const input = document.getElementById("chat-input");
        if (input) { input.disabled = true; input.value = ""; }

        const sendBtn = document.getElementById("send-btn");
        if (sendBtn) sendBtn.disabled = true;
    }

    let sharedRoomLoaded = false;
    let sharedRendererLoaded = Boolean(window.labRendererReady);
    let rendererWatchdog = null;

    function prepareSharedOverlay() {
        const overlay = document.getElementById("subject-overlay");
        if (!overlay) return null;
        overlay.classList.remove("hidden", "opacity-0");
        overlay.style.display = "";
        overlay.style.opacity = "1";
        overlay.style.pointerEvents = "auto";
        return overlay;
    }

    function showSharedLabLoading(message = "Đang tải dữ liệu và khởi động đồ họa 3D...") {
        const overlay = prepareSharedOverlay();
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="text-center text-white px-6">
                <div class="w-12 h-12 border-2 border-blue-300/30 border-t-blue-300 rounded-full animate-spin mb-5 mx-auto"></div>
                <h1 class="text-xl font-bold mb-2">Đang mở phòng lab</h1>
                <p class="text-sm text-white/70">${message}</p>
            </div>
        `;
    }

    function showSharedLabError(message, retryable = true) {
        const overlay = prepareSharedOverlay();
        if (!overlay) return;
        overlay.innerHTML = `
            <div class="text-center text-white px-6">
                <div class="w-20 h-20 rounded-full bg-red-500/10 border border-red-400/20 flex items-center justify-center mb-5 mx-auto">
                    <i class="fa-solid fa-triangle-exclamation text-red-400 text-2xl"></i>
                </div>
                <h1 class="text-2xl font-bold mb-3">Không thể mở phòng lab</h1>
                <p class="text-sm text-white/70">${message}</p>
                ${retryable ? `
                    <button type="button" data-retry-shared-lab
                        class="mt-5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold">
                        Thử lại
                    </button>
                ` : ""}
            </div>
        `;
        overlay.querySelector("[data-retry-shared-lab]")?.addEventListener("click", () => {
            window.retrySharedLabRoom?.();
        });
    }

    function finishSharedLabLoading() {
        if (!sharedRoomLoaded || !sharedRendererLoaded) return;
        const overlay = document.getElementById("subject-overlay");
        if (!overlay) return;
        clearTimeout(rendererWatchdog);
        overlay.classList.add("hidden");
        overlay.style.display = "none";
        overlay.style.pointerEvents = "none";
    }

    window.addEventListener("lab:renderer-ready", () => {
        sharedRendererLoaded = true;
        finishSharedLabLoading();
    });

    window.addEventListener("lab:renderer-error", (event) => {
        showSharedLabError(event.detail?.message || "Trình duyệt không khởi tạo được đồ họa 3D.");
    });

    function syncSharedSubject(subject, attempt = 0) {
        const action = subject === "chemistry" ? window.loadChemistryCabinet : window.hideChemistryCabinet;
        if (typeof action === "function") { action(); return; }
        if (attempt < 40) setTimeout(() => syncSharedSubject(subject, attempt + 1), 100);
    }

    let sharedRoomPromise = null;

    function initSharedLabRoom() {
        if (!window.isSharedLabMode || !window.labShareToken) return Promise.resolve(null);
        if (sharedRoomPromise) return sharedRoomPromise;
        applySharedChrome();
        showSharedLabLoading();

        clearTimeout(rendererWatchdog);
        rendererWatchdog = setTimeout(() => {
            if (!sharedRendererLoaded) {
                showSharedLabError("Đồ họa 3D khởi động quá lâu. Hãy cập nhật Chrome và tắt chế độ tiết kiệm pin rồi thử lại.");
            }
        }, 20000);

        sharedRoomPromise = (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            try {
                const res = await fetch(`/api/lab/share/${encodeURIComponent(window.labShareToken)}`, {
                    headers: window.labAuthHeaders(),
                    signal: controller.signal
                });
                if (!res.ok) {
                    showSharedLabError("Link chia sẻ không tồn tại hoặc đã bị thu hồi.", false);
                    return null;
                }
                const room = await res.json();
                window.currentConvId = room.id;
                window.currentSubject = room.subject || "general";
                window.currentDraftRoomKey = null;
                document.title = room.title ? `${room.title} – vlab` : "Shared Lab – vlab";
                applySharedChrome();
                syncSharedSubject(window.currentSubject);
                window.dispatchEvent(new CustomEvent("lab:shared-room-ready", { detail: room }));
                window.checkBackendStatus?.();
                sharedRoomLoaded = true;
                finishSharedLabLoading();
                return room;
            } catch (err) {
                console.error("Unable to load shared lab room", err);
                const message = err?.name === "AbortError"
                    ? "Máy chủ phản hồi quá chậm. Vui lòng thử lại sau vài giây."
                    : "Không thể kết nối tới phòng lab được chia sẻ.";
                showSharedLabError(message);
                return null;
            } finally {
                clearTimeout(timeoutId);
            }
        })();
        window.sharedLabReady = sharedRoomPromise;
        return sharedRoomPromise;
    }

    window.retrySharedLabRoom = function retrySharedLabRoom() {
        sharedRoomPromise = null;
        sharedRoomLoaded = false;
        return initSharedLabRoom();
    };

    // ------- 4. Modal chia sẻ (dành cho chủ phòng) -------

    function setShareState(state) {
        // state: "off" | "on" | "loading"
        document.getElementById("shareStateOff")?.classList.toggle("hidden", state !== "off");
        document.getElementById("shareStateOn")?.classList.toggle("hidden", state !== "on");
        document.getElementById("shareStateLoading")?.classList.toggle("hidden", state !== "loading");
    }

    function updateShareAccessNote(shareUrl) {
        const note = document.getElementById("shareAccessNote");
        if (!note) return;
        try {
            const isDevTunnel = new URL(shareUrl).hostname.endsWith(".devtunnels.ms");
            note.textContent = isDevTunnel
                ? "Lần đầu mở link, Microsoft Dev Tunnels sẽ hiện cảnh báo. Người nhận cần bấm Continue một lần để vào phòng."
                : "Bất kỳ ai có link đều có thể mở phòng lab và tương tác với dụng cụ. Không cần đăng nhập.";
        } catch (_) {
            note.textContent = "Bất kỳ ai có link đều có thể mở phòng lab và tương tác với dụng cụ. Không cần đăng nhập.";
        }
    }

    function openShareModal() {
        const modal = document.getElementById("shareLabModal");
        if (!modal) return;
        modal.classList.remove("hidden");
        loadCurrentShareState();
    }

    function closeShareModal() {
        document.getElementById("shareLabModal")?.classList.add("hidden");
    }

    async function loadCurrentShareState() {
        const convId = window.currentConvId;
        if (!convId) {
            setShareState("off");
            return;
        }
        // Tra cứu share_token từ cache conversation list
        const cachedToken = typeof window.getConversationShareToken === "function"
            ? window.getConversationShareToken(convId)
            : null;

        if (cachedToken) {
            // Build URL đúng từ token (dùng public_base_url nếu có)
            const shareUrl = buildShareUrl(cachedToken);
            const urlInput = document.getElementById("shareUrlInput");
            if (urlInput) urlInput.value = shareUrl;
            updateShareAccessNote(shareUrl);
            setShareState("on");
        } else {
            const urlInput = document.getElementById("shareUrlInput");
            if (urlInput && urlInput.value) {
                setShareState("on");
            } else {
                setShareState("off");
            }
        }
    }

    async function createShareLink() {
        const convId = window.currentConvId;
        if (!convId) {
            showToast("Vui lòng chọn một phòng lab trước", "error");
            return;
        }
        const token = localStorage.getItem("access_token");
        if (!token) {
            showToast("Bạn cần đăng nhập để chia sẻ", "error");
            return;
        }

        setShareState("loading");
        try {
            const res = await fetch(`/chat/conversation/${convId}/share`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();

            const shareToken = data.share_token;
            // Luôn dùng buildShareUrl() — ưu tiên public_base_url từ /api/config
            const shareUrl = buildShareUrl(shareToken);

            const urlInput = document.getElementById("shareUrlInput");
            if (urlInput) urlInput.value = shareUrl;
            updateShareAccessNote(shareUrl);

            if (typeof window.setConversationShareToken === "function") {
                window.setConversationShareToken(convId, shareToken, true);
            }
            setShareState("on");
            showToast("Đã tạo link chia sẻ!", "success");
        } catch (err) {
            console.error(err);
            setShareState("off");
            showToast("Không thể tạo link chia sẻ", "error");
        }
    }

    async function revokeShareLink() {
        const convId = window.currentConvId;
        if (!convId) return;
        const token = localStorage.getItem("access_token");
        if (!token) return;

        setShareState("loading");
        try {
            const res = await fetch(`/chat/conversation/${convId}/share`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(await res.text());
            const urlInput = document.getElementById("shareUrlInput");
            if (urlInput) urlInput.value = "";
            if (typeof window.setConversationShareToken === "function") {
                window.setConversationShareToken(convId, null, false);
            }
            setShareState("off");
            showToast("Đã thu hồi link chia sẻ", "success");
        } catch (err) {
            console.error(err);
            setShareState("on");
            showToast("Không thể thu hồi link", "error");
        }
    }

    async function copyShareLink() {
        const urlInput = document.getElementById("shareUrlInput");
        if (!urlInput || !urlInput.value) return;
        try {
            await navigator.clipboard.writeText(urlInput.value);
            showCopySuccess();
            showToast("Đã sao chép link!", "success");
        } catch {
            urlInput.select();
            document.execCommand("copy");
            showCopySuccess();
            showToast("Đã sao chép link!", "success");
        }
    }

    function showCopySuccess() {
        const icon = document.getElementById("copyIcon");
        if (icon) {
            icon.className = "fa-solid fa-check text-sm";
            setTimeout(() => { icon.className = "fa-regular fa-copy text-sm"; }, 2000);
        }
    }

    function showToast(message, type = "info") {
        const existingToast = document.getElementById("toast");
        if (existingToast) {
            existingToast.textContent = message;
            existingToast.className = `toast ${type === "error" ? "toast-error" : "toast-success"}`;
            existingToast.classList.remove("hidden");
            setTimeout(() => existingToast.classList.add("hidden"), 3000);
            return;
        }
        let toast = document.getElementById("_shareToast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "_shareToast";
            toast.style.cssText = `
                position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
                z-index:9999; padding:12px 24px; border-radius:999px;
                font-size:14px; font-weight:600; color:white;
                transition:opacity .3s; white-space:nowrap;
                box-shadow:0 8px 32px rgba(0,0,0,.4);
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.background = type === "error" ? "#ef4444" : "#22c55e";
        toast.style.opacity = "1";
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { toast.style.opacity = "0"; }, 2800);
    }

    // ------- 5. Đăng ký sự kiện khi DOM sẵn sàng -------
    // This script sits at the end of <body>, so the shared-room request can
    // start immediately. DOMContentLoaded waits for the large 3D module graph;
    // fresh/incognito clients must not be blocked on those CDN imports.
    if (window.isSharedLabMode) {
        applySharedChrome();
        initSharedLabRoom();
    }

    document.addEventListener("DOMContentLoaded", async () => {
        // Fetch public base URL từ backend trước (quan trọng!)
        // Guest access must not wait for account or public URL configuration.
        if (window.isSharedLabMode) {
            applySharedChrome();
            initSharedLabRoom();
        }

        // Owners need this value when creating or copying a public link.
        await fetchPublicBaseUrl();

        // Khởi tạo shared lab mode nếu cần

        // Nút Chia sẻ ở top bar
        const shareRoomBtn = document.getElementById("shareRoomBtn");
        if (shareRoomBtn) {
            shareRoomBtn.addEventListener("click", () => {
                if (!window.currentConvId) {
                    showToast("Hãy chọn hoặc tạo một phòng lab trước", "error");
                    return;
                }
                openShareModal();
            });
        }

        // Nút đóng modal
        document.getElementById("closeShareModal")?.addEventListener("click", closeShareModal);

        // Click ngoài modal để đóng
        document.getElementById("shareLabModal")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeShareModal();
        });

        // Tạo link
        document.getElementById("createShareLinkBtn")?.addEventListener("click", createShareLink);

        // Copy link (icon button trong URL box)
        document.getElementById("copyShareLinkBtn")?.addEventListener("click", copyShareLink);

        // Copy link (button lớn bên dưới)
        document.getElementById("copyShareLinkBtn2")?.addEventListener("click", copyShareLink);

        // Thu hồi link
        document.getElementById("revokeShareBtn")?.addEventListener("click", () => {
            if (confirm("Bạn có chắc muốn thu hồi link chia sẻ? Người đang dùng link sẽ không thể truy cập nữa.")) {
                revokeShareLink();
            }
        });
    });

    // Expose để các module khác gọi nếu cần
    window.openShareModal = openShareModal;
    window.closeShareModal = closeShareModal;
    window.buildShareUrl = buildShareUrl;
})();
