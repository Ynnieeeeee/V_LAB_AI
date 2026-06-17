const $ = (id) => document.getElementById(id);

const state = {
    currentView: "overview",
    user: null,
    users: [],
    documents: [],
    tools: [],
    revenue: [],
    overview: null,
};

const viewTitles = {
    overview: "Tổng quan",
    users: "Quản lý người dùng",
    documents: "Quản lý tài liệu hệ thống",
    tools: "Quản lý dụng cụ phòng thí nghiệm",
    revenue: "Thống kê, báo cáo doanh thu",
};

const viewCopies = {
    overview: "Theo dõi nhanh người dùng, tài liệu hệ thống, dụng cụ và doanh thu của hệ thống.",
    users: "Thêm, sửa, xóa mềm và phân quyền tài khoản sử dụng Virtual Lab AI.",
    documents: "Tải PDF lên, cập nhật metadata và đưa tài liệu vào pipeline vector hóa.",
    tools: "Quản lý danh sách dụng cụ, trạng thái tạo mô hình 3D và xóa mềm.",
    revenue: "Xem giao dịch, thống kê tổng quan và xuất báo cáo doanh thu CSV.",
};

const statusClass = {
    active: "is-active",
    deleted: "is-deleted",
    completed: "is-active",
    processing: "is-processing",
    running: "is-processing",
    pending: "is-pending",
    queued: "is-pending",
    failed: "is-deleted",
    failed_public_image_url: "is-deleted",
    refunded: "is-processing",
    unknown: "is-unknown",
};

function token() {
    return localStorage.getItem("access_token");
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString("vi-VN", {
        style: "currency",
        currency: "VND",
        maximumFractionDigits: 0,
    });
}

function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("vi-VN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function badge(label, status = "unknown") {
    const css = statusClass[status] || statusClass.unknown;
    return `<span class="admin-badge ${css}">${escapeHtml(label)}</span>`;
}

function subjectLabel(subject) {
    return {
        chemistry: "Hóa học",
        physics: "Vật lý",
        biology: "Sinh học",
        general: "Chung",
    }[subject] || subject || "-";
}

function emptyRow(colspan, label) {
    return `<tr><td colspan="${colspan}" class="empty-cell">${label}</td></tr>`;
}

function showToast(message, tone = "default") {
    const toast = $("toast");
    toast.textContent = message;
    toast.className = `toast ${tone === "error" ? "is-error" : ""}`;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token()}`);
    if (options.body && !(options.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 || response.status === 403) {
        localStorage.removeItem("access_token");
        localStorage.removeItem("user");
        window.location.href = "/login";
        throw new Error("Phiên đăng nhập đã hết hạn");
    }
    if (!response.ok) {
        let detail = response.statusText;
        try {
            const payload = await response.json();
            detail = payload.detail || payload.error || detail;
        } catch (_) {
            detail = response.statusText;
        }
        throw new Error(detail);
    }
    if (response.status === 204) return null;
    return response.json();
}

async function initAuth() {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get("token");
    if (tokenFromUrl) {
        localStorage.setItem("access_token", tokenFromUrl);
    }

    if (!token()) {
        window.location.href = "/login";
        return false;
    }

    const response = await fetch("/auth/me", {
        headers: { Authorization: `Bearer ${token()}` },
    });

    if (!response.ok) {
        localStorage.removeItem("access_token");
        localStorage.removeItem("user");
        window.location.href = "/login";
        return false;
    }

    const user = await response.json();
    if (user.role !== "admin") {
        showToast("Tài khoản không có quyền admin", "error");
        setTimeout(() => {
            window.location.href = "/chat";
        }, 900);
        return false;
    }

    state.user = user;
    localStorage.setItem("user", JSON.stringify({
        username: user.username,
        avatar: user.avt_url,
        role: user.role,
    }));
    $("adminName").textContent = user.username || user.email || "Admin";
    $("adminGreeting").textContent = `Good morning, ${user.username || "Admin"}. ${viewCopies.overview}`;

    if (tokenFromUrl) {
        window.history.replaceState({}, document.title, "/dashboard");
    }
    return true;
}

function setView(view) {
    state.currentView = view;
    $("viewTitle").textContent = viewTitles[view] || "Dashboard";
    $("adminGreeting").textContent = `Good morning, ${state.user?.username || "Admin"}. ${viewCopies[view] || ""}`;

    document.querySelectorAll(".admin-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== `panel-${view}`);
    });

    document.querySelectorAll(".admin-nav-btn").forEach((button) => {
        button.classList.toggle("nav-active", button.dataset.view === view);
    });

    $("adminNav").classList.remove("is-open");
    loadCurrentView();
}

async function loadCurrentView() {
    try {
        if (state.currentView === "overview") await loadOverview();
        if (state.currentView === "users") await loadUsers();
        if (state.currentView === "documents") await loadDocuments();
        if (state.currentView === "tools") await loadTools();
        if (state.currentView === "revenue") await loadRevenue();
    } catch (error) {
        showToast(error.message, "error");
    }
}

async function loadOverview() {
    state.overview = await api("/api/admin/overview");
    const totals = state.overview.totals || {};
    $("totalUsers").textContent = totals.users || 0;
    $("totalDocuments").textContent = totals.documents || 0;
    $("totalTools").textContent = totals.tools || 0;
    $("totalRevenue").textContent = formatMoney(totals.revenue || 0);
    renderMonthlyChart(state.overview.revenue_by_month || []);
    renderPaymentStatus(state.overview.payment_statuses || {});
}

function renderMonthlyChart(rows) {
    const chart = $("monthlyChart");
    if (!rows.length) {
        chart.innerHTML = `<div class="line-chart-empty">Chưa có doanh thu</div>`;
        return;
    }

    const width = 640;
    const height = 210;
    const padX = 34;
    const padY = 26;
    const max = Math.max(...rows.map((row) => Number(row.amount || 0)), 1);
    const min = Math.min(...rows.map((row) => Number(row.amount || 0)), 0);
    const spread = Math.max(max - min, 1);
    const xStep = rows.length > 1 ? (width - padX * 2) / (rows.length - 1) : 0;
    const points = rows.map((row, index) => {
        const x = padX + xStep * index;
        const ratio = (Number(row.amount || 0) - min) / spread;
        const y = height - padY - ratio * (height - padY * 2);
        return { x, y, ...row };
    });

    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const circles = points.map((point) => `
        <circle cx="${point.x}" cy="${point.y}" r="4.5"></circle>
        <text x="${point.x}" y="${height - 5}" text-anchor="middle">${escapeHtml(point.month)}</text>
    `).join("");

    chart.innerHTML = `
        <svg class="line-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Biểu đồ doanh thu">
            <defs>
                <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="rgba(18,18,18,0.18)"></stop>
                    <stop offset="100%" stop-color="rgba(18,18,18,0)"></stop>
                </linearGradient>
            </defs>
            <path d="M ${padX} ${height - padY} L ${polyline} L ${width - padX} ${height - padY} Z" fill="url(#chartFill)"></path>
            <polyline points="${polyline}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
            <g fill="#111" font-size="12" font-weight="800">${circles}</g>
        </svg>
    `;
}

function renderPaymentStatus(statuses) {
    const entries = Object.entries(statuses);
    if (!entries.length) {
        $("paymentStatus").innerHTML = `<div class="status-empty">Chưa có thanh toán</div>`;
        return;
    }
    $("paymentStatus").innerHTML = entries.map(([name, count]) => `
        <div class="status-item">
            <span>${escapeHtml(name)}</span>
            ${badge(count, name)}
        </div>
    `).join("");
}

async function loadUsers() {
    const query = new URLSearchParams({
        q: $("userSearch").value.trim(),
        include_deleted: $("includeDeletedUsers").checked ? "true" : "false",
    });
    state.users = await api(`/api/admin/users?${query}`);
    renderUsers();
}

function renderUsers() {
    const table = $("usersTable");
    if (!state.users.length) {
        table.innerHTML = emptyRow(6, "Không có người dùng");
        return;
    }
    table.innerHTML = state.users.map((user) => `
        <tr>
            <td>
                <strong>${escapeHtml(user.username || "-")}</strong>
                <small>${escapeHtml(user.id_profile)}</small>
            </td>
            <td>${escapeHtml(user.email || "-")}</td>
            <td>${badge(user.role || "user", user.role === "admin" ? "processing" : "unknown")}</td>
            <td>${escapeHtml(user.provider || "-")}</td>
            <td>${user.is_deleted ? badge("Đã xóa", "deleted") : badge("Hoạt động", "active")}</td>
            <td>
                <div class="action-group">
                    <button class="row-action" data-action="edit-user" data-id="${user.id_profile}" title="Sửa" type="button">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    ${user.is_deleted ? `
                    <button class="row-action" data-action="restore-user" data-id="${user.id_profile}" title="Khôi phục" type="button">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>` : `
                    <button class="row-action danger" data-action="delete-user" data-id="${user.id_profile}" title="Xóa" type="button">
                        <i class="fa-solid fa-trash"></i>
                    </button>`}
                </div>
            </td>
        </tr>
    `).join("");
}

function openUserModal(user = null) {
    $("userModalTitle").textContent = user ? "Sửa người dùng" : "Thêm người dùng";
    $("userId").value = user?.id_profile || "";
    $("userUsername").value = user?.username || "";
    $("userEmail").value = user?.email || "";
    $("userRole").value = user?.role || "user";
    $("userProvider").value = user?.provider || "local";
    $("userAvatar").value = user?.avt_url || "";
    openModal("userModal");
}

async function saveUser(event) {
    event.preventDefault();
    const id = $("userId").value;
    const payload = {
        username: $("userUsername").value.trim(),
        email: $("userEmail").value.trim(),
        role: $("userRole").value,
        provider: $("userProvider").value.trim() || "local",
        avt_url: $("userAvatar").value.trim(),
    };
    await api(id ? `/api/admin/users/${id}` : "/api/admin/users", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
    });
    closeModal("userModal");
    showToast("Đã lưu người dùng");
    await loadUsers();
    await loadOverview();
}

async function loadDocuments() {
    const query = new URLSearchParams({
        q: $("docSearch").value.trim(),
        subject: $("docSubjectFilter").value,
        include_deleted: $("includeDeletedDocs").checked ? "true" : "false",
    });
    state.documents = await api(`/api/admin/documents?${query}`);
    renderDocuments();
}

function renderDocuments() {
    const table = $("docsTable");
    if (!state.documents.length) {
        table.innerHTML = emptyRow(6, "Không có tài liệu");
        return;
    }
    table.innerHTML = state.documents.map((doc) => {
        const vectorStatus = doc.vector_status || "unknown";
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(doc.title || "-")}</strong>
                    <small>${escapeHtml(doc.source || "")}</small>
                </td>
                <td>${subjectLabel(doc.subject)}</td>
                <td>${badge(vectorStatus, vectorStatus)}</td>
                <td>${Number(doc.chunk_count || 0)}</td>
                <td>${formatDate(doc.created_at)}</td>
                <td>
                    <div class="action-group">
                        <button class="row-action" data-action="edit-doc" data-id="${doc.id_doc}" title="Sửa" type="button">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="row-action" data-action="vectorize-doc" data-id="${doc.id_doc}" title="Tạo vector" type="button">
                            <i class="fa-solid fa-arrows-rotate"></i>
                        </button>
                        ${doc.is_deleted ? `
                        <button class="row-action" data-action="restore-doc" data-id="${doc.id_doc}" title="Khôi phục" type="button">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>` : `
                        <button class="row-action danger" data-action="delete-doc" data-id="${doc.id_doc}" title="Xóa" type="button">
                            <i class="fa-solid fa-trash"></i>
                        </button>`}
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

async function uploadDocument(event) {
    event.preventDefault();
    const file = $("docFile").files[0];
    if (!file) {
        showToast("Chọn file PDF", "error");
        return;
    }
    const formData = new FormData();
    formData.append("title", $("docTitle").value.trim());
    formData.append("subject", $("docSubject").value);
    formData.append("file", file);

    await api("/api/admin/documents", {
        method: "POST",
        body: formData,
    });
    $("docUploadForm").reset();
    $("docSubject").value = "chemistry";
    showToast("Đã tải lên tài liệu");
    await loadDocuments();
    await loadOverview();
}

function openDocumentModal(doc) {
    $("documentId").value = doc.id_doc;
    $("documentTitle").value = doc.title || "";
    $("documentSubject").value = doc.subject || "general";
    $("documentReindex").checked = false;
    openModal("documentModal");
}

async function saveDocument(event) {
    event.preventDefault();
    const id = $("documentId").value;
    await api(`/api/admin/documents/${id}`, {
        method: "PUT",
        body: JSON.stringify({
            title: $("documentTitle").value.trim(),
            subject: $("documentSubject").value,
            reindex: $("documentReindex").checked,
        }),
    });
    closeModal("documentModal");
    showToast("Đã lưu tài liệu");
    await loadDocuments();
}

async function loadTools() {
    const query = new URLSearchParams({
        q: $("toolSearch").value.trim(),
        subject: $("toolSubjectFilter").value,
        include_deleted: $("includeDeletedTools").checked ? "true" : "false",
    });
    state.tools = await api(`/api/admin/tools?${query}`);
    renderTools();
}

function renderTools() {
    const table = $("toolsTable");
    if (!state.tools.length) {
        table.innerHTML = emptyRow(7, "Không có dụng cụ");
        return;
    }
    table.innerHTML = state.tools.map((tool) => {
        const modelStatus = tool.model_generation_status || "unknown";
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(tool.name_tool_vi || tool.name_tool_en || "-")}</strong>
                    <small>${escapeHtml(tool.name_tool_en || "")}</small>
                    <small>${escapeHtml(tool.id_conv ? `Cuộc hội thoại: ${tool.id_conv}` : "Mẫu chung")}</small>
                </td>
                <td>${subjectLabel(tool.subject_type)}</td>
                <td>${escapeHtml(tool.tool_type || "-")}</td>
                <td>${Number(tool.quantity || 0)}</td>
                <td>${badge(modelStatus, modelStatus)}</td>
                <td>${tool.is_deleted ? badge("Đã xóa", "deleted") : badge("Hoạt động", "active")}</td>
                <td>
                    <div class="action-group">
                        <button class="row-action" data-action="edit-tool" data-id="${tool.id_tool}" title="Sửa" type="button">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        ${tool.image_2d_url ? `
                        <button class="row-action" data-action="generate-tool-model" data-id="${tool.id_tool}" title="Tạo mô hình từ ảnh 2D" type="button">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                        </button>` : ""}
                        ${tool.is_deleted ? `
                        <button class="row-action" data-action="restore-tool" data-id="${tool.id_tool}" title="Khôi phục" type="button">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>` : `
                        <button class="row-action danger" data-action="delete-tool" data-id="${tool.id_tool}" title="Xóa mềm" type="button">
                            <i class="fa-solid fa-trash"></i>
                        </button>`}
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

function openToolModal(tool = null) {
    $("toolModalTitle").textContent = tool ? "Sửa dụng cụ" : "Thêm dụng cụ";
    $("toolId").value = tool?.id_tool || "";
    $("toolNameVi").value = tool?.name_tool_vi || "";
    $("toolNameEn").value = tool?.name_tool_en || "";
    $("toolType").value = tool?.tool_type || "";
    $("toolQuantity").value = Number(tool?.quantity ?? 1);
    $("toolSubject").value = tool?.subject_type || "general";
    $("toolStatus").value = tool?.model_generation_status || "pending";
    $("toolConversationId").value = tool?.id_conv || "";
    $("toolImageUrl").value = tool?.image_2d_url || "";
    $("toolRegenerateModel").checked = false;
    openModal("toolModal");
}

async function saveTool(event) {
    event.preventDefault();
    const id = $("toolId").value;
    await api(id ? `/api/admin/tools/${id}` : "/api/admin/tools", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({
            name_tool_vi: $("toolNameVi").value.trim(),
            name_tool_en: $("toolNameEn").value.trim(),
            tool_type: $("toolType").value.trim(),
            quantity: $("toolQuantity").value,
            subject_type: $("toolSubject").value,
            model_generation_status: $("toolStatus").value,
            id_conv: $("toolConversationId").value.trim(),
            image_2d_url: $("toolImageUrl").value.trim(),
            regenerate_model: $("toolRegenerateModel").checked,
        }),
    });
    closeModal("toolModal");
    showToast($("toolRegenerateModel").checked ? "Đã đưa mô hình vào hàng đợi tạo 3D" : (id ? "Đã lưu dụng cụ" : "Đã thêm dụng cụ"));
    await loadTools();
    await loadOverview();
}

async function loadRevenue() {
    state.revenue = await api("/api/admin/revenue");
    renderRevenue();
}

function renderRevenue() {
    const completed = state.revenue.filter((payment) => payment.status === "completed");
    const pending = state.revenue.filter((payment) => payment.status === "pending");
    const total = completed.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const waiting = pending.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

    $("revenueStats").innerHTML = `
        <div>
            <span>Đã thu</span>
            <strong>${formatMoney(total)}</strong>
        </div>
        <div>
            <span>Đang chờ</span>
            <strong>${formatMoney(waiting)}</strong>
        </div>
        <div>
            <span>Giao dịch</span>
            <strong>${state.revenue.length}</strong>
        </div>
    `;

    const table = $("revenueTable");
    if (!state.revenue.length) {
        table.innerHTML = emptyRow(6, "Không có giao dịch");
        return;
    }
    table.innerHTML = state.revenue.map((payment) => `
        <tr>
            <td>${escapeHtml(payment.user || "-")}</td>
            <td>${escapeHtml(payment.plan || "-")}</td>
            <td><strong>${formatMoney(payment.amount || 0)}</strong></td>
            <td>${badge(payment.status || "unknown", payment.status || "unknown")}</td>
            <td>${escapeHtml(payment.method || "-")}</td>
            <td>${formatDate(payment.created_at)}</td>
        </tr>
    `).join("");
}

async function exportRevenue() {
    const response = await fetch("/api/admin/reports/revenue.csv", {
        headers: { Authorization: `Bearer ${token()}` },
    });
    if (!response.ok) {
        showToast("Không thể xuất báo cáo", "error");
        return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `revenue-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function openModal(id) {
    $(id).classList.remove("hidden");
}

function closeModal(id) {
    $(id).classList.add("hidden");
}

function findById(collection, id, field) {
    return collection.find((item) => item[field] === id);
}

async function handleRowAction(event) {
    const button = event.target.closest(".row-action");
    if (!button) return;
    const { action, id } = button.dataset;
    try {
        if (action === "edit-user") openUserModal(findById(state.users, id, "id_profile"));
        if (action === "delete-user" && confirm("Xóa người dùng này?")) {
            await api(`/api/admin/users/${id}`, { method: "DELETE" });
            showToast("Đã xóa người dùng");
            await loadUsers();
            await loadOverview();
        }
        if (action === "restore-user") {
            await api(`/api/admin/users/${id}`, {
                method: "PUT",
                body: JSON.stringify({ is_deleted: false }),
            });
            showToast("Đã khôi phục người dùng");
            await loadUsers();
            await loadOverview();
        }

        if (action === "edit-doc") openDocumentModal(findById(state.documents, id, "id_doc"));
        if (action === "vectorize-doc") {
            await api(`/api/admin/documents/${id}/vectorize`, { method: "POST" });
            showToast("Đã đưa tài liệu vào hàng đợi vector");
            await loadDocuments();
        }
        if (action === "delete-doc" && confirm("Xóa tài liệu này?")) {
            await api(`/api/admin/documents/${id}`, { method: "DELETE" });
            showToast("Đã xóa tài liệu");
            await loadDocuments();
            await loadOverview();
        }
        if (action === "restore-doc") {
            await api(`/api/admin/documents/${id}`, {
                method: "PUT",
                body: JSON.stringify({ is_deleted: false }),
            });
            showToast("Đã khôi phục tài liệu");
            await loadDocuments();
            await loadOverview();
        }

        if (action === "edit-tool") openToolModal(findById(state.tools, id, "id_tool"));
        if (action === "generate-tool-model" && confirm("Tạo lại mô hình 3D từ image_2d_url của dụng cụ này?")) {
            await api(`/api/admin/tools/${id}`, {
                method: "PUT",
                body: JSON.stringify({ regenerate_model: true }),
            });
            showToast("Đã đưa mô hình vào hàng đợi tạo 3D");
            await loadTools();
        }
        if (action === "delete-tool" && confirm("Xóa mềm dụng cụ này?")) {
            await api(`/api/admin/tools/${id}/soft-delete`, { method: "PATCH" });
            showToast("Đã xóa mềm dụng cụ");
            await loadTools();
            await loadOverview();
        }
        if (action === "restore-tool") {
            await api(`/api/admin/tools/${id}`, {
                method: "PUT",
                body: JSON.stringify({ is_deleted: false }),
            });
            showToast("Đã khôi phục dụng cụ");
            await loadTools();
            await loadOverview();
        }
    } catch (error) {
        showToast(error.message, "error");
    }
}

function bindEvents() {
    $("mobileNavBtn").addEventListener("click", () => {
        $("adminNav").classList.toggle("is-open");
    });

    document.querySelectorAll(".admin-nav-btn").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.view));
    });

    document.querySelectorAll(".close-modal").forEach((button) => {
        button.addEventListener("click", () => closeModal(button.dataset.modal));
    });

    $("logoutBtn").addEventListener("click", () => {
        localStorage.removeItem("access_token");
        localStorage.removeItem("user");
        window.location.href = "/login";
    });

    $("addUserBtn").addEventListener("click", () => openUserModal());
    $("addToolBtn").addEventListener("click", () => openToolModal());
    $("userForm").addEventListener("submit", (event) => saveUser(event).catch((error) => showToast(error.message, "error")));
    $("documentForm").addEventListener("submit", (event) => saveDocument(event).catch((error) => showToast(error.message, "error")));
    $("toolForm").addEventListener("submit", (event) => saveTool(event).catch((error) => showToast(error.message, "error")));
    $("docUploadForm").addEventListener("submit", (event) => uploadDocument(event).catch((error) => showToast(error.message, "error")));
    $("exportRevenueBtn").addEventListener("click", () => exportRevenue().catch((error) => showToast(error.message, "error")));

    $("usersTable").addEventListener("click", handleRowAction);
    $("docsTable").addEventListener("click", handleRowAction);
    $("toolsTable").addEventListener("click", handleRowAction);

    ["userSearch", "includeDeletedUsers"].forEach((id) => $(id).addEventListener("input", () => loadUsers().catch((error) => showToast(error.message, "error"))));
    ["docSearch", "docSubjectFilter", "includeDeletedDocs"].forEach((id) => $(id).addEventListener("input", () => loadDocuments().catch((error) => showToast(error.message, "error"))));
    ["toolSearch", "toolSubjectFilter", "includeDeletedTools"].forEach((id) => $(id).addEventListener("input", () => loadTools().catch((error) => showToast(error.message, "error"))));
}

document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    try {
        const ready = await initAuth();
        if (!ready) return;
        setView("overview");
    } catch (error) {
        showToast(error.message, "error");
    }
});
