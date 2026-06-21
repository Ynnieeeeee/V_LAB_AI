import * as three from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { camera, cameraGroup, updateCameraAspect } from './camera.js';
import { initControls } from './controls.js?v=20260621-xr-input-v23';
import { registerDraggableObject, initInteractionEvents, updateArmsAnimation, updateDroppedObjectFalls, draggableObjects, findOpenFloorPositionForObject, getCenterAimResultFromCamera } from './interaction.js?v=20260621-xr-input-v23';
import { initChatEvents } from '../js/chatEvents.js?v=20260621-ngrok-same-origin-v1';
import { initLabLogic } from './lab_logic.js?v=20260621-xr-input-v23';
import { initLights } from './lights.js';
import { initEnvironment, createLabTable } from './environment.js?v=20260618-add-table3';
import { notifyLab } from './labNotifier.js';
import { setupChemicalCabinet } from './cabinetChemical.js?v=20260621-xr-input-v23';
import { pouringEffect, pouringState } from './interaction.js?v=20260621-xr-input-v23';
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
controlsManager.getXRAimRay = (targetRay = null) => xrReticle.copyAimRay(targetRay);
controlsManager.getXRAimTarget = () => xrReticle.getAimTarget();

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
setupAddTableButton();
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
let movableTableCounter = 0;
const MOVABLE_TABLES_STORAGE_KEY = 'vlab_movable_tables_by_room';
let currentMovableTableRoomKey = null;
let isRestoringMovableTables = false;

function isUsableRoomId(value) {
    return Boolean(value && value !== 'null' && value !== 'undefined');
}

function getActiveMovableTableRoomKey(conversationId = window.currentConvId) {
    if (isUsableRoomId(conversationId)) return `conv:${conversationId}`;
    if (window.currentDraftRoomKey) return `draft:${window.currentDraftRoomKey}`;
    if (window.currentSubject) return `draft:${window.currentSubject}`;
    return null;
}

function readMovableTablesState() {
    try {
        return JSON.parse(localStorage.getItem(MOVABLE_TABLES_STORAGE_KEY) || '{}') || {};
    } catch (_) {
        return {};
    }
}

function writeMovableTablesState(state) {
    localStorage.setItem(MOVABLE_TABLES_STORAGE_KEY, JSON.stringify(state));
}

function getSceneMovableTables() {
    return (Array.isArray(window.labTables) ? window.labTables : [])
        .filter(table => table?.isObject3D && table.userData?.isMovableTable === true && table.userData?.isDeleted !== true);
}

function serializeMovableTable(table) {
    return {
        instanceId: table.userData?.instanceId || null,
        position: {
            x: table.position.x,
            y: table.position.y,
            z: table.position.z
        },
        rotation: {
            x: table.rotation.x,
            y: table.rotation.y,
            z: table.rotation.z
        }
    };
}

function saveMovableTablesForRoom(roomKey = currentMovableTableRoomKey) {
    if (!roomKey || isRestoringMovableTables) return;

    const state = readMovableTablesState();
    const tables = getSceneMovableTables();
    if (tables.length) {
        state[roomKey] = tables.map(serializeMovableTable);
    } else {
        delete state[roomKey];
    }
    writeMovableTablesState(state);
}

function removeMovableTableFromScene(table) {
    if (!table?.isObject3D) return;

    table.userData.isDeleted = true;

    const draggableIndex = draggableObjects.indexOf(table);
    if (draggableIndex !== -1) draggableObjects.splice(draggableIndex, 1);

    if (Array.isArray(window.labTables)) {
        const tableIndex = window.labTables.indexOf(table);
        if (tableIndex !== -1) window.labTables.splice(tableIndex, 1);
    }

    window.heatingManager?.unregisterObject?.(table);
    window.labAssemblyManager?.unregisterObject?.(table);

    if (table.parent) {
        table.parent.remove(table);
    } else {
        scene.remove(table);
    }
    disposeObjectResources(table);
}

function clearMovableTablesFromScene() {
    [...getSceneMovableTables()].forEach(removeMovableTableFromScene);
}

function restoreMovableTablesForRoom(roomKey) {
    if (!roomKey) return;

    const records = readMovableTablesState()[roomKey] || [];
    if (!records.length) return;

    isRestoringMovableTables = true;
    records.forEach((record) => {
        addMovableLabTable({
            instanceId: record.instanceId,
            position: record.position,
            rotation: record.rotation,
            notify: false,
            persist: false
        });
    });
    isRestoringMovableTables = false;
}

function switchMovableTablesToActiveRoom() {
    saveMovableTablesForRoom(currentMovableTableRoomKey);
    clearMovableTablesFromScene();
    currentMovableTableRoomKey = getActiveMovableTableRoomKey();
    restoreMovableTablesForRoom(currentMovableTableRoomKey);
}

function claimCurrentMovableTablesForRoom(conversationId) {
    const nextRoomKey = getActiveMovableTableRoomKey(conversationId);
    if (!nextRoomKey) return;

    const previousRoomKey = currentMovableTableRoomKey;
    currentMovableTableRoomKey = nextRoomKey;
    saveMovableTablesForRoom(nextRoomKey);

    if (previousRoomKey && previousRoomKey !== nextRoomKey && previousRoomKey.startsWith('draft:')) {
        const state = readMovableTablesState();
        delete state[previousRoomKey];
        writeMovableTablesState(state);
    }
    window.currentDraftRoomKey = null;
}

window.persistMovableTablesForCurrentRoom = () => {
    if (!currentMovableTableRoomKey) currentMovableTableRoomKey = getActiveMovableTableRoomKey();
    saveMovableTablesForRoom(currentMovableTableRoomKey);
};
window.claimCurrentMovableTablesForRoom = claimCurrentMovableTablesForRoom;
window.addEventListener('lab:clear', switchMovableTablesToActiveRoom);
window.addEventListener('lab:movable-tables-changed', () => window.persistMovableTablesForCurrentRoom?.());

function disposeObjectResources(object) {
    object?.traverse?.((child) => {
        child.geometry?.dispose?.();
        const material = child.material;
        if (Array.isArray(material)) {
            material.forEach(m => m?.dispose?.());
        } else {
            material?.dispose?.();
        }
    });
}

function addMovableLabTable(options = {}) {
    if (options?.target) options = {};

    const roomKey = getActiveMovableTableRoomKey();
    if (!roomKey && options.persist !== false) {
        notifyLab('H\u00e3y ch\u1ecdn ph\u00f2ng tr\u01b0\u1edbc khi th\u00eam b\u00e0n.');
        return null;
    }

    currentMovableTableRoomKey ??= roomKey;
    movableTableCounter += 1;
    const table = createLabTable({
        width: 4.2,
        depth: 2.4,
        topColor: 0x334155,
        legColor: 0x111827,
        roughness: 0.18,
        metalness: 0.25,
        isMovable: true,
        name: `Movable lab table ${movableTableCounter}`
    });

    table.userData.instanceId = options.instanceId || `movable-table-${Date.now()}-${movableTableCounter}`;
    table.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(table);
    table.userData.offsetToFloor = table.position.y - box.min.y;

    const savedPosition = options.position;
    const position = savedPosition
        ? new three.Vector3(
            Number(savedPosition.x) || 0,
            Number(savedPosition.y) || table.userData.offsetToFloor || 0,
            Number(savedPosition.z) || 0
        )
        : findOpenFloorPositionForObject(table);
    if (!position) {
        disposeObjectResources(table);
        notifyLab('Kh\u00f4ng c\u00f2n v\u1ecb tr\u00ed tr\u1ed1ng \u0111\u1ec3 th\u00eam b\u00e0n m\u1edbi.');
        return null;
    }

    table.position.copy(position);
    if (options.rotation) {
        table.rotation.set(
            Number(options.rotation.x) || 0,
            Number(options.rotation.y) || 0,
            Number(options.rotation.z) || 0
        );
    }
    table.userData.lastValidFloorPosition = position.clone();
    table.userData.dragStartFloorPosition = position.clone();
    scene.add(table);
    registerDraggableObject(table);

    window.labTables ??= [];
    if (!window.labTables.includes(table)) window.labTables.push(table);

    if (options.persist !== false) saveMovableTablesForRoom(currentMovableTableRoomKey || roomKey);
    if (options.notify !== false) {
        notifyLab('\u0110\u00e3 th\u00eam b\u00e0n m\u1edbi. K\u00e9o b\u00e0n \u0111\u1ec3 \u0111\u1eb7t v\u00e0o v\u1ecb tr\u00ed tr\u1ed1ng trong ph\u00f2ng.');
    }
    return table;
}

function setupAddTableButton() {
    window.addMovableLabTable = addMovableLabTable;
    const addTableBtn = document.getElementById('addTableBtn');
    if (!addTableBtn) return;
    addTableBtn.addEventListener('click', addMovableLabTable);
}

export async function loadChemistryCabinet() {
    if (chemicalCabinet) {
        chemicalCabinet.visible = true;
        window.chemicalCabinet = chemicalCabinet;
        return;
    }
    try {
        const bookcaseGltf = await loader.loadAsync(`${modelPath}bookcase.glb`);
        chemicalCabinet = bookcaseGltf.scene;
        chemicalCabinet.position.set(0, 0, -9.8);
        chemicalCabinet.rotation.y = -Math.PI / 2;
        chemicalCabinet.scale.set(2.0, 2.0, 2.0);
        scene.add(chemicalCabinet);
        window.chemicalCabinet = chemicalCabinet;

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
        window.chemicalCabinet = chemicalCabinet;
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

    // One shared screen-space coordinate for both the visible dot and its ray.
    // NDC y = 0 is the exact vertical center of each stereo eye viewport.
    const reticleNdc = new three.Vector2(0, 0);

    const createReticleMaterial = (color, opacity, size) => new three.ShaderMaterial({
        uniforms: {
            reticleColor: { value: new three.Color(color) },
            reticleOpacity: { value: opacity },
            reticleSize: { value: size },
            reticleCenter: { value: reticleNdc }
        },
        vertexShader: `
            uniform float reticleSize;
            uniform vec2 reticleCenter;
            void main() {
                gl_Position = vec4(reticleCenter + position.xy * reticleSize, 0.0, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 reticleColor;
            uniform float reticleOpacity;
            void main() {
                gl_FragColor = vec4(reticleColor, reticleOpacity);
            }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
    });

    const reticleSizes = {
        idleOutline: 0.032,
        idleDot: 0.021,
        targetOutline: 0.064,
        targetDot: 0.04
    };
    const outlineMaterial = createReticleMaterial(0x020617, 0.9, reticleSizes.idleOutline);
    const dotMaterial = createReticleMaterial(0x22d3ee, 1, reticleSizes.idleDot);

    const makeDot = (name) => {
        const group = new three.Group();
        group.name = name;
        group.visible = false;
        group.userData.ignoreRaycast = true;

        const outline = new three.Mesh(new three.CircleGeometry(1, 32), outlineMaterial);
        const dot = new three.Mesh(new three.CircleGeometry(1, 32), dotMaterial);
        outline.frustumCulled = false;
        dot.frustumCulled = false;
        outline.raycast = () => {};
        dot.raycast = () => {};
        outline.renderOrder = 10000;
        dot.renderOrder = 10001;
        group.add(outline, dot);
        root.add(group);
        return group;
    };

    const markers = [makeDot('XR Center Gaze Dot')];
    const aimTargets = new Map();
    const origin = new three.Vector3();
    const direction = new three.Vector3();
    const eyeOrigin = new three.Vector3();
    const eyeDirection = new three.Vector3();
    const eyeCenterPoint = new three.Vector3();
    // The initial VR rig can be more than 10 world units from the center table.
    // A 6-unit cap made the reticle visible over tools while the interaction ray
    // stopped several metres in front of them.
    const maxDistance = 30;
    const gazeDwellMs = 1200;
    const gazeIdleColor = new three.Color(0x22d3ee);
    const gazeReadyColor = new three.Color(0x22c55e);
    let gazeDwellTarget = null;
    let gazeDwellStartedAt = 0;
    let gazeDwellTriggered = false;
    let lockedAimTarget = null;
    let pendingAimTarget = null;
    let pendingAimStartedAt = 0;
    const aimSwitchDelayMs = 180;

    const getGazeCameras = () => {
        const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : null;
        return xrCamera?.isArrayCamera && xrCamera.cameras?.length
            ? xrCamera.cameras
            : [xrCamera || camera];
    };

    // Read the matrices supplied by WebXR directly. Calling updateMatrixWorld()
    // on an eye camera can rebuild it from the app camera and lose the pose that
    // WebXR wrote for the current frame, making the visible dot and ray disagree.
    const getCameraCenterRay = (gazeCamera) => {
        if (!gazeCamera?.matrixWorld || !gazeCamera?.projectionMatrixInverse) return null;

        eyeOrigin.setFromMatrixPosition(gazeCamera.matrixWorld);
        eyeCenterPoint
            .set(reticleNdc.x, reticleNdc.y, 0.5)
            .applyMatrix4(gazeCamera.projectionMatrixInverse)
            .applyMatrix4(gazeCamera.matrixWorld);
        eyeDirection.subVectors(eyeCenterPoint, eyeOrigin).normalize();

        if (
            !Number.isFinite(eyeOrigin.x) ||
            !Number.isFinite(eyeDirection.x) ||
            eyeDirection.lengthSq() < 0.5
        ) return null;

        return new three.Ray(eyeOrigin.clone(), eyeDirection.clone());
    };

    const updateTargetFeedback = (hasToolTarget) => {
        const targetOutlineSize = hasToolTarget ? reticleSizes.targetOutline : reticleSizes.idleOutline;
        const targetDotSize = hasToolTarget ? reticleSizes.targetDot : reticleSizes.idleDot;
        outlineMaterial.uniforms.reticleSize.value = three.MathUtils.lerp(
            outlineMaterial.uniforms.reticleSize.value,
            targetOutlineSize,
            0.5
        );
        dotMaterial.uniforms.reticleSize.value = three.MathUtils.lerp(
            dotMaterial.uniforms.reticleSize.value,
            targetDotSize,
            0.5
        );
    };

    const copyGazeRay = (targetRay = null) => {
        const gazeCameras = getGazeCameras();

        origin.set(0, 0, 0);
        direction.set(0, 0, 0);
        let validEyeCount = 0;
        gazeCameras.forEach((gazeCamera) => {
            const eyeRay = getCameraCenterRay(gazeCamera);
            if (!eyeRay) return;
            origin.add(eyeRay.origin);
            direction.add(eyeRay.direction);
            validEyeCount += 1;
        });

        if (!validEyeCount) {
            const fallbackRay = getCenterAimResultFromCamera(camera, maxDistance).ray;
            if (fallbackRay) {
                origin.copy(fallbackRay.origin);
                direction.copy(fallbackRay.direction);
                validEyeCount = 1;
            }
        }

        origin.multiplyScalar(1 / Math.max(1, validEyeCount));
        direction.normalize();

        if (targetRay?.origin && targetRay?.direction) {
            targetRay.origin.copy(origin);
            targetRay.direction.copy(direction).normalize();
            return targetRay;
        }

        return new three.Ray(origin.clone(), direction.clone().normalize());
    };

    const isToolReticleRoot = (object) => Boolean(
        object &&
        !object.userData?.isTable &&
        !object.userData?.isMovableTable &&
        !object.userData?.isFurniture
    );

    const isProjectedAimCandidate = (object) => {
        if (!isToolReticleRoot(object) || object.visible === false) return false;
        if (object.userData?.isDeleted || object.userData?.toolData?.is_deleted) return false;
        if (object.userData?.ignoreInteraction || object.userData?.isInternalChemicalVisual) return false;

        let parent = object.parent;
        while (parent) {
            if (parent.userData?.ignoreInteraction) return false;
            parent = parent.parent;
        }
        return true;
    };

    // Some GLTF tools contain holes or very thin triangles. The center dot can
    // visibly sit on the tool while a triangle ray slips through. In that case,
    // select from the tool's projected screen-space bounds—the same coordinates
    // used to draw the reticle—so visual aim and interaction aim stay aligned.
    const getProjectedReticleTarget = (gazeCamera, aimRay = null) => {
        const cameraPosition = new three.Vector3().setFromMatrixPosition(gazeCamera.matrixWorld);
        const cameraForward = new three.Vector3(0, 0, -1).transformDirection(gazeCamera.matrixWorld);
        let best = null;

        draggableObjects.forEach((object) => {
            if (!isProjectedAimCandidate(object)) return;
            object.updateMatrixWorld(true);

            const box = new three.Box3().setFromObject(object);
            if (box.isEmpty()) return;
            const center = box.getCenter(new three.Vector3());
            const toCenter = center.clone().sub(cameraPosition);
            const distance = toCenter.length();
            if (distance < 0.02 || distance > maxDistance || cameraForward.dot(toCenter) <= 0) return;

            const boxSize = box.getSize(new three.Vector3());
            // Keep approximately the same angular tolerance at every distance.
            // The old fixed 4.5 cm padding became effectively sub-pixel from the
            // initial VR spawn point, although the dot visibly covered the tool.
            const angularPadding = distance * 0.018;
            const boxPadding = Math.min(0.32, Math.max(0.035, angularPadding, boxSize.length() * 0.025));
            const paddedBox = box.clone().expandByScalar(boxPadding);
            const boxHitPoint = aimRay?.intersectBox?.(paddedBox, new three.Vector3()) || null;
            const rayHitDistance = boxHitPoint
                ? aimRay.origin.distanceTo(boxHitPoint)
                : Infinity;

            const min = box.min;
            const max = box.max;
            const corners = [
                new three.Vector3(min.x, min.y, min.z),
                new three.Vector3(min.x, min.y, max.z),
                new three.Vector3(min.x, max.y, min.z),
                new three.Vector3(min.x, max.y, max.z),
                new three.Vector3(max.x, min.y, min.z),
                new three.Vector3(max.x, min.y, max.z),
                new three.Vector3(max.x, max.y, min.z),
                new three.Vector3(max.x, max.y, max.z)
            ].map(point => point.project(gazeCamera));

            const minX = Math.min(...corners.map(point => point.x));
            const maxX = Math.max(...corners.map(point => point.x));
            const minY = Math.min(...corners.map(point => point.y));
            const maxY = Math.max(...corners.map(point => point.y));
            const padding = 0.075;
            const containsReticle =
                minX - padding <= reticleNdc.x && reticleNdc.x <= maxX + padding &&
                minY - padding <= reticleNdc.y && reticleNdc.y <= maxY + padding;
            if (!boxHitPoint && !containsReticle) return;

            const projectedCenter = center.clone().project(gazeCamera);
            const screenDistance = Math.hypot(
                projectedCenter.x - reticleNdc.x,
                projectedCenter.y - reticleNdc.y
            );
            // A true center-ray/AABB hit always wins over a screen-bounds-only
            // fallback. Within the same class, choose the front-most tool.
            const hitDistance = Number.isFinite(rayHitDistance) ? rayHitDistance : distance;
            const score = (boxHitPoint ? 0 : 1000) + hitDistance + screenDistance * 0.05;
            if (!best || score < best.score) {
                best = {
                    root: object,
                    score,
                    distance: hitDistance,
                    boxHit: Boolean(boxHitPoint)
                };
            }
        });

        return best;
    };

    // Run the same center-screen raycast used by FPS for each stereo eye. The
    // object is resolved by interaction.js, so VR can no longer disagree with
    // FPS about hidden, deleted, held, or nested tool meshes.
    const getPerEyeReticleTarget = () => {
        const gazeCameras = getGazeCameras();
        const results = gazeCameras.map((gazeCamera) => {
            const eyeRay = getCameraCenterRay(gazeCamera);
            const projectedResult = getProjectedReticleTarget(gazeCamera, eyeRay);

            if (projectedResult?.root) {
                return {
                    root: projectedResult.root,
                    hit: { distance: projectedResult.distance },
                    ray: eyeRay,
                    mode: projectedResult.boxHit ? 'ray-box' : 'projected-bounds'
                };
            }

            return { root: null, hit: null, ray: eyeRay, mode: 'none' };
        });
        const rankedRoots = new Map();

        results.forEach((result) => {
            if (!result.root) return;
            const rank = rankedRoots.get(result.root) || {
                object: result.root,
                eyeCount: 0,
                nearestDistance: Infinity,
                modes: new Set()
            };
            rank.eyeCount += 1;
            rank.nearestDistance = Math.min(rank.nearestDistance, result.hit?.distance ?? Infinity);
            rank.modes.add(result.mode);
            rankedRoots.set(result.root, rank);
        });

        const ranks = Array.from(rankedRoots.values()).sort((a, b) =>
            b.eyeCount - a.eyeCount || a.nearestDistance - b.nearestDistance
        );
        const toolRank = ranks.find(rank => isToolReticleRoot(rank.object)) || null;
        const aimedRank = toolRank || ranks[0] || null;

        return {
            aimedRoot: aimedRank?.object || null,
            toolRoot: toolRank?.object || null,
            eyeCount: aimedRank?.eyeCount || 0,
            eyeTotal: gazeCameras.length,
            aimMode: aimedRank ? Array.from(aimedRank.modes).join('+') : 'none'
        };
    };

    const getStableAimTarget = (nextTarget) => {
        const now = performance.now();
        if (nextTarget === lockedAimTarget) {
            pendingAimTarget = null;
            pendingAimStartedAt = 0;
            return lockedAimTarget;
        }

        if (!lockedAimTarget) {
            lockedAimTarget = nextTarget || null;
            pendingAimTarget = null;
            pendingAimStartedAt = 0;
            return lockedAimTarget;
        }

        if (nextTarget !== pendingAimTarget) {
            pendingAimTarget = nextTarget || null;
            pendingAimStartedAt = now;
            return lockedAimTarget;
        }

        if (now - pendingAimStartedAt >= aimSwitchDelayMs) {
            lockedAimTarget = nextTarget || null;
            pendingAimTarget = null;
            pendingAimStartedAt = 0;
        }
        return lockedAimTarget;
    };

    const canUseGazeDwell = () => {
        const sessionSources = Array.from(renderer.xr.getSession()?.inputSources || []);
        const hasTrackedController = sessionSources.some(source =>
            source?.targetRayMode === 'tracked-pointer' &&
            (source.handedness === 'left' || source.handedness === 'right')
        );
        const externalGamepad = controlsManager.getExternalXRGamepad?.();
        const hasFullGamepad = (externalGamepad?.buttons?.length || 0) >= 8;
        return !hasTrackedController && !hasFullGamepad;
    };

    const resetGazeDwell = () => {
        gazeDwellTarget = null;
        gazeDwellStartedAt = 0;
        gazeDwellTriggered = false;
        dotMaterial.uniforms.reticleColor.value.copy(gazeIdleColor);
    };

    const updateGazeDwell = (toolRoot) => {
        const enabled = canUseGazeDwell();
        const isHolding = controlsManager.isXRHandHolding?.('any') === true;
        if (!enabled || isHolding || !toolRoot) {
            resetGazeDwell();
            return { enabled, progress: 0 };
        }

        const now = performance.now();
        if (gazeDwellTarget !== toolRoot) {
            gazeDwellTarget = toolRoot;
            gazeDwellStartedAt = now;
            gazeDwellTriggered = false;
        }

        const progress = three.MathUtils.clamp((now - gazeDwellStartedAt) / gazeDwellMs, 0, 1);
        dotMaterial.uniforms.reticleColor.value.copy(gazeIdleColor).lerp(gazeReadyColor, progress);

        if (progress >= 1 && !gazeDwellTriggered) {
            gazeDwellTriggered = true;
            controlsManager.triggerXRGazeGrab?.();
        }

        return { enabled, progress };
    };

    return {
        object: root,
        aimTargets,
        copyAimRay: copyGazeRay,
        getAimTarget() {
            if (!renderer.xr.isPresenting && !renderer.xr.getSession()) return null;
            if (lockedAimTarget) return lockedAimTarget;
            lockedAimTarget = getPerEyeReticleTarget().toolRoot;
            return lockedAimTarget;
        },
        update(isPresenting) {
            root.visible = isPresenting;
            if (!isPresenting) {
                markers.forEach(marker => marker.visible = false);
                aimTargets.clear();
                window.vlabXRReticleState = null;
                outlineMaterial.uniforms.reticleSize.value = reticleSizes.idleOutline;
                dotMaterial.uniforms.reticleSize.value = reticleSizes.idleDot;
                resetGazeDwell();
                lockedAimTarget = null;
                pendingAimTarget = null;
                pendingAimStartedAt = 0;
                return;
            }

            const aimResult = getPerEyeReticleTarget();
            // Stabilize tools only. Locking a table/floor hit here prevents the
            // reticle from ever switching to a nearby tool.
            const toolRoot = getStableAimTarget(aimResult.toolRoot);
            const aimedRoot = toolRoot || aimResult.aimedRoot;
            const { eyeCount, eyeTotal, aimMode } = aimResult;
            const gazeDwell = updateGazeDwell(toolRoot);

            updateTargetFeedback(Boolean(toolRoot));

            window.vlabXRReticleState = {
                hasToolTarget: Boolean(toolRoot),
                targetUuid: aimedRoot?.uuid || null,
                targetName: aimedRoot?.userData?.name_tool_vi ||
                    aimedRoot?.userData?.toolData?.name_tool_vi ||
                    aimedRoot?.name || null,
                eyeCount,
                eyeTotal,
                aimMode,
                gazeDwellEnabled: gazeDwell.enabled,
                gazeDwellProgress: gazeDwell.progress,
                reticleSize: dotMaterial.uniforms.reticleSize.value,
                updatedAt: performance.now()
            };

            controllers.forEach(controller => {
                if (controller) aimTargets.set(controller, aimedRoot);
            });

            markers.forEach(marker => marker.visible = true);
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
        updateDroppedObjectFalls(delta);
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

