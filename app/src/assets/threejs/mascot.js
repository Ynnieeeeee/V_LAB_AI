// assets/threejs/mascot.js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let mascotModel;
let speechTimeout;
let lastSpeakTime = 0;
let cachedVietnameseVoice = null;

export function initMascot(scene, camera) {
    const loader = new GLTFLoader();

    loader.load('./assets/models/mascot.glb', (gltf) => {
        mascotModel = gltf.scene;
        mascotModel.scale.set(0.12, 0.12, 0.12);
        camera.add(mascotModel);
        mascotModel.position.set(0.73, 0, -1.8);
        mascotModel.rotation.y = 0.2;
        console.log('Mascot đã được tải.');
    }, undefined, (error) => {
        console.error('Lỗi tải model Mascot:', error);
    });
}

function normalizeVietnameseText(text = '') {
    return String(text)
        .replace(/CuSO₄/g, 'Cu SO 4')
        .replace(/NaOH/g, 'Na O H')
        .replace(/Cu\(OH\)₂/g, 'Cu O H 2')
        .replace(/Na₂SO₄/g, 'Na 2 SO 4')
        .replace(/H₂O/g, 'H 2 O')
        .replace(/H₂/g, 'H 2')
        .replace(/CO₂/g, 'CO 2')
        .replace(/↓/g, ' kết tủa ')
        .replace(/→/g, ' tạo ra ')
        .trim();
}

function findVietnameseVoice() {
    if (!('speechSynthesis' in window)) return null;

    const voices = window.speechSynthesis.getVoices() || [];
    cachedVietnameseVoice =
        voices.find(v => /^vi(-|_)?VN/i.test(v.lang)) ||
        voices.find(v => /^vi/i.test(v.lang)) ||
        voices.find(v => /vietnam|tiếng việt|vietnamese/i.test(v.name)) ||
        null;

    return cachedVietnameseVoice;
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
        findVietnameseVoice();
    };
    findVietnameseVoice();
}

/**
 * Mascot chỉ nên được gọi khi có kết quả phản ứng.
 * Nội dung truyền vào nên là mascot_speech + equation.
 */
export function triggerMascotSpeech(text) {
    const mascotDialog = document.getElementById('mascot-dialog');
    const speechContent = document.getElementById('mascot-text');
    const rawText = String(text || '').trim();

    if (!rawText) return;

    if (mascotDialog && speechContent) {
        clearTimeout(speechTimeout);
        speechContent.innerText = rawText;
        mascotDialog.style.display = 'block';
        mascotDialog.style.opacity = '1';
        mascotDialog.classList.remove('hidden');

        speechTimeout = setTimeout(() => {
            mascotDialog.style.opacity = '0';
            setTimeout(() => mascotDialog.classList.add('hidden'), 250);
        }, Math.max(4500, Math.min(12000, rawText.length * 90)));
    }

    const now = performance.now();
    if (now - lastSpeakTime < 900) return;
    lastSpeakTime = now;

    try {
        if (!('speechSynthesis' in window)) return;

        const speakText = normalizeVietnameseText(rawText);
        const utter = new SpeechSynthesisUtterance(speakText);

        // Ép đọc tiếng Việt. Nếu máy không có voice vi-VN, trình duyệt vẫn cố đọc theo ngôn ngữ này.
        utter.lang = 'vi-VN';
        utter.rate = 0.92;
        utter.pitch = 1.02;
        utter.volume = 1;

        const viVoice = cachedVietnameseVoice || findVietnameseVoice();
        if (viVoice) utter.voice = viVoice;

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
    } catch (err) {
        console.error('Lỗi hệ thống âm thanh Web Speech:', err);
    }
}

window.triggerMascotSpeech = triggerMascotSpeech;

export function updateMascot() {
    if (mascotModel) {
        const time = Date.now() * 0.002;
        const floatOffset = Math.sin(time) * 0.03;

        mascotModel.position.y = 0 + floatOffset;

        const mascotDialog = document.getElementById('mascot-dialog');
        if (mascotDialog && mascotDialog.style.display !== 'none') {
            const pixelOffset = floatOffset * 300;
            mascotDialog.style.transform = `translateY(${-pixelOffset}px)`;
        }
    }
}
