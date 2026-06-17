// assets/threejs/mascot.js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let mascotModel;
const MAX_MASCOT_MESSAGES = 8;
const MASCOT_SCALE = 0.095;
const MASCOT_BASE_POSITION = { x: 0.6, y: 0.0, z: -1.9 };
const MASCOT_FLOAT_AMPLITUDE = 0.018;

export function initMascot(scene, camera) {
    ensureMascotPanel();

    const loader = new GLTFLoader();
    loader.load('/assets/models/mascot.glb', (gltf) => {
        mascotModel = gltf.scene;
        mascotModel.scale.set(MASCOT_SCALE, MASCOT_SCALE, MASCOT_SCALE);
        camera.add(mascotModel);
        mascotModel.position.set(MASCOT_BASE_POSITION.x, MASCOT_BASE_POSITION.y, MASCOT_BASE_POSITION.z);
        mascotModel.rotation.y = -0.2;
        console.log('Mascot loaded.');
    }, undefined, (error) => {
        console.error('Mascot model load error:', error);
    });
}

function ensureMascotPanel() {
    const mascotContainer = document.getElementById('mascot-container');
    const mascotDialog = document.getElementById('mascot-dialog');
    const speechContent = document.getElementById('mascot-text');

    if (mascotContainer) {
        mascotContainer.classList.remove('hidden');
        mascotContainer.style.display = 'flex';
        mascotContainer.style.opacity = '1';
        mascotContainer.style.visibility = 'visible';
        mascotContainer.style.pointerEvents = 'none';
    }

    if (mascotDialog) {
        mascotDialog.classList.remove('hidden');
        mascotDialog.style.display = 'block';
        mascotDialog.style.opacity = '1';
        mascotDialog.style.visibility = 'visible';
        mascotDialog.style.pointerEvents = 'auto';
    }

    if (mascotDialog && !document.getElementById('mascot-history')) {
        const history = document.createElement('div');
        history.id = 'mascot-history';
        history.className = 'mascot-history';
        if (speechContent?.parentElement) {
            speechContent.parentElement.insertBefore(history, speechContent);
        } else {
            mascotDialog.prepend(history);
        }
    }

    return {
        container: mascotContainer,
        dialog: mascotDialog,
        text: speechContent,
        history: document.getElementById('mascot-history')
    };
}

function appendMascotHistory(text) {
    const { history } = ensureMascotPanel();
    if (!history) return;

    const last = history.lastElementChild;
    if (last && last.textContent === text) {
        history.scrollTop = history.scrollHeight;
        return;
    }

    const item = document.createElement('div');
    item.className = 'mascot-history-item';
    item.textContent = text;
    history.appendChild(item);

    while (history.children.length > MAX_MASCOT_MESSAGES) {
        history.firstElementChild?.remove();
    }
    history.scrollTop = history.scrollHeight;
}

// Public API name is preserved for reaction code compatibility.
// This only updates text in the fixed panel. It never plays audio and never hides the panel.
export function triggerMascotSpeech(text) {
    const rawText = String(text || '').trim();
    if (!rawText) return;

    const { dialog, text: speechContent } = ensureMascotPanel();
    if (speechContent) {
        speechContent.innerText = rawText;
        appendMascotHistory(rawText);
    }
    if (dialog) {
        dialog.scrollTop = dialog.scrollHeight;
    }
}

window.triggerMascotSpeech = triggerMascotSpeech;
window.ensureMascotPanel = ensureMascotPanel;

export function updateMascot() {
    if (!mascotModel) return;
    const time = Date.now() * 0.002;
    const floatOffset = Math.sin(time) * MASCOT_FLOAT_AMPLITUDE;
    mascotModel.position.y = MASCOT_BASE_POSITION.y + floatOffset;
}

document.addEventListener('DOMContentLoaded', ensureMascotPanel);
