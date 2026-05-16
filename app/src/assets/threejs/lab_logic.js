import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { autoScaleModel, animateScale } from './utils.js';
import { applyAdvancedPBR } from './pbr.js';

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

    // SỬA LỖI 422: Nếu không có ID hợp lệ, không thực hiện gọi API
    if (!id_conv || id_conv === "null" || id_conv === "undefined") {
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
        const res = await fetch(`${API_URL}/api/lab/status?id_conv=${id_conv}`);
        
        if (res.status === 422) {
            console.warn("Backend báo lỗi 422: ID hội thoại không đúng định dạng.");
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
export function loadAndPlaceModel(scene, tool, displayIndex, instanceId) {
    if (!tool.model_3d_url) return;

    // Chuẩn hóa URL
    const modelUrl = tool.model_3d_url.startsWith('http') 
        ? tool.model_3d_url 
        : `${API_URL}${tool.model_3d_url}`;

    loader.load(modelUrl, (gltf) => {
        const model = gltf.scene;

        // Áp dụng các tính chất vật lý (Kính, Kim loại, Nhám...)
        applyAdvancedPBR(model, tool);

        // Tự động Scale về kích thước chuẩn 0.6 đơn vị
        // 1. Đặt scale về 1 để tính toán kích thước thực thực tế của Model
        model.scale.set(1, 1, 1);
        model.updateMatrixWorld(true);

        const box = new three.Box3().setFromObject(model);
        const size = box.getSize(new three.Vector3());
        const center = new three.Vector3();
        box.getCenter(center);

        // 2. Tính toán tỉ lệ scale để đạt kích thước 0.6 đơn vị
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scaleFactor = 0.6 / maxDim;

        // 3. Tính toán vị trí Grid (vẫn dùng center để căn giữa X, Z)
        const spacing = 0.9;
        const col = displayIndex % 8;
        const row = Math.floor(displayIndex / 8);
        const spawnX = (col * spacing) - 3.2 - (center.x * scaleFactor);
        const spawnZ = (row * spacing) - 1.2 - (center.z * scaleFactor);

        // 4. Tính toán offsetToFloor dựa trên tỉ lệ scale
        // lowestPoint là y thấp nhất của box khi scale là 1
        const lowestPoint = box.min.y;
        const naturalOffset = model.position.y - lowestPoint;
        const offsetToFloor = naturalOffset * scaleFactor;
        const spawnY = 1.6 + offsetToFloor;

        model.scale.set(scaleFactor, scaleFactor, scaleFactor);
        model.position.set(spawnX, spawnY, spawnZ);
        
        // Lưu metadata chuẩn
        model.userData.instanceId = instanceId;
        model.userData.toolData = tool;
        model.userData.originalScale = scaleFactor;
        model.userData.offsetToFloor = offsetToFloor;

        // Cho phép kéo thả nếu đã đăng ký module Draggable
        if (globalRegisterDraggable) {
            globalRegisterDraggable(model);
        }

        // Hiệu ứng Scale-up khi xuất hiện
        animateScale(model, scaleFactor);

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