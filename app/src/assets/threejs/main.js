import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { camera, cameraGroup, updateCameraAspect } from './camera.js';
import { initControls } from './controls.js?v=20260618-xr-sprite-ray1';
import { registerDraggableObject, initInteractionEvents, updateArmsAnimation, draggableObjects } from './interaction.js?v=20260618-xr-sprite-ray1';
import { initChatEvents } from '../js/chatEvents.js?v=20260527-liquid-soft-waves';
import { initLabLogic } from './lab_logic.js?v=20260609-network-topology';
import { initLights } from './lights.js';
import { initEnvironment } from './environment.js';
import './labNotifier.js';
import { setupChemicalCabinet } from './cabinetChemical.js?v=20260618-xr-sprite-ray1';
import { pouringEffect, pouringState } from './interaction.js?v=20260618-xr-sprite-ray1';
import { createHeatingManager } from './HeatingManager.js';
import { createLabAssemblyManager } from './LabAssemblyManager.js?v=20260609-network-topology';
import { createAssemblyGraphManager } from './AssemblyGraphManager.js?v=20260609-network-topology';

const scene = new three.Scene();
scene.background = new three.Color(0x0f172a);
window.scene = scene;

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
const vrButton = VRButton.createButton(renderer);
const vrButtonSlot = document.getElementById('vrButtonSlot');

Object.assign(vrButton.style, {
    position: 'static',
    bottom: 'auto',
    left: 'auto',
    transform: 'none',
    width: 'auto',
    minWidth: '112px',
    height: 'auto',
    margin: '0',
    padding: '0.5rem 1.5rem',
    borderRadius: '1rem',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#ffffff',
    fontFamily: 'inherit',
    fontSize: '14px',
    fontWeight: '700',
    lineHeight: '20px',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.45)',
    backdropFilter: 'blur(12px)',
    cursor: 'pointer'
});

vrButton.addEventListener('mouseenter', () => {
    vrButton.style.background = '#2563eb';
});
vrButton.addEventListener('mouseleave', () => {
    vrButton.style.background = 'rgba(255, 255, 255, 0.1)';
});

(vrButtonSlot || document.body).appendChild(vrButton);

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
const xrControllerSlots = [renderer.xr.getController(0), renderer.xr.getController(1)];
const xrControllerGripSlots = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
const xrReticle = createXRControllerReticle(scene, xrControllerSlots);
controlsManager.xrControllerAimTargets = xrReticle.aimTargets;

xrControllerSlots.forEach((controller, index) => {
    const grip = xrControllerGripSlots[index];

    controller.name = `XR Controller Slot ${index + 1}`;
    controller.userData.slot = index;
    controller.userData.grip = grip;

    if (grip) {
        grip.name = `XR Controller Grip Slot ${index + 1}`;
        grip.userData.slot = index;
        grip.userData.targetRay = controller;
        cameraGroup.add(grip);
    }

    controller.addEventListener('connected', (event) => {
        controlsManager.connectXRController(controller, event.data);
    });
    controller.addEventListener('disconnected', () => {
        controlsManager.disconnectXRController(controller);
    });
    cameraGroup.add(controller);
});
controlsManager.xrControllerSlots = xrControllerSlots;
controlsManager.xrControllerGripSlots = xrControllerGripSlots;
controlsManager.getXRCamera = () => renderer.xr.getCamera(camera);
controlsManager.getXRSession = () => renderer.xr.getSession();
controlsManager.isXRPresenting = () => renderer.xr.isPresenting || Boolean(renderer.xr.getSession());

initInteractionEvents(camera, controlsManager, scene);
initLights(scene, renderer);
initEnvironment(scene);
const heatingManager = createHeatingManager(scene, { getObjects: () => draggableObjects });
window.heatingManager = heatingManager;
const labAssemblyManager = createLabAssemblyManager(scene, { getObjects: () => draggableObjects });
window.labAssemblyManager = labAssemblyManager;
const assemblyGraphManager = createAssemblyGraphManager(scene, { getObjects: () => draggableObjects });
window.assemblyGraphManager = assemblyGraphManager;

const loader = new GLTFLoader();
const modelPath = '/assets/models/';
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

function createXRControllerReticle(scene, controllers) {
    const root = new three.Group();
    root.name = 'XR Controller Reticles';
    root.visible = false;
    root.userData.ignoreRaycast = true;
    scene.add(root);

    const outlineMaterial = new three.MeshBasicMaterial({
        color: 0x020617,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false
    });
    const dotMaterial = new three.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false
    });

    const makeDot = (name) => {
        const group = new three.Group();
        group.name = name;
        group.visible = false;
        group.userData.ignoreRaycast = true;

        const outline = new three.Mesh(new three.SphereGeometry(0.045, 16, 16), outlineMaterial);
        const dot = new three.Mesh(new three.SphereGeometry(0.027, 16, 16), dotMaterial);
        outline.renderOrder = 10000;
        dot.renderOrder = 10001;
        group.add(outline, dot);
        root.add(group);
        return group;
    };

    const markers = controllers.map((_, index) => makeDot(`XR Controller Dot ${index + 1}`));
    const raycaster = new three.Raycaster();
    const aimTargets = new Map();
    const origin = new three.Vector3();
    const direction = new three.Vector3();
    const fallbackDistance = 1.8;
    const maxDistance = 8;

    return {
        object: root,
        aimTargets,
        update(isPresenting) {
            root.visible = isPresenting;
            if (!isPresenting) {
                markers.forEach(marker => marker.visible = false);
                aimTargets.clear();
                return;
            }

            controllers.forEach((controller, index) => {
                const marker = markers[index];
                const hasInput = Boolean(controller?.userData?.inputSource);

                if (!controller || !hasInput) {
                    marker.visible = false;
                    if (controller) aimTargets.set(controller, null);
                    return;
                }

                controller.updateMatrixWorld(true);
                controller.getWorldPosition(origin);
                direction.set(0, 0, -1).transformDirection(controller.matrixWorld).normalize();

                raycaster.ray.origin.copy(origin);
                raycaster.ray.direction.copy(direction);
                raycaster.near = 0.02;
                raycaster.far = maxDistance;
                const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : null;
                raycaster.camera = xrCamera?.isArrayCamera ? xrCamera.cameras?.[0] || camera : xrCamera || camera;

                const hits = raycaster.intersectObjects(draggableObjects, true);
                const hit = hits.find(item => item.object?.userData?.root || item.object?.userData?.isInteractable);
                const distance = hit ? Math.max(hit.distance - 0.02, 0.08) : fallbackDistance;
                aimTargets.set(controller, hit?.object || null);

                marker.visible = true;
                marker.position.copy(origin).addScaledVector(direction, distance);
                marker.scale.setScalar(hit ? 1.35 : 1);
            });
        }
    };
}

function animate() {
    renderer.setAnimationLoop(() => {
        const delta = Math.min(0.05, frameClock.getDelta());
        const isXRPresenting = controlsManager.isXRPresenting();
        controlsManager.updateXRPresentationState(isXRPresenting);
        xrReticle.update(isXRPresenting);
        if (!isXRPresenting && controlsManager.orbit.enabled) controlsManager.orbit.update();
        let isMoving = controlsManager.updateMovement();
        controlsManager.updateXRPressButtons?.();
        if (isXRPresenting) {
            isMoving = controlsManager.updateXRMovement(delta) || isMoving;
            controlsManager.updateXRHeldToolRotation?.(delta);
        }
        if (controlsManager.fps.isLocked || isXRPresenting) updateArmsAnimation(performance.now() / 1000, isMoving);
        labAssemblyManager.syncObjects();
        assemblyGraphManager.syncObjects();
        assemblyGraphManager.update(delta);
        heatingManager.update(delta);
        if (window.checkPouringCollision) window.checkPouringCollision();
        if (pouringEffect) pouringEffect.update(pouringState.currentPourTargetPos);
        if (isXRPresenting) {
            renderer.render(scene, camera);
        } else {
            composer.render();
        }
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

