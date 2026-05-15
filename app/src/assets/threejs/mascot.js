// assets/threejs/mascot.js (Updated with Speech Logic)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let mascotModel;
let speechTimeout;

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

// Lắng nghe sự kiện đổi giọng đọc (một số trình duyệt tải giọng đọc chậm)
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        getVietnameseVoice();
    };
}

/**
 * Hàm mới: Giúp Mascot nói chuyện
 * @param {string} text - Nội dung Mascot sẽ nói
 */
export function triggerMascotSpeech(text) {
    const mascotDialog = document.getElementById('mascot-dialog');
    const speechContent = document.getElementById('mascot-text');

    // 1. LUÔN HIỂN THỊ VĂN BẢN (Không còn tự động ẩn)
    if (mascotDialog && speechContent) {
        clearTimeout(speechTimeout);
        speechContent.innerText = text;
        mascotDialog.style.display = 'block';
        mascotDialog.style.opacity = '1';
        mascotDialog.classList.remove('hidden');
    }

    // 2. XỬ LÝ ÂM THANH
    try {
        // Ưu tiên SpeechSynthesis nếu có giọng Việt
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const voices = window.speechSynthesis.getVoices();
            const viVoice = voices.find(v => v.lang.startsWith('vi') || v.name.toLowerCase().includes('vietnamese'));

            if (viVoice) {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'vi-VN';
                utterance.voice = viVoice;
                utterance.rate = 0.9;
                window.speechSynthesis.speak(utterance);
                return; // Đã xong nếu dùng được giọng nội bộ
            }
        }

        // PHƯƠNG ÁN DỰ PHÒNG: Dùng Google TTS Online với xử lý lỗi tốt hơn
        console.log("Đang gọi Google TTS...");
        const googleTTSUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=vi&client=tw-ob`;
        
        // Tạo hoặc dùng lại đối tượng Audio
        if (!window.mascotAudio) {
            window.mascotAudio = new Audio();
        }
        
        window.mascotAudio.src = googleTTSUrl;
        window.mascotAudio.play().catch(e => {
            console.warn("Âm thanh bị trình duyệt chặn. Hãy click vào màn hình để cho phép phát âm thanh.", e);
            // Nếu bị chặn, thử phát lại khi người dùng click
            const enableAudio = () => {
                window.mascotAudio.play();
                window.removeEventListener('click', enableAudio);
            };
            window.addEventListener('click', enableAudio);
        });
    } catch (err) {
        console.error("Lỗi hệ thống âm thanh:", err);
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