// assets/threejs/mascot.js (Updated with Speech Logic)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let mascotModel;
let speechTimeout;
let lastSpeakTime = 0;

export function initMascot(scene, camera) {
    const loader = new GLTFLoader();

    loader.load('./assets/models/mascot.glb', (gltf) => {
        mascotModel = gltf.scene;

        // 1. CHỈNH SCALE
        mascotModel.scale.set(0.12, 0.12, 0.12);

        camera.add(mascotModel);

        // 2. VỊ TRÍ: Sang trái và Giữa màn hình theo chiều dọc
        mascotModel.position.set(0.73, 0, -1.8);

        // 3. XOAY MẶT VỀ CAMERA
        mascotModel.rotation.y = 0.2;

        console.log("Mascot đã được tải với kích thước và vị trí mới!");
    }, undefined, (error) => {
        console.error("Lỗi tải model Mascot:", error);
    });
}

/**
 * Hàm hỗ trợ tìm giọng đọc tiếng Việt
 */
function getVietnameseVoice() {
    let voices = window.speechSynthesis.getVoices();
    // Ưu tiên các giọng có chữ "Vietnamese" hoặc code "vi"
    let voice = voices.find(v => v.lang.includes('vi') || v.name.toLowerCase().includes('vietnamese'));
    return voice;
}

// Lắng nghe sự kiện đổi giọng đọc
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        getVietnameseVoice();
    };
}

/**
 * Hàm Giúp Mascot nói chuyện
 * @param {string} text - Nội dung Mascot sẽ nói
 */
export function triggerMascotSpeech(text) {
    const mascotDialog = document.getElementById('mascot-dialog');
    const speechContent = document.getElementById('mascot-text');

    // 1. LUÔN HIỂN THỊ VĂN BẢN
    if (mascotDialog && speechContent) {
        clearTimeout(speechTimeout);
        speechContent.innerText = text;
        mascotDialog.style.display = 'block';
        mascotDialog.style.opacity = '1';
        mascotDialog.classList.remove('hidden');
    }

    // 2. GIỚI HẠN THỜI GIAN COOLDOWN ĐỂ TRÁNH SPAM ÂM THANH
    const now = performance.now();
    if (now - lastSpeakTime < 2500) {
        return;
    }
    lastSpeakTime = now;

    // 3. XỬ LÝ ÂM THANH BẰNG WEB SPEECH API (KHÔNG BỊ CORS)
    try {
        if ('speechSynthesis' in window) {
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = 'vi-VN';
            utter.rate = 1;
            utter.pitch = 1;

            const voices = window.speechSynthesis.getVoices();
            const viVoice = voices.find(v => v.lang.startsWith('vi') || v.name.toLowerCase().includes('vietnamese'));
            if (viVoice) {
                utter.voice = viVoice;
            }

            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utter);
        }
    } catch (err) {
        console.error("Lỗi hệ thống âm thanh Web Speech:", err);
    }
}

// Gắn vào window để mascotTalk.js có thể dùng
window.triggerMascotSpeech = triggerMascotSpeech;

export function updateMascot() {
    if (mascotModel) {
        const time = Date.now() * 0.002;
        const floatOffset = Math.sin(time) * 0.03;

        // Hiệu ứng lơ lửng nhẹ cho 3D model
        mascotModel.position.y = 0 + floatOffset;
        // mascotModel.rotation.y = Math.sin(time * 0.5) * 0.05;

        // Cập nhật vị trí cho HTML dialog để "đi theo" Mascot
        const mascotDialog = document.getElementById('mascot-dialog');
        if (mascotDialog && mascotDialog.style.display !== 'none') {
            const pixelOffset = floatOffset * 300; 
            mascotDialog.style.transform = `translateY(${-pixelOffset}px)`;
        }
    }
}