import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { autoScaleModel, animateScale } from './utils.js';
import { applyAdvancedPBR } from './pbr.js';
import { applyToolMetadataToObject } from './ToolClassifier.js';
import { buildContainerCavityCSG } from './CavityCSG.js?v=20260527-liquid-anchored-fill';

const loader = new GLTFLoader();
const loaderModels = new Map(); // instanceId -> mesh
const currentlyLoading = new Set();
const API_URL = 'http://127.0.0.1:8000';

let globalScene = null;
let globalRegisterDraggable = null;
let lastConvId = null; // Theo dõi sự thay đổi cuộc hội thoại

/**
 * Khởi tạo môi trường làm việc
 */
export function initLabLogic(scene, registerDraggable) {
    globalScene = scene;
    globalRegisterDraggable = registerDraggable;
    
    // Xuất các hàm ra window để chat_logic.js hoặc các file khác gọi trực tiếp
    window.clearLab = () => clearLab(scene);
    window.checkBackendStatus = () => checkBackendStatus(scene);
    window.loadAndPlaceModel = (tool, displayIndex, instanceId) => 
        loadAndPlaceModel(scene, tool, displayIndex, instanceId);

    // Polling định kỳ cập nhật trạng thái dụng cụ (5 giây/lần)
    setInterval(() => checkBackendStatus(scene), 5000);
}

/**
 * Xóa sạch bàn thí nghiệm và bộ nhớ đệm
 */
export function clearLab(scene) {
    loaderModels.forEach((model) => {
        if (scene) scene.remove(model);
        if (model.geometry) model.geometry.dispose();
        if (model.material) {
            if (Array.isArray(model.material)) {
                model.material.forEach(m => m.dispose());
            } else {
                model.material.dispose();
            }
        }
    });
    
    loaderModels.clear();
    currentlyLoading.clear();
    
    // Reset giao diện danh sách dụng cụ
    const list = document.getElementById('tool-list');
    if (list) {
        list.innerHTML = '<li class="text-gray-500 text-xs italic py-2">Bàn trống...</li>';
    }
    
    console.log("Phòng Lab đã được làm sạch.");
}

/**
 * Kiểm tra trạng thái dụng cụ từ Backend
 */
async function checkBackendStatus(scene) {
    const id_conv = window.currentConvId;
    const token = localStorage.getItem('access_token');

    // SỬA LỖI 422: Nếu không có ID hợp lệ, không thực hiện gọi API
    if (!id_conv || id_conv === "null" || id_conv === "undefined") {
        return;
    }

    if (!token) {
        console.warn("Missing access token, skip lab status polling.");
        return;
    }

    // Nếu người dùng chuyển sang hội thoại khác, tự động dọn bàn
    if (lastConvId !== id_conv) {
        console.log("Phát hiện chuyển đổi hội thoại, đang làm mới bàn thí nghiệm...");
        clearLab(scene);
        lastConvId = id_conv;
    }

    try {
        // Gửi request kèm tham số id_conv rõ ràng
        const res = await fetch(`${API_URL}/api/lab/status?id_conv=${encodeURIComponent(id_conv)}`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        
        if (res.status === 422) {
            console.warn("Backend báo lỗi 422: ID hội thoại không đúng định dạng.");
            return;
        }

        if (res.status === 401 || res.status === 403) {
            let detail = `Backend returned ${res.status} while loading lab tools`;
            try {
                const payload = await res.json();
                detail = payload?.detail || detail;
            } catch (_) {}
            console.warn(detail);
            const statusText = document.getElementById('status-text');
            if (statusText) statusText.innerText = detail;
            return;
        }

        if (!res.ok) return;

        const data = await res.json();
        
        // Cập nhật text trạng thái trên UI
        const statusText = document.getElementById('status-text');
        if (statusText && !statusText.innerText.includes("phân tích")) {
            statusText.innerText = data.length > 0 ? 'Hệ thống sẵn sàng' : 'Bàn trống';
        }

        // Sắp xếp dụng cụ theo thời gian tạo để vị trí Grid không bị nhảy lung tung
        data.sort((a, b) => {
            const dateA = new Date(a.created_at).getTime();
            const dateB = new Date(b.created_at).getTime();
            return dateA - dateB || a.id_tool.localeCompare(b.id_tool);
        });

        let globalDisplayIndex = 0;

        data.forEach((tool) => {
            const quantity = tool.quantity || 1;
            for (let i = 0; i < quantity; i++) {
                const instanceId = `${tool.id_tool}_instance_${i}`;

                // Chỉ tải nếu dụng cụ chưa có trên bàn và không trong quá trình tải
                if (!loaderModels.has(instanceId) && !currentlyLoading.has(instanceId)) {
                    currentlyLoading.add(instanceId);
                    loadAndPlaceModel(scene, tool, globalDisplayIndex, instanceId);
                }
                globalDisplayIndex++;
            }
        });
    } catch (err) {
        // Chỉ log cảnh báo thay vì lỗi đỏ nếu không kết nối được backend
        if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
            console.warn("Không thể kết nối đến Backend (127.0.0.1:8000). Vui lòng kiểm tra server.");
        } else {
            console.error("Lỗi Polling Lab:", err);
        }
    }
}

/**
 * Tải mô hình và đặt vào vị trí lưới (Grid) trên bàn
 */
function normalizeToolText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function toolSearchText(tool = {}, model = null) {
    return normalizeToolText([
        tool.name_tool_vi,
        tool.name_tool_en,
        tool.name_vi,
        tool.name_en,
        tool.tool_type,
        model?.userData?.toolType,
        model?.name
    ].filter(Boolean).join(' '));
}

function isFlatHeatingTool(tool, model) {
    const text = toolSearchText(tool, model);
    return /(hot plate|heating plate|bep|bep dien|bep gia nhiet|bep dun|heater plate)/.test(text);
}

function isNaturallyHorizontalTool(tool, model) {
    const text = toolSearchText(tool, model);
    return /(petri|dia petri|watch glass|mat kinh dong ho|tray|khay|plate|stirring rod|glass rod|dua thuy tinh|pipette|ong hut)/.test(text);
}

function shouldAutoUprightModel(tool, model) {
    const toolType = model?.userData?.toolType || tool?.tool_type || 'unknown';
    if (toolType === 'heating_source' && isFlatHeatingTool(tool, model)) return false;
    if (isNaturallyHorizontalTool(tool, model)) return false;
    if (['container', 'support_stand', 'heating_source'].includes(toolType)) return true;

    return true;
}

function measureModelWithRotation(model, baseRotation, offset, label) {
    model.rotation.copy(baseRotation);
    if (offset.x) model.rotateX(offset.x);
    if (offset.y) model.rotateY(offset.y);
    if (offset.z) model.rotateZ(offset.z);
    model.updateMatrixWorld(true);

    const box = new three.Box3().setFromObject(model);
    const size = box.getSize(new three.Vector3());
    return { label, offset, size };
}

function applyAutoUprightOrientation(model, tool) {
    if (!shouldAutoUprightModel(tool, model)) return false;

    const baseRotation = model.rotation.clone();
    const candidates = [
        { label: 'identity', offset: { x: 0, y: 0, z: 0 } },
        { label: 'rotate_x_90', offset: { x: Math.PI / 2, y: 0, z: 0 } },
        { label: 'rotate_x_-90', offset: { x: -Math.PI / 2, y: 0, z: 0 } },
        { label: 'rotate_z_90', offset: { x: 0, y: 0, z: Math.PI / 2 } },
        { label: 'rotate_z_-90', offset: { x: 0, y: 0, z: -Math.PI / 2 } }
    ].map(candidate => measureModelWithRotation(model, baseRotation, candidate.offset, candidate.label));

    const identity = candidates[0];
    const best = candidates.reduce((selected, candidate) => (
        candidate.size.y > selected.size.y ? candidate : selected
    ), identity);

    const shouldApply = (
        best.label !== 'identity' &&
        best.size.y > identity.size.y * 1.08
    );

    if (shouldApply) {
        model.rotation.copy(baseRotation);
        if (best.offset.x) model.rotateX(best.offset.x);
        if (best.offset.y) model.rotateY(best.offset.y);
        if (best.offset.z) model.rotateZ(best.offset.z);
        model.userData.autoUprightApplied = best.label;
        model.updateMatrixWorld(true);
        console.log('[ModelOrientation] auto upright:', tool.name_tool_vi || tool.name_tool_en, best.label);
        return true;
    }

    model.rotation.copy(baseRotation);
    model.updateMatrixWorld(true);
    return false;
}


function getPersistedToolRotation(tool = {}) {
    const rx = Number(tool.rotation_x);
    const ry = Number(tool.rotation_y);
    const rz = Number(tool.rotation_z);
    const hasRotationColumns = [tool.rotation_x, tool.rotation_y, tool.rotation_z]
        .every(value => value !== undefined && value !== null);
    const hasPersistedRotation = hasRotationColumns && [rx, ry, rz]
        .every(Number.isFinite) && [rx, ry, rz].some(value => Math.abs(value) > 1e-6);

    return hasPersistedRotation ? new three.Euler(rx, ry, rz, 'YXZ') : null;
}

function getPersistedToolScale(tool = {}, fallbackScale = 1) {
    const sx = Number(tool.scale_x);
    const sy = Number(tool.scale_y);
    const sz = Number(tool.scale_z);
    const values = [sx, sy, sz];
    const hasScaleColumns = [tool.scale_x, tool.scale_y, tool.scale_z].every(value => value !== undefined && value !== null);
    const hasCustomScale = tool.has_custom_scale === true ||
        tool.has_custom_scale === 1 ||
        String(tool.has_custom_scale).toLowerCase() === 'true';
    const differsFromDbDefault = values.some(value => Math.abs(value - 1) > 1e-6);

    if (hasScaleColumns && values.every(Number.isFinite) && (hasCustomScale || differsFromDbDefault)) {
        return new three.Vector3(sx, sy, sz);
    }

    return new three.Vector3(fallbackScale, fallbackScale, fallbackScale);
}

export function loadAndPlaceModel(scene, tool, displayIndex, instanceId) {
    if (!tool.model_3d_url) return;

    // Chuẩn hóa URL
    const modelUrl = tool.model_3d_url.startsWith('http') 
        ? tool.model_3d_url 
        : `${API_URL}${tool.model_3d_url}`;

    loader.load(modelUrl, async (gltf) => {
        const model = gltf.scene;
        applyToolMetadataToObject(model, tool);

        // Áp dụng các tính chất vật lý (Kính, Kim loại, Nhám...)
        applyAdvancedPBR(model, tool);

        // Tự động Scale về kích thước chuẩn 0.6 đơn vị
        // 1. Đặt scale về 1 để tính toán kích thước thực thực tế của Model
        model.scale.set(1, 1, 1);
        applyAutoUprightOrientation(model, tool);
        const persistedRotation = getPersistedToolRotation(tool);
        if (persistedRotation) {
            model.rotation.copy(persistedRotation);
            model.userData.keepManualRotation = true;
            model.userData.manualRotationDirty = true;
        }
        model.updateMatrixWorld(true);

        const box = new three.Box3().setFromObject(model);
        const size = box.getSize(new three.Vector3());
        const center = new three.Vector3();
        box.getCenter(center);

        // 2. Tính toán tỉ lệ scale để đạt kích thước 0.6 đơn vị
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scaleFactor = 0.6 / maxDim;
        const targetScale = getPersistedToolScale(tool, scaleFactor);

        // 3. Tính toán vị trí Grid (vẫn dùng center để căn giữa X, Z)
        const spacing = 0.9;
        const col = displayIndex % 8;
        const row = Math.floor(displayIndex / 8);
        const spawnX = (col * spacing) - 3.2 - (center.x * targetScale.x);
        const spawnZ = (row * spacing) - 1.2 - (center.z * targetScale.z);

        // 4. Tính toán offsetToFloor dựa trên tỉ lệ scale
        // lowestPoint là y thấp nhất của box khi scale là 1
        const lowestPoint = box.min.y;
        const naturalOffset = model.position.y - lowestPoint;
        const offsetToFloor = naturalOffset * targetScale.y;
        const spawnY = 1.6 + offsetToFloor;

        model.scale.copy(targetScale);
        model.position.set(spawnX, spawnY, spawnZ);
        
        // Lưu metadata chuẩn
        model.userData.instanceId = instanceId;
        model.userData.toolData = tool;
        model.userData.toolType = model.userData.toolType || 'unknown';
        if (model.userData.toolType === 'support_stand' || model.userData.isSupportStand === true) {
            model.userData.toolType = 'support_stand';
            model.userData.isSupportStand = true;
            model.userData.canSupportTools = true;
            model.userData.isHeatingSource = false;
            model.userData.heatingPower = 0;
            model.userData.maxTemperature = 25;
            model.userData.isToggleable = false;
            model.userData.isOn = false;
        }
        model.userData.isHeatingSource = model.userData.isHeatingSource === true;
        model.userData.heatingPower = model.userData.isHeatingSource ? (Number(model.userData.heatingPower || 8) || 8) : 0;
        model.userData.maxTemperature = model.userData.isHeatingSource ? (Number(model.userData.maxTemperature || 120) || 120) : 25;
        model.userData.isToggleable = model.userData.isToggleable === true;
        model.userData.isSupportStand = model.userData.isSupportStand === true;
        model.userData.canSupportTools = model.userData.canSupportTools === true;
        model.userData.supportHeight = Number(model.userData.supportHeight || 0.8) || 0.8;
        model.userData.supportRadius = Number(model.userData.supportRadius || 1.0) || 1.0;
        model.userData.isOn = Boolean(model.userData.isOn && model.userData.isHeatingSource && model.userData.isToggleable);
        if (model.userData.toolType === 'container') {
            model.userData.currentTemperature ??= 25;
            model.userData.temperature ??= model.userData.currentTemperature;
            model.userData.isHeating = false;
            model.userData.heatingSource = null;
            model.userData.isOnSupportStand = false;
            model.userData.supportStand = null;
            model.userData.isSnappedToSupport = false;
            model.userData.pendingReaction = null;
            model.userData.pendingReason = null;
        }
        model.userData.originalScale = scaleFactor;
        model.userData.baseScale = new three.Vector3(scaleFactor, scaleFactor, scaleFactor);
        model.userData.customScale = targetScale.clone();
        model.userData.hasCustomScale = true;
        model.userData.offsetToFloor = offsetToFloor;

        if (model.userData.toolType === 'container') {
            await buildContainerCavityCSG(model, {
                innerScale: [0.9, 0.95, 0.9]
            });
        }

        // Cho phép kéo thả nếu đã đăng ký module Draggable
        if (globalRegisterDraggable) {
            globalRegisterDraggable(model);
        }
        window.heatingManager?.registerObject?.(model);
        window.labAssemblyManager?.registerObject?.(model);

        // Hiệu ứng Scale-up khi xuất hiện
        animateScale(model, targetScale);

        scene.add(model);
        loaderModels.set(instanceId, model);

        currentlyLoading.delete(instanceId);
        updateUI(tool, instanceId);
        
    }, undefined, (error) => {
        console.error("Lỗi tải mô hình 3D:", error);
        currentlyLoading.delete(instanceId);
    });
}

/**
 * Hiển thị danh sách dụng cụ lên bảng UI Sidebar phải
 */
function updateUI(tool, instanceId) {
    const list = document.getElementById('tool-list');
    if (!list) return;

    // Xóa dòng "Bàn trống" nếu có
    const emptyMsg = list.querySelector('.italic');
    if (emptyMsg) emptyMsg.remove();

    // Tránh trùng lặp UI cho cùng 1 instance
    if (document.getElementById(`ui-${instanceId}`)) return;

    const li = document.createElement('li');
    li.id = `ui-${instanceId}`;
    li.className = "flex items-center p-3 bg-white/5 rounded-xl border border-white/10 text-white animate-fade-in mb-2";
    li.innerHTML = `
        <div class="w-2 h-2 rounded-full bg-green-500 mr-3 shadow-[0_0_8px_#22c55e]"></div>
        <div class="flex flex-col">
            <span class="text-xs font-bold">${tool.name_tool_vi}</span>
            <span class="text-[9px] text-gray-400 uppercase tracking-tighter">Sẵn sàng</span>
        </div>
    `;
    list.appendChild(li);
}
