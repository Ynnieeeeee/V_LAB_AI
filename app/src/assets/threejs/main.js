import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { camera, cameraGroup, updateCameraAspect } from './camera.js';
import { initControls } from './controls.js?v=20260525-bottle-display-scale';
import { registerDraggableObject, initInteractionEvents, updateArmsAnimation, draggableObjects } from './interaction.js?v=20260525-bottle-display-scale';
import { initChatEvents } from '../js/chatEvents.js?v=20260525-bottle-display-scale';
import { initLabLogic } from './lab_logic.js?v=20260525-bottle-display-scale';
import { initLights } from './lights.js';
import { initEnvironment } from './environment.js';
import { initMascot, updateMascot } from './mascot.js';
import { setupChemicalCabinet } from './cabinetChemical.js?v=20260525-bottle-display-scale';
import { pouringEffect, pouringState } from './interaction.js?v=20260525-bottle-display-scale';
import { createHeatingManager } from './HeatingManager.js';
import { createLabAssemblyManager } from './LabAssemblyManager.js';

const scene = new three.Scene();
scene.background = new three.Color(0x0f172a);

const renderer = new three.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = three.PCFSoftShadowMap;
renderer.toneMapping = three.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = three.SRGBColorSpace;

// VR Setup
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// --- CẤU HÌNH POST-PROCESSING ---
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(new three.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.4, 0.85);
composer.addPass(bloomPass);

const MetaballShader = {
    uniforms: {
        "tDiffuse": { value: null },
        "threshold": { value: 0.02 }, // Ngưỡng cực thấp để bắt được cả tia nước nhỏ nhất
        "smoothness": { value: 0.05 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float threshold;
        uniform float smoothness;
        varying vec2 vUv;
        void main() {
            vec4 texel = texture2D(tDiffuse, vUv);
            float brightness = max(texel.r, max(texel.g, texel.b));
            
            // Ngưỡng thấp hơn để thấy được các hạt đơn lẻ trước khi chúng dính vào nhau
            if (brightness > threshold) {
                float alpha = smoothstep(threshold, threshold + smoothness, brightness);
                // Làm sáng khối chất lỏng để trông nổi bật hơn
                gl_FragColor = vec4(texel.rgb * 1.5, texel.a);
            } else {
                gl_FragColor = texel;
            }
        }
    `
};

const metaballPass = new ShaderPass(MetaballShader);
composer.addPass(metaballPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

scene.add(cameraGroup);
const controlsManager = initControls(camera, renderer.domElement, cameraGroup);
initInteractionEvents(camera, controlsManager, scene);
initLights(scene, renderer);
initEnvironment(scene);
initMascot(scene, camera);
const heatingManager = createHeatingManager(scene, { getObjects: () => draggableObjects });
window.heatingManager = heatingManager;
const labAssemblyManager = createLabAssemblyManager(scene, { getObjects: () => draggableObjects });
window.labAssemblyManager = labAssemblyManager;

const loader = new GLTFLoader();
const modelPath = './assets/models/';
let chemicalCabinet = null;
const frameClock = new three.Clock();

export async function loadChemistryCabinet() {
    if (chemicalCabinet) {
        chemicalCabinet.visible = true;
        return;
    }
    try {
        const bookcaseGltf = await loader.loadAsync(`${modelPath}bookcase.glb`);
        chemicalCabinet = bookcaseGltf.scene;
        chemicalCabinet.position.set(0, 0, -9.8);
        chemicalCabinet.rotation.y = -Math.PI / 2;
        chemicalCabinet.scale.set(2.0, 2.0, 2.0);
        scene.add(chemicalCabinet);

        const bottleGltf = await loader.loadAsync(`${modelPath}chemical_bottle_1778830207.glb`);
        const bottleBase = bottleGltf.scene;
        await setupChemicalCabinet(scene, bottleBase, chemicalCabinet);
    } catch (error) {
        console.error("Lỗi khi nạp tủ hóa chất:", error);
    }
}

export function hideChemistryCabinet() {
    if (chemicalCabinet) {
        chemicalCabinet.visible = false;
    }
}

window.loadChemistryCabinet = loadChemistryCabinet;
window.hideChemistryCabinet = hideChemistryCabinet;

async function loadLaboratoryModels() {
    try {
    } catch (error) {
        console.error("Lỗi khi nạp mô hình phòng Lab:", error);
    }
}
loadLaboratoryModels();

function animate() {
    renderer.setAnimationLoop(() => {
        const delta = Math.min(0.05, frameClock.getDelta());
        if (controlsManager.orbit.enabled) controlsManager.orbit.update();
        const isMoving = controlsManager.updateMovement();
        if (controlsManager.fps.isLocked) updateArmsAnimation(performance.now() / 1000, isMoving);
        updateMascot();
        labAssemblyManager.syncObjects();
        heatingManager.update(delta);
        if (window.checkPouringCollision) window.checkPouringCollision();
        if (pouringEffect) pouringEffect.update(pouringState.currentPourTargetPos);
        composer.render();
    });
}

window.addEventListener('resize', () => {
    updateCameraAspect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    composer.setSize(width, height);
});

const fpsBtn = document.getElementById('fpsBtn');
if (fpsBtn) {
    fpsBtn.addEventListener('click', () => {
        controlsManager.fps.lock();
    });
}

animate();
initChatEvents();
initLabLogic(scene, registerDraggableObject);

