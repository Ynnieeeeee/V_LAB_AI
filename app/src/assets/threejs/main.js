import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { camera, cameraGroup, updateCameraAspect } from './camera.js';
import { initControls } from './controls.js';
import { registerDraggableObject, initInteractionEvents, updateArmsAnimation } from './interaction.js';
import { initChatEvents } from '../js/chatEvents.js';
import { initLabLogic } from './lab_logic.js';
import { initLights } from './lights.js';
import { initEnvironment } from './environment.js';
import { initMascot, updateMascot } from './mascot.js';
import { setupChemicalCabinet } from './cabinetChemical.js';
import { pouringEffect, currentPourTargetPos } from './interaction.js';

const scene = new three.Scene();
scene.background = new three.Color(0x0f172a);

const renderer = new three.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = three.PCFSoftShadowMap;

// Realistic Rendering Settings
renderer.toneMapping = three.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = three.SRGBColorSpace;

// VR Setup
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// Thêm player rig (Chứa camera và tay) vào scene
scene.add(cameraGroup);

// Khởi tạo các hệ thống cơ bản
const controlsManager = initControls(camera, renderer.domElement, cameraGroup);
initInteractionEvents(camera, controlsManager, scene);
initLights(scene, renderer);
initEnvironment(scene);
initMascot(scene, camera);

// --- LOGIC TẢI MÔ HÌNH & TỦ HÓA CHẤT ---
const loader = new GLTFLoader();
const modelPath = './assets/models/';

// Biến lưu trữ tủ hóa chất để có thể xóa/ẩn nếu cần
let chemicalCabinet = null;

export async function loadChemistryCabinet() {
    // Nếu đã tải rồi thì không tải lại, chỉ hiện ra
    if (chemicalCabinet) {
        chemicalCabinet.visible = true;
        return;
    }

    try {
        console.log("Đang tải tủ hóa chất cho phòng thí nghiệm Hóa học...");
        // 1. Load cái tủ (Bookcase)
        const bookcaseGltf = await loader.loadAsync(`${modelPath}bookcase.glb`);
        chemicalCabinet = bookcaseGltf.scene;
        
        // Vị trí sát tường đối diện bàn thí nghiệm
        chemicalCabinet.position.set(0, 0, -9.8); 
        chemicalCabinet.rotation.y = -Math.PI / 2; 
        scene.add(chemicalCabinet);

        // 2. Load cái lọ mẫu (id_tool)
        const bottleGltf = await loader.loadAsync(`${modelPath}chemical_bottle_1778830207.glb`);
        const bottleBase = bottleGltf.scene;

        // 3. Sắp xếp hóa chất lên tủ
        await setupChemicalCabinet(scene, bottleBase, chemicalCabinet);

    } catch (error) {
        console.error("Lỗi khi nạp tủ hóa chất:", error);
    }
}

// Hàm ẩn tủ nếu chuyển sang môn khác
export function hideChemistryCabinet() {
    if (chemicalCabinet) {
        chemicalCabinet.visible = false;
    }
}

// Gán vào window để subject_logic.js có thể gọi
window.loadChemistryCabinet = loadChemistryCabinet;
window.hideChemistryCabinet = hideChemistryCabinet;

async function loadLaboratoryModels() {
    try {
        // Ở đây có thể load các mô hình chung cho mọi phòng Lab (bàn ghế, sàn nhà...)
        // Hiện tại initEnvironment(scene) đã lo phần này
    } catch (error) {
        console.error("Lỗi khi nạp mô hình phòng Lab:", error);
    }
}

// Chạy hàm tải mô hình chung
loadLaboratoryModels();

// --- VÒNG LẶP HOẠT ẢNH (ANIMATION LOOP) ---
function animate() {
    renderer.setAnimationLoop(() => {
        // 1. Cập nhật Controls
        if (controlsManager.orbit.enabled) {
            controlsManager.orbit.update();
        }

        const isMoving = controlsManager.updateMovement();

        // 2. Cập nhật hoạt ảnh tay (Bobbing & Inspecting)
        if (controlsManager.fps.isLocked) {
            updateArmsAnimation(performance.now() / 1000, isMoving);
        }

        // 3. Cập nhật Mascot & Hiệu ứng đổ
        updateMascot();
        if (window.checkPouringCollision) {
            window.checkPouringCollision();
        }
        if (pouringEffect) {
            pouringEffect.update(currentPourTargetPos); // Luôn cập nhật để hạt tiếp tục rơi dù đã ngừng đổ
        }

        // 4. Render Scene
        renderer.render(scene, camera);
    });
}

// Xử lý Resize
window.addEventListener('resize', () => {
    updateCameraAspect();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Nút khóa chuột để vào chế độ FPS
const fpsBtn = document.getElementById('fpsBtn');
if (fpsBtn) {
    fpsBtn.addEventListener('click', () => {
        controlsManager.fps.lock();
    });
}

// Khởi chạy vòng lặp
animate();

// Khởi tạo logic nghiệp vụ (Chat & Lab Logic)
initChatEvents();
initLabLogic(scene, registerDraggableObject);