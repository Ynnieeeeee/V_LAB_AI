import * as three from 'three';
import { triggerMascotSpeech } from './mascot.js';
import { PouringEffect } from './pouringEffect.js';
import { detectReaction } from './reactionRules.js';
import {
    getSelectedQuantity,
    recordPourAction,
    validateExperimentBeforeReaction,
    describeNextRequirement,
    hasActiveExperimentPlan,
    markReactionSuccess
} from './ExperimentSessionManager.js';
import { camera, cameraGroup } from './camera.js';
import {
    spawnFireParticles,
    spawnSmoke,
    spawnGasCloud,
    createShockwave,
    heatDistortion,
    spawnPrecipitate,
    spawnFoam,
    phaseSeparation as applyPhaseSeparation,
    decolorizeLiquid
} from './reactionEffects.js';
const THREE = three;

function isSolidChemical(obj) {
    const s = String(
        obj?.userData?.current_physical_state ||
        obj?.userData?.physical_state ||
        obj?.userData?.physicalState ||
        obj?.userData?.state ||
        ''
    ).toLowerCase();
    return s.includes('rắn') || s.includes('ran') || s.includes('solid') || s.includes('powder') || s.includes('bột');
}


function isContainerWithChemical(obj) {
    return !!(
        obj?.userData?.toolData &&
        (obj.userData.current_chemical_id || obj.userData.current_chemical_type || obj.userData.chemicalName)
    );
}

function isPourSource(obj) {
    return !!(obj?.userData && (obj.userData.id_chemical || obj.userData.chemicalId || isContainerWithChemical(obj)));
}

function getChemicalId(obj) {
    return obj?.userData?.current_chemical_id || obj?.userData?.id_chemical || obj?.userData?.chemicalId || null;
}

function getChemicalType(obj) {
    return obj?.userData?.current_chemical_type || obj?.userData?.chemicalType || obj?.userData?.chemical_type || null;
}

function getChemicalName(obj) {
    return obj?.userData?.current_chemical_name || obj?.userData?.chemicalName || obj?.userData?.name_vi || 'Hóa chất';
}

function getChemicalColor(obj) {
    return obj?.userData?.liquidColor || obj?.userData?.color || '#3498db';
}

function getPhysicalState(obj) {
    return obj?.userData?.current_physical_state || obj?.userData?.physical_state || obj?.userData?.physicalState || obj?.userData?.state || 'Lỏng';
}

function rememberContainerContents(container, ...items) {
    if (!container?.userData) return;
    const set = new Set(container.userData.contents || []);
    items.flat().filter(Boolean).forEach(item => set.add(String(item)));
    container.userData.contents = Array.from(set);
}

function addContainerComposition(container, ...items) {
    if (!container?.userData) return;
    if (!container.userData.composition) container.userData.composition = {};
    items.flat().filter(Boolean).forEach(item => {
        const key = String(item);
        container.userData.composition[key] = (Number(container.userData.composition[key]) || 0) + 1;
    });
}

function applyReactionState(container, reaction) {
    if (!container?.userData || !reaction) return;
    const state = reaction.producesState || reaction.produces_state || {};
    Object.entries(state).forEach(([key, value]) => {
        if (value === null) {
            delete container.userData[key];
        } else {
            container.userData[key] = value;
        }
    });
    if (state.precipitateSpecies) {
        container.userData.hasPrecipitate = true;
        container.userData.precipitateSpecies = state.precipitateSpecies;
    }
    if (state.complexIon) {
        rememberContainerContents(container, state.complexIon);
        addContainerComposition(container, state.complexIon);
    }
}

function removeInternalLayer(container, layerName) {
    const layer = container?.getObjectByName?.(layerName);
    if (!layer) return;
    layer.traverse?.(child => {
        if (child.geometry) child.geometry.dispose?.();
        if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
            else child.material.dispose?.();
        }
    });
    layer.parent?.remove(layer);
}

function clearPrecipitateLayer(container) {
    removeInternalLayer(container, 'precipitateLayer');
    if (container?.userData) {
        container.userData.hasPrecipitate = false;
        container.userData.precipitateColor = null;
        container.userData.precipitateSpecies = null;
    }
}

function createSilverMirrorCoating(container) {
    if (!container) return null;
    removeInternalLayer(container, 'silverMirrorLayer');

    const layer = new three.Group();
    layer.name = 'silverMirrorLayer';
    markInternalEffect(layer, container);

    const box = new three.Box3().setFromObject(container);
    const inv = container.matrixWorld.clone().invert();
    const min = box.min.clone().applyMatrix4(inv);
    const max = box.max.clone().applyMatrix4(inv);
    const sx = Math.max(0.045, Math.abs(max.x - min.x) * 0.34);
    const sz = Math.max(0.045, Math.abs(max.z - min.z) * 0.34);
    const h = Math.max(0.08, Math.abs(max.y - min.y) * 0.34);
    const y = Math.min(min.y, max.y) + h * 0.72;

    const geometry = new three.CylinderGeometry(sx, sx * 0.95, h, 48, 1, true);
    geometry.scale(1, 1, sz / sx);
    const material = new three.MeshPhysicalMaterial({
        color: '#dfe4ea',
        metalness: 1.0,
        roughness: 0.03,
        transparent: true,
        opacity: 0.72,
        side: three.DoubleSide,
        envMapIntensity: 2.0
    });
    const mesh = new three.Mesh(geometry, material);
    mesh.name = 'silver_mirror_inner_wall';
    mesh.position.set((min.x + max.x) * 0.5, y, (min.z + max.z) * 0.5);
    markInternalEffect(mesh, container);
    layer.add(mesh);
    container.add(layer);
    container.userData.hasSilverMirror = true;
    return layer;
}

function isContainerHoldingLiquid(obj) {
    return !!(
        obj?.userData &&
        (
            (obj.userData.liquidLevel || 0) > 0 ||
            obj.userData.liquidColor ||
            obj.getObjectByName?.('liquid_group')
        )
    );
}

function markInternalEffect(obj, container = null) {
    if (!obj) return obj;
    obj.userData.ignoreInteraction = true;
    obj.userData.isInternalChemicalVisual = true;
    obj.userData.isReactionEffect = true;
    obj.userData.notDraggable = true;
    obj.userData.ignoreRaycast = true;
    if (container) obj.userData.container = container;
    obj.raycast = () => null;
    obj.traverse?.(child => {
        child.userData.ignoreInteraction = true;
        child.userData.isInternalChemicalVisual = true;
        child.userData.isReactionEffect = true;
        child.userData.notDraggable = true;
        child.userData.ignoreRaycast = true;
        if (container) child.userData.container = container;
        child.raycast = () => null;
    });
    return obj;
}

function removeLocalEffectGroup(container, name) {
    const group = container?.userData?.[name] || container?.getObjectByName?.(name);
    if (!group) return;
    group.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(m => m?.dispose?.());
        else child.material?.dispose?.();
    });
    group.parent?.remove(group);
    if (container?.userData) delete container.userData[name];
}

function clearDissolvablePowder(container) {
    // Khi rắn gặp lỏng và không tạo kết tủa, bột ban đầu phải hòa tan, không còn lớp hạt rắn nhìn thấy.
    removeLocalEffectGroup(container, 'powderDeposit');
    removeLocalEffectGroup(container, 'powderDepositLayer');
}

function formatReactionMascotText(reaction) {
    const raw = reaction?.raw || {};
    const speech = reaction?.mascotText || raw?.mascot_speech || raw?.mascotText || 'Phản ứng hóa học đã xảy ra.';
    const equation = reaction?.equation || raw?.reaction_data?.equation || raw?.equation || '';
    return equation ? `${speech}\n${equation}` : speech;
}

function resolveDraggableRoot(hitObject) {
    let node = hitObject;
    while (node) {
        if (draggableObjects.includes(node)) return node;
        if (node.userData?.root && draggableObjects.includes(node.userData.root)) return node.userData.root;
        if (node.userData?.container && draggableObjects.includes(node.userData.container)) return node.userData.container;
        if (node.userData?.ignoreInteraction || node.userData?.isInternalChemicalVisual) return null;
        node = node.parent;
    }
    return null;
}

function getInteractionCandidates() {
    return draggableObjects.filter(obj =>
        obj &&
        obj !== heldObjectRight &&
        obj !== heldObjectLeft &&
        !obj.userData?.ignoreInteraction &&
        !obj.userData?.isInternalChemicalVisual
    );
}

function getWorldCenter(obj) {
    const box = new three.Box3().setFromObject(obj);
    const center = new three.Vector3();
    box.getCenter(center);
    return center;
}

export const draggableObjects = [];
let heldObjectRight = null; // Đối tượng tay phải
let heldObjectLeft = null;  // Đối tượng tay trái
let isInspectingRight = false;
let isInspectingLeft = false;

const raycaster = new three.Raycaster();
const mouse = new three.Vector2();
const movePlane = new three.Plane(new three.Vector3(0, 1, 0), 0);
const planeIntersectPoint = new three.Vector3();
let selectedObjectForMenu = null;
let draggedObject = null;

export let pouringEffect;
let lastPouredTarget = null;
let isPouringAction = false;
let activePourSource = null;
export const pouringState = { currentPourTargetPos: null }; // Sử dụng object state chuẩn

// Nhóm đại diện cho 2 tay người chơi, gắn vào camera
const leftArmGroup = new three.Group();
const rightArmGroup = new three.Group();

function createArm(isRight = true) {
    const armGroup = new three.Group();

    const skinMaterial = new three.MeshPhysicalMaterial({
        color: 0xdbac82,
        roughness: 0.6,
        metalness: 0.05,
        clearcoat: 0.1,
        sheen: 0.5,
        sheenColor: 0xffffff
    });

    // Cánh tay (Forearm)
    const armGeo = new three.CylinderGeometry(0.035, 0.05, 0.65, 16);
    const armMat = new three.MeshStandardMaterial({ color: 0xe0ac69 });
    const armMesh = new three.Mesh(armGeo, armMat);
    armMesh.rotation.x = Math.PI / 2;
    armMesh.position.z = -0.325; // nủa chiều dài 0.65
    armGroup.add(armMesh);

    armGroup.position.set(isRight ? 0.38 : -0.38, -0.68, -0.32);
    const handGroup = new three.Group();
    handGroup.position.z = -0.8;
    armGroup.add(handGroup);

    const palmGeo = new three.BoxGeometry(0.12, 0.04, 0.14);
    const palmMesh = new three.Mesh(palmGeo, skinMaterial);
    handGroup.add(palmMesh);

    // Tạo các ngón tay
    const fingerData = [
        { name: 'thumb', x: 0.07, z: -0.02, rotY: 0.6, rotZ: -0.4, scale: 0.8 },
        { name: 'index', x: 0.04, z: -0.08, rotY: 0.1, rotZ: 0, scale: 1.0 },
        { name: 'middle', x: 0.01, z: -0.09, rotY: 0, rotZ: 0, scale: 1.1 },
        { name: 'ring', x: -0.02, z: -0.085, rotY: -0.1, rotZ: 0, scale: 1.0 },
        { name: 'pinky', x: -0.05, z: -0.07, rotY: -0.2, rotZ: 0, scale: 0.8 }
    ];

    fingerData.forEach(data => {
        const finger = new three.Group();
        const sideMult = isRight ? 1 : -1;
        finger.position.set(data.x * sideMult, 0, data.z);
        finger.rotation.y = data.rotY * sideMult;
        finger.rotation.z = data.rotZ * sideMult;

        // Đốt ngón tay 1
        const seg1Geo = new three.CylinderGeometry(0.012, 0.014, 0.06 * data.scale, 8);
        const seg1 = new three.Mesh(seg1Geo, skinMaterial);
        seg1.name = "seg1";
        seg1.position.z = -0.03 * data.scale;
        finger.add(seg1);

        // Đốt ngón tay 2
        const seg2Geo = new three.CylinderGeometry(0.009, 0.012, 0.05 * data.scale, 8);
        const seg2 = new three.Mesh(seg2Geo, skinMaterial);
        seg2.name = "seg2";
        seg2.position.z = -0.05 * data.scale;
        seg2.position.y = 0.02 * data.scale;
        finger.add(seg2);

        finger.name = "finger_" + data.name;
        handGroup.add(finger);
    });

    // Nhóm chứa vật thể được nhặt
    const itemSlot = new three.Group();
    itemSlot.name = "itemSlot";
    itemSlot.position.set(0, 0.06, -0.05); // Đặt giữa lòng bàn tay
    handGroup.add(itemSlot);

    // Hơi xoay bàn tay vào trong cho tự nhiên
    handGroup.rotation.y = isRight ? -0.2 : 0.2;
    handGroup.rotation.z = isRight ? -0.1 : 0.1;

    return armGroup;
}

const leftArm = createArm(false);
const rightArm = createArm(true);
leftArmGroup.add(leftArm);
rightArmGroup.add(rightArm);

export function registerDraggableObject(obj) {
    obj.updateMatrixWorld(true);

    // Lưu Scale và Quaternion nguyên bản ngay khi đăng ký
    if (!obj.userData.originalWorldScale) {
        const worldScale = new three.Vector3();
        obj.getWorldScale(worldScale);
        obj.userData.originalWorldScale = worldScale.x;
    }
    if (!obj.userData.originalQuaternion) {
        const worldQuat = new three.Quaternion();
        obj.getWorldQuaternion(worldQuat);
        obj.userData.originalQuaternion = worldQuat.clone();
    }

    if (obj.userData.offsetToFloor === undefined) {
        const box = new three.Box3().setFromObject(obj);
        obj.userData.offsetToFloor = obj.position.y - box.min.y;
    }

    // --- BƯỚC 1: TÍNH TOÁN TỰ ĐỘNG VỊ TRÍ MIỆNG LỌ ---
    if (obj.userData.id_chemical && !obj.userData.pourAnchor) {
        // Tính bounding box chỉ dựa trên Mesh (bỏ qua label sprite phía trên)
        const meshBox = new three.Box3();
        obj.traverse(child => {
            if (child.isMesh && child.name !== "fluid_volume") {
                meshBox.expandByObject(child);
            }
        });

        if (!meshBox.isEmpty()) {
            const center = new three.Vector3();
            meshBox.getCenter(center);

            // --- ĐỔ ĐÚNG TỪ MIỆNG CHAI (CÁCH CHUẨN) ---
            // Giả lập cổ chai nằm phía trước local -Z
            const localMouth = new three.Vector3(0, 0.42, -0.18);
            obj.userData.pourAnchor = localMouth.clone();
            console.log(`[System] Đã xác định pourAnchor chuẩn cho ${obj.userData.name_vi}:`, obj.userData.pourAnchor);
        }
    }

    // Đánh dấu để Raycaster nhận diện được root model
    obj.traverse(child => {
        child.userData.root = obj;
        child.userData.isInteractable = true;
    });
    draggableObjects.push(obj);
}

export function initInteractionEvents(camera, controlsManager, scene) {
    const { orbit, fps } = controlsManager;
    const contextmenu = document.getElementById('context-menu');
    pouringEffect = new PouringEffect(scene);

    // Thêm 2 tay vào camera
    camera.add(leftArmGroup);
    camera.add(rightArmGroup);

    const updateRaycaster = (event) => {
        if (fps.isLocked) {
            raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        } else {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
        }
    };

    // --- LOGIC CẦM NẮM (FPS) ---
    const handleHandInteraction = (isRightHand = true) => {
        let currentHeld = isRightHand ? heldObjectRight : heldObjectLeft;
        const arm = isRightHand ? rightArm : leftArm;

        if (currentHeld) {
            // Thả vật thể về Scene (Sử dụng attach để giữ nguyên world transform tạm thời)
            scene.attach(currentHeld);
            if (pouringEffect) pouringEffect.invalidateCavity(currentHeld);

            // Tìm điểm va chạm để đặt vật thể
            raycaster.setFromCamera({ x: 0, y: 0 }, camera);

            // Ẩn tạm thời các nhóm camera và vật thể để tránh va chạm sai
            const originalVisible = currentHeld.visible;
            const originalCameraVisible = cameraGroup.visible;
            currentHeld.visible = false;
            cameraGroup.visible = false;

            const sceneIntersects = raycaster.intersectObjects(scene.children, true);

            currentHeld.visible = originalVisible;
            cameraGroup.visible = originalCameraVisible;

            if (sceneIntersects.length > 0) {
                // Ưu tiên tìm mặt bàn hoặc sàn nhà
                let bestHit = sceneIntersects[0];
                for (let i = 0; i < sceneIntersects.length; i++) {
                    const hit = sceneIntersects[i];
                    const isTable = hit.object.userData.isTable || (hit.object.parent && hit.object.parent.userData.isTable);
                    if (isTable) {
                        bestHit = hit;
                        break;
                    }
                }
                currentHeld.position.copy(bestHit.point);
            } else {
                // Nếu không chạm gì, đặt phía trước người chơi 1m
                const forward = new three.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                currentHeld.position.copy(camera.position).add(forward.multiplyScalar(1));
                currentHeld.position.y = 0;
            }

            // KHÔI PHỤC TRẠNG THÁI GỐC (SỬ DỤNG WORLD DATA ĐÃ LƯU)
            if (currentHeld.userData.originalWorldScale) {
                const s = currentHeld.userData.originalWorldScale;
                currentHeld.scale.set(s, s, s);
            }

            // Ưu tiên sử dụng originalQuaternion từ lúc đăng ký để đảm bảo không bị lộn ngược
            const targetQuat = currentHeld.userData.originalQuaternion || currentHeld.userData.originalWorldQuaternion;
            if (targetQuat) {
                currentHeld.quaternion.copy(targetQuat);
            }

            // Đảm bảo tiếp đất chuẩn (Không lơ lửng)
            currentHeld.updateMatrixWorld(true);
            const box = new three.Box3().setFromObject(currentHeld);
            const bottomY = box.min.y;
            // Tính toán khoảng cách chênh lệch để vật thể chạm đất/bàn
            const bottomOffset = currentHeld.position.y - bottomY;
            currentHeld.position.y += bottomOffset;

            if (isRightHand) heldObjectRight = null;
            else heldObjectLeft = null;

        } else {
            // NHẶT VẬT THỂ
            raycaster.setFromCamera({ x: 0, y: 0 }, camera);
            const oldFar = raycaster.far;
            const candidates = getInteractionCandidates();
            const intersects = raycaster.intersectObjects(candidates, true);
            raycaster.far = oldFar;

            if (intersects.length > 0) {
                let root = resolveDraggableRoot(intersects[0].object);
                if (!root) return;

                // Kiểm tra xem vật này có đang bị tay kia cầm không
                if (root === heldObjectRight || root === heldObjectLeft) return;

                if (isRightHand) heldObjectRight = root;
                else heldObjectLeft = root;

                const slot = arm.getObjectByName("itemSlot");
                if (slot) {
                    // Lưu trạng thái gốc trong không gian thế giới (World) để khôi phục chính xác
                    const worldScale = new three.Vector3();
                    root.getWorldScale(worldScale);
                    root.userData.originalWorldScale = worldScale.x;

                    const worldQuat = new three.Quaternion();
                    root.getWorldQuaternion(worldQuat);
                    root.userData.originalWorldQuaternion = worldQuat.clone();

                    slot.attach(root);
                    if (pouringEffect) pouringEffect.invalidateCavity(root);
                    root.position.set(0, 0.1, 0);
                    root.rotation.order = 'YXZ';
                    root.rotation.set(0, isRightHand ? -Math.PI / 2 : Math.PI / 2, 0);

                    // Scale khi cầm trên tay (nhỏ đi một chút)
                    const s = root.userData.originalWorldScale * 0.7;
                    root.scale.set(s, s, s);

                    // Không gọi mascot khi chỉ cầm/nhặt dụng cụ hoặc hóa chất.
                    // Mascot chỉ hiển thị sau khi phản ứng thật sự xảy ra.
                }
            }
        }
    };

    window.addEventListener('keydown', (e) => {
        if (!fps.isLocked) return;
        const key = e.key.toLowerCase();
        if (key === 'e') {
            handleHandInteraction(true); // Tay phải
        } else if (key === 'q') {
            handleHandInteraction(false); // Tay trái
        } else if (key === 'f') {
            isInspectingRight = true;
        } else if (key === 'r') {
            isInspectingLeft = true;
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            const heldObj = heldObjectRight || heldObjectLeft || draggedObject; // Kiểm tra cả tay và chuột
            if (!heldObj) return;

            // Chống spam gọi API/Spam Space liên tục (1 giây cooldown)
            const now = performance.now();
            if (heldObj.userData.lastReactionCheck &&
                now - heldObj.userData.lastReactionCheck < 1000) {
                return;
            }
            heldObj.userData.lastReactionCheck = now;

            console.log("Phím Space được nhấn, đối tượng đang cầm/kéo:", heldObj.userData);
            if (isPourSource(heldObj)) {
                isPouringAction = true;
                activePourSource = heldObj;
                // Animation xoay lọ sẽ được xử lý liên tục trong updateArmsAnimation

                // Xác định điểm đổ (miệng lọ) dựa trên thực tế xoay
                let pourPoint = new three.Vector3();
                if (heldObj.userData.pourAnchor) {
                    pourPoint.copy(heldObj.userData.pourAnchor).applyMatrix4(heldObj.matrixWorld);
                } else {
                    const mouthOffset = new three.Vector3(0, 0.5, 0);
                    pourPoint.copy(mouthOffset).applyMatrix4(heldObj.matrixWorld);
                }

                console.log({
                    chemical: getChemicalName(heldObj),
                    color: getChemicalColor(heldObj)
                });
                pouringEffect.startPouring(
                    pourPoint,
                    getChemicalColor(heldObj),
                    getChemicalName(heldObj),
                    getChemicalType(heldObj),
                    getPhysicalState(heldObj)
                );
            }
        }
    });

    window.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        if (key === 'f') isInspectingRight = false;
        if (key === 'r') isInspectingLeft = false;
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            const heldObj = heldObjectRight || heldObjectLeft || draggedObject;
            if (heldObj) {
                isPouringAction = false;
                activePourSource = null;
                heldObj.rotation.z = 0; // Trả lọ về thẳng đứng
                pouringEffect.stop();
                lastPouredTarget = null; // Reset mục tiêu đổ
            }
        }
    });

    // --- LOGIC KIỂM TRA ĐỔ HÓA CHẤT ---
    const downRaycaster = new three.Raycaster();
    const downVector = new three.Vector3(0, -1, 0);

    function getContainerEffectPosition(container) {
        if (!container) return new three.Vector3();
        container.updateMatrixWorld(true);
        const box = new three.Box3().setFromObject(container);
        const center = new three.Vector3();
        box.getCenter(center);
        // Đặt hiệu ứng phụ ở gần miệng dụng cụ, không ở ngoài tủ/kệ.
        center.y = box.max.y + 0.035;
        return center;
    }

    function effectPower(...values) {
        for (const value of values) {
            if (value === undefined || value === null || value === false) continue;
            if (value === true) return 1;
            if (typeof value === 'number') return Math.max(0, Math.min(2, value));
            if (typeof value === 'object') {
                const nested = value.intensity ?? value.power ?? value.strength ?? value.density ?? value.toxicity ?? value.value;
                const n = effectPower(nested);
                if (n > 0) return n;
            }
        }
        return 0;
    }


    function reactionTextHaystack(reaction) {
        const raw = reaction?.raw || {};
        const parts = [
            reaction?.mascotText,
            reaction?.equation,
            raw?.mascot_speech,
            raw?.mascotText,
            raw?.equation,
            raw?.reaction_data?.equation,
            ...(reaction?.products || []),
            ...(raw?.products || []),
            ...(raw?.reaction_data?.products || [])
        ];
        return parts.filter(Boolean).join(' ').toLowerCase();
    }

    function hasPrecipitateReaction(reaction) {
        if (!reaction) return false;
        const raw = reaction.raw || {};
        const visual = raw.visual || {};
        const effects = raw.effects || {};
        if (reaction.precipitate || raw.precipitate || visual.precipitate || effects.precipitate) return true;

        const text = reactionTextHaystack(reaction);
        return /(↓|kết tủa|ket tua|precipitate|precipitation|insoluble|không tan|khong tan|agcl|baso₄|baso4|caco₃|caco3|cu\(oh\)₂|cu\(oh\)2|fe\(oh\)₃|fe\(oh\)3|pbcl₂|pbcl2)/i.test(text);
    }

    function getPrecipitateColor(reaction) {
        const raw = reaction?.raw || {};
        const visual = raw.visual || {};
        const effects = raw.effects || {};
        const text = reactionTextHaystack(reaction);

        const explicit =
            reaction?.precipitateColor ||
            reaction?.precipitate_color ||
            raw?.precipitateColor ||
            raw?.precipitate_color ||
            visual?.precipitateColor ||
            visual?.precipitate_color ||
            effects?.precipitateColor ||
            effects?.precipitate_color;

        if (explicit) return explicit;

        if (/xanh lam|xanh dương|blue|cu\(oh\)₂|cu\(oh\)2/i.test(text)) return '#4fc3f7';
        if (/nâu đỏ|đỏ nâu|brown|fe\(oh\)₃|fe\(oh\)3/i.test(text)) return '#8b4a2b';
        if (/vàng|yellow|pbi₂|pbi2|agi/i.test(text)) return '#ffd54f';
        if (/đen|black|pbs|cus/i.test(text)) return '#222222';
        return '#ffffff';
    }

    function createReactionEffect(config) {

        if (!config) return;

        const raw = config.raw || config.reaction || {};
        const visual = raw.visual || {};
        const effectList = Array.isArray(config.effects) ? config.effects : (Array.isArray(raw.effects) ? raw.effects : []);
        const effects = Array.isArray(raw.effects) ? {} : (raw.effects || {});
        const byType = (type) => effectList.find(fx => fx?.type === type);
        const container = config.container || null;
        const position = config.position || getContainerEffectPosition(container);

        const fire = effectPower(config.fire, byType('fire'), raw.fire, visual.fire_effect, effects.fire);
        const smoke = effectPower(config.smoke, byType('smoke'), raw.smoke, visual.smoke_effect, effects.smoke);
        const gas = effectPower(config.gas, byType('gas'), raw.gas, visual.gas_effect, effects.gas);
        const explosion = effectPower(config.explosion, raw.explosion, visual.explosion_effect, effects.explosion);
        const heat = effectPower(config.heat, byType('heat'), raw.heat, effects.heat);
        const foam = Boolean(config.foam || raw.foam || effects.foam || byType('foam'));

        console.log("REACTION FX:", { fire, smoke, gas, explosion, heat, foam, config });

        // Các hiệu ứng bay lên khỏi miệng cốc dùng world-space.
        // Kết tủa tuyệt đối KHÔNG spawn vào scene ở world-space, vì sẽ bị lệch ra ngoài dụng cụ.
        if (fire > 0) {
            spawnFireParticles(scene, position, { intensity: fire });
        }

        if (smoke > 0) {
            spawnSmoke(scene, position, { density: smoke });
        }

        if (gas > 0) {
            spawnGasCloud(scene, position, { toxicity: gas });
        }

        if (explosion > 0) {
            createShockwave(scene, position, { power: explosion });
        }

        if (heat > 0) {
            heatDistortion(scene, position, { strength: heat });
        }

        if (foam) {
            spawnFoam(scene, position, { intensity: effectPower(config.foam, byType('foam'), 1) || 1 });
        }
    }


    window.checkPouringCollision = () => {
        if (!pouringEffect || !pouringEffect.isPouring) return;

        const potentialSources = (activePourSource ? [activePourSource] : [heldObjectRight || heldObjectLeft]).filter(isPourSource);

        potentialSources.forEach(sourceObj => {
            sourceObj.updateMatrixWorld(true);

            // --- BƯỚC 2: CẬP NHẬT TỌA ĐỘ ĐỘNG CỦA ĐIỂM ĐỔ NƯỚC ---
            let pourPoint = new three.Vector3();
            if (sourceObj.userData.pourAnchor) {
                // Lấy tọa độ thế giới từ điểm neo pourAnchor đã tính ở Bước 1
                pourPoint.copy(sourceObj.userData.pourAnchor).applyMatrix4(sourceObj.matrixWorld);
            } else {
                // Fallback nếu chưa có anchor
                const box = new three.Box3().setFromObject(sourceObj);
                pourPoint.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
            }

            // Cập nhật vị trí bắt đầu dòng chảy trong visual effect
            pouringEffect.emit(pourPoint);

            // --- BƯỚC 3: SỬ DỤNG RAYCASTING ĐỂ "BUỘC" DÒNG CHẢY RƠI VÀO CỐC ---
            const allTargets = draggableObjects.filter(obj =>
                obj && obj !== sourceObj && obj.userData.toolData
            );

            // Tìm tâm mục tiêu gần nhất trước để định hướng dòng chảy
            let nearestTargetCenter = null;
            let nearestDist = Infinity;

            allTargets.forEach(target => {
                const box = new three.Box3().setFromObject(target);
                const center = new three.Vector3();
                box.getCenter(center);
                const d = pourPoint.distanceTo(center);

                if (d < nearestDist) {
                    nearestDist = d;
                    nearestTargetCenter = center;
                }
            });

            // Hướng đổ THẬT
            let pourDirection;
            if (nearestTargetCenter) {
                // Aim trực tiếp vào tâm cốc
                pourDirection = nearestTargetCenter.clone().sub(pourPoint).normalize();
            } else {
                // fallback hướng xuống
                pourDirection = new three.Vector3(0, -1, 0);
            }

            downRaycaster.set(pourPoint, pourDirection);

            // Danh sách các vật thể có thể nhận chất lỏng (cốc, ống nghiệm, hoặc chính khối chất lỏng)
            const fluidVolumes = Array.from(pouringEffect.volumes.values());
            const raycastTargets = [...allTargets, ...fluidVolumes];

            let intersects = downRaycaster.intersectObjects(raycastTargets, true);
            let targetHit = null;
            let streamEnd = null;

            if (intersects.length > 0) {
                targetHit = intersects[0];

                const targetObj =
                    targetHit.object.userData.container ||
                    resolveDraggableRoot(targetHit.object) ||
                    targetHit.object;

                const targetBox = new three.Box3().setFromObject(targetObj);
                const targetCenter = new three.Vector3();
                targetBox.getCenter(targetCenter);

                // Luôn hút vào miệng cốc (kết thúc ở miệng thay vì center sâu bên dưới)
                streamEnd = new three.Vector3(
                    targetCenter.x,
                    targetBox.max.y + 0.05, // Cao hơn miệng 1 chút để tạo tia đâm vào
                    targetCenter.z
                );
            } else {
                // --- CƠ CHẾ TỰ ĐỘNG HÚT (MAGNETIC SNAP) CẢI TIẾN ---
                // Tăng bán kính tìm kiếm lên 0.55m để dễ đổ trúng hơn
                let bestDist = 0.55;
                allTargets.forEach(target => {
                    const targetBox = new three.Box3().setFromObject(target);
                    const targetCenter = new three.Vector3();
                    targetBox.getCenter(targetCenter);

                    const dx = pourPoint.x - targetCenter.x;
                    const dz = pourPoint.z - targetCenter.z;
                    const distXZ = Math.sqrt(dx * dx + dz * dz);

                    // Kiểm tra: Trong bán kính 0.55m và miệng lọ phải cao hơn thân dụng cụ
                    if (distXZ < bestDist && (targetBox.max.y - 0.1) < pourPoint.y) {
                        bestDist = distXZ;
                        // Điểm rơi sẽ là miệng của dụng cụ
                        streamEnd = new three.Vector3(targetCenter.x, targetBox.max.y + 0.05, targetCenter.z);
                        targetHit = { object: target, point: streamEnd };
                    }
                });
            }

            // --- CHỈ ĐỔ KHI LỌ ĐÃ NGHIÊNG ĐỦ ĐỘ (X hoặc Z) ---
            const worldRot = new three.Euler().setFromQuaternion(
                sourceObj.getWorldQuaternion(new three.Quaternion())
            );
            const tiltAmount = Math.max(Math.abs(worldRot.x), Math.abs(worldRot.z));

            if (targetHit && tiltAmount > Math.PI * 0.35) {
                const nearestTarget =
                    targetHit.object.userData.container ||
                    resolveDraggableRoot(targetHit.object) ||
                    targetHit.object;

                pouringState.currentPourTargetPos = streamEnd;
                handlePourSuccess(sourceObj, nearestTarget, streamEnd);
            } else {
                if (tiltAmount > Math.PI * 0.35) {
                    const fallEnd = pourPoint.clone();
                    fallEnd.y = Math.max(pourPoint.y - 1.5, 0);
                    pouringState.currentPourTargetPos = fallEnd;
                } else {
                    pouringState.currentPourTargetPos = null;
                }
            }
        });
    };


    function addSourceContentToContainer(target, source, options = {}) {
        if (!target || !source || !target.userData) return null;

        const sourceState = getPhysicalState(source);
        const sourceColorValue = getChemicalColor(source);
        const targetAlreadyHasLiquid = isContainerHoldingLiquid(target);
        const targetAlreadyHasSolid = isSolidChemical(target) || !!target.userData.hasSolidDeposit;

        // Rắn + dụng cụ trống: giữ dạng bột/hạt.
        // Rắn + lỏng: hòa tan vào pha lỏng, KHÔNG để lại lớp bột rắn.
        if (isSolidChemical(source)) {
            if (!targetAlreadyHasLiquid && !options.forceDissolve) {
                createPowderDeposit(target, sourceColorValue || '#dddddd');
                target.userData.hasSolidDeposit = true;
                target.userData.current_chemical_id = getChemicalId(source);
                target.userData.current_chemical_type = getChemicalType(source);
                target.userData.current_chemical_name = getChemicalName(source);
                target.userData.chemicalType = getChemicalType(source);
                target.userData.chemicalName = getChemicalName(source);
                target.userData.color = sourceColorValue;
                target.userData.current_physical_state = sourceState;
                target.userData.physical_state = sourceState;
                rememberContainerContents(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
                addContainerComposition(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
                return null;
            }

            clearDissolvablePowder(target);
            target.userData.hasSolidDeposit = false;
            target.userData.current_physical_state = 'Lỏng';
            target.userData.physical_state = 'Lỏng';
        }

        // Chất lỏng hoặc chất rắn đang hòa tan đều tạo/cập nhật pha dung dịch.
        // Lỏng + rắn: xóa lớp bột cũ vì bột đã hòa tan vào dung dịch.
        if (!isSolidChemical(source) && targetAlreadyHasSolid && !options.keepPowder) {
            clearDissolvablePowder(target);
            target.userData.hasSolidDeposit = false;
        }

        target.userData.liquidLevel = (target.userData.liquidLevel || 0) + (options.amount || 0.003);
        if (target.userData.liquidLevel > 0.8) target.userData.liquidLevel = 0.8;

        const volume = pouringEffect.getOrCreateVolume(target);
        volume.position.set(0, 0, 0);

        const sourceColor = new three.Color(sourceColorValue || '#3498db');

        // Nếu cốc đã có màu lỏng cũ thì pha màu nhẹ, tránh mất cảm giác đang trộn/hòa tan.
        if (target.userData.liquidColor && !options.forceSourceColor) {
            sourceColor.lerp(target.userData.liquidColor, isSolidChemical(source) ? 0.72 : 0.45);
        }

        volume.userData.chemicalType = options.chemicalType || getChemicalType(source);
        volume.userData.chemicalName = options.chemicalName || getChemicalName(source);
        volume.userData.color = '#' + sourceColor.getHexString();

        if (volume.material) {
            volume.material.color.copy(sourceColor);
            volume.material.needsUpdate = true;
        }

        target.userData.liquidColor = sourceColor.clone();
        target.userData.color = '#' + sourceColor.getHexString();

        // Chỉ ghi đè danh tính hóa chất khi cốc trống/cùng chất.
        if (options.replaceIdentity) {
            target.userData.current_chemical_id = getChemicalId(source);
            target.userData.current_chemical_type = getChemicalType(source);
            target.userData.current_chemical_name = getChemicalName(source);
            target.userData.chemicalType = getChemicalType(source);
            target.userData.chemicalName = getChemicalName(source);
        }

        target.userData.current_physical_state = 'Lỏng';
        target.userData.physical_state = 'Lỏng';

        rememberContainerContents(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
        addContainerComposition(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));

        return volume;
    }

    // Hàm phụ xử lý khi đổ thành công
    async function handlePourSuccess(source, target, targetMouthPos) {
        if (!target || !target.userData) return;

        const selectedQuantity = getSelectedQuantity(source);
        const pourRecord = recordPourAction({
            source,
            target,
            amount: selectedQuantity.amount,
            unit: selectedQuantity.unit,
            physicalState: getPhysicalState(source)
        });

        // Lấy thông tin chemical_type động (nếu cốc đã phản ứng trước đó, lấy chất mới sinh ra)
        const sourceChemType = getChemicalType(source);
        const targetChemType = getChemicalType(target);

        const sourceId = getChemicalId(source);
        const targetId = getChemicalId(target);

        // 1. Trường hợp cốc trống hoặc đổ cùng loại chất.
        // Nếu chất nguồn là RẮN thì KHÔNG tạo liquid volume; chỉ tạo lớp bột/hạt trong dụng cụ.
        if (!targetChemType || targetId === sourceId) {
            addSourceContentToContainer(target, source, {
                replaceIdentity: true,
                forceSourceColor: true
            });
            if (hasActiveExperimentPlan() && pourRecord.recorded) {
                const guidance = describeNextRequirement(target);
                if (guidance) triggerMascotSpeech(guidance);
            }
            return;
        }

        // 2. Trường hợp trộn 2 chất khác nhau và cốc không trong trạng thái đợi đổi màu cũ kết thúc
        if (targetChemType && targetId !== sourceId && !target.userData.isReacting) {
            const now = performance.now();
            if (
                target.lastReactionCheck &&
                now - target.lastReactionCheck < 1500
            ) {
                return;
            }
            target.lastReactionCheck = now;
            target.userData.isReacting = true; // Khóa tạm thời để tránh spam

            const type1 = getChemicalType(source);

            const type2 = getChemicalType(target);

            if (sourceId === targetId) {
                target.userData.isReacting = false;
                return;
            }

            console.log("REACTION CHECK:", { type1, type2, sourceId, targetId });

            if (hasActiveExperimentPlan()) {
                const validation = validateExperimentBeforeReaction({ source, target });
                if (!validation.ok) {
                    addSourceContentToContainer(target, source, {
                        replaceIdentity: false,
                        forceSourceColor: false
                    });
                    target.userData.isReacting = false;
                    triggerMascotSpeech(validation.message || 'Thí nghiệm chưa đúng điều kiện nên phản ứng chưa xảy ra.');
                    return;
                }
            }

            const reaction = await detectReaction(source, target);

            console.log("REACTION RESULT:", reaction);

            if (reaction.has_reaction) {
                console.log("Phản ứng xảy ra!");

                const targetObject = target;

                createReactionEffect({
                    container: targetObject,
                    position: getContainerEffectPosition(targetObject),
                    color: reaction.color,
                    gas: reaction.gas,
                    smoke: reaction.smoke,
                    fire: reaction.fire,
                    explosion: reaction.explosion,
                    heat: reaction.heat,
                    foam: reaction.foam,
                    gasColor: reaction.gasColor,
                    smokeColor: reaction.smokeColor,
                    raw: reaction.raw || reaction,
                    effects: reaction.effects,
                    precipitate: reaction.precipitate,
                    precipitateColor: reaction.precipitateColor
                });

                // Bảo đảm phản ứng lỏng + rắn cũng có pha lỏng trong dụng cụ để hiển thị/tiếp tục trộn.
                targetObject.userData.liquidLevel = (targetObject.userData.liquidLevel || 0) + 0.003;
                if (targetObject.userData.liquidLevel > 0.8) targetObject.userData.liquidLevel = 0.8;

                const volume = pouringEffect.getOrCreateVolume(targetObject);

                // đổi màu
                if (reaction.color) {

                    volume.userData.targetColor =
                        new three.Color(reaction.color);

                    volume.userData.isColorLerping = true;

                    // phát sáng nhẹ cho dung dịch
                    volume.material.emissive =
                        new three.Color(reaction.color)
                            .multiplyScalar(0.08);

                    volume.material.needsUpdate = true;
                }

                // hiệu ứng khí
                volume.userData.hasGasEffect =
                    reaction.gas || reaction.smoke;

                // cháy
                volume.userData.hasFireEffect =
                    reaction.fire;

                // đánh dấu đang phản ứng
                targetObject.userData.isReacting = true;
                window.setTimeout(() => {
                    if (targetObject?.userData) targetObject.userData.isReacting = false;
                }, 1800);

                console.log("REACTION APPLIED:", reaction);

                // Nếu một trong hai chất ban đầu là rắn thì phần rắn ban đầu đã tham gia phản ứng/hòa tan.
                // Không giữ lại lớp bột cũ; nếu phản ứng tạo kết tủa thì tạo lớp kết tủa mới bên dưới.
                if (isSolidChemical(source) || isSolidChemical(targetObject)) {
                    clearDissolvablePowder(targetObject);
                    targetObject.userData.hasSolidDeposit = false;
                }

                // kết tủa
                // FIX: không chỉ dựa vào reaction.precipitate boolean.
                // Một số API/rule chỉ trả phương trình có dấu ↓ hoặc mô tả "kết tủa".
                if (hasPrecipitateReaction(reaction)) {
                    const precipitateColor = getPrecipitateColor(reaction);
                    createPrecipitate(
                        targetObject,
                        precipitateColor
                    );
                    targetObject.userData.hasPrecipitate = true;
                    targetObject.userData.precipitateColor = precipitateColor;
                    volume.userData.hasPrecipitate = true;
                }

                if (reaction.dissolvePrecipitate) {
                    clearPrecipitateLayer(targetObject);
                    if (volume) volume.userData.hasPrecipitate = false;
                }

                if (reaction.mirrorCoating) {
                    createSilverMirrorCoating(targetObject);
                }

                if (reaction.decolorize && volume) {
                    decolorizeLiquid(targetObject, reaction.color || '#ffffff');
                }

                if (reaction.twoLayerLiquid && volume) {
                    volume.userData.twoLayerLiquid = true;
                    targetObject.userData.twoLayerLiquid = true;
                    applyPhaseSeparation(targetObject, {
                        upperColor: targetObject.userData.upperLayerColor || '#fff4c2',
                        lowerColor: targetObject.userData.lowerLayerColor || '#f8f8ff'
                    });
                }

                rememberContainerContents(
                    targetObject,
                    getChemicalName(source),
                    getChemicalName(targetObject),
                    reaction.products || [],
                    reaction.result_chemical_id,
                    reaction.result_chemical_type
                );
                addContainerComposition(
                    targetObject,
                    getChemicalName(source),
                    getChemicalType(source),
                    reaction.products || [],
                    reaction.result_chemical_id,
                    reaction.result_chemical_type
                );
                applyReactionState(targetObject, reaction);
                markReactionSuccess(targetObject, reaction);

                // --- ĐỒNG BỘ TRẠNG THÁI HÓA CHẤT MỚI SAU PHẢN ỨNG ---
                target.userData.current_chemical_type = reaction.result_chemical_type || "generic_solution";
                target.userData.current_chemical_id = reaction.result_chemical_id ||`${sourceId}_reacted_${Date.now()}`;
                target.userData.reactionStage = (target.userData.reactionStage || 0) + 1;

                target.userData.chemicalType = reaction.result_chemical_type || "generic_solution";
                target.userData.chemicalName = (reaction.products && reaction.products[0]) || "Dung dịch phản ứng";
                target.userData.current_chemical_name = target.userData.chemicalName;
                target.userData.color = reaction.color;

                if (volume) {
                    volume.userData.chemicalType = reaction.result_chemical_type || "generic_solution";
                    volume.userData.chemicalName = (reaction.products && reaction.products[0]) || "Dung dịch phản ứng";
                    volume.userData.color = reaction.color;

                    if (reaction.color) {

                        const reactionColor = new three.Color(reaction.color);

                        // lưu màu mới
                        target.userData.liquidColor = reactionColor.clone();

                        // FORCE đổi màu marching cubes
                        if (volume.material) {

                            volume.material.color.set(reactionColor);

                            volume.material.emissive = reactionColor.clone().multiplyScalar(0.15);

                            volume.material.needsUpdate = true;
                        }

                        // nếu material clone bên trong marching cubes
                        if (volume.mesh && volume.mesh.material) {

                            volume.mesh.material.color.set(reactionColor);

                            volume.mesh.material.needsUpdate = true;
                        }
                    }
                }

                // Mascot chỉ hiển thị kết quả phản ứng: mascot_speech + equation.
                if (hasActiveExperimentPlan()) {
                    triggerMascotSpeech(window.currentExperimentPlan?.success_message || formatReactionMascotText(reaction));
                } else {
                    triggerMascotSpeech(formatReactionMascotText(reaction));
                }
            } else {
                // Trộn vật lý thông thường, không phản ứng.
                // FIX: trước đây nhánh này chỉ mở khóa + tăng liquidLevel ở cuối,
                // nên khi cốc đang có chất rắn thì không hề tạo volume lỏng => nhìn như không đổ được lỏng vào rắn.
                addSourceContentToContainer(target, source, {
                    replaceIdentity: false,
                    forceSourceColor: false
                });
                target.userData.isReacting = false;
                return;
            }
        }

        // Tăng mực nước dâng lên khi đổ chất liên tục sau phản ứng thật.
        target.userData.liquidLevel = (target.userData.liquidLevel || 0) + 0.003;
        if (target.userData.liquidLevel > 0.8) target.userData.liquidLevel = 0.8;
    }

    // --- LOGIC KÉO THẢ (MOUSE/ORBIT) ---
    window.addEventListener('pointerdown', (e) => {
        if (fps.isLocked) {
            if (e.button === 0) { // Left Click
                handleHandInteraction(true);
            } else if (e.button === 2) { // Right Click
                handleHandInteraction(false);
            }
            return;
        }

        // CHỈ KÉO THẢ BẰNG CHUỘT TRÁI (Button 0)
        if (e.button !== 0) return;

        updateRaycaster(e);
        const candidates = getInteractionCandidates();
        const intersects = raycaster.intersectObjects(candidates, true);
        if (intersects.length > 0) {
            draggedObject = resolveDraggableRoot(intersects[0].object);
            if (!draggedObject) return;
            scene.attach(draggedObject);
            if (pouringEffect) pouringEffect.invalidateCavity(draggedObject);

            // Khôi phục scale và hướng xoay chuẩn (World)
            if (!draggedObject.userData.originalWorldScale) {
                const worldScale = new three.Vector3();
                draggedObject.getWorldScale(worldScale);
                draggedObject.userData.originalWorldScale = worldScale.x;
            }
            if (!draggedObject.userData.originalQuaternion) {
                const worldQuat = new three.Quaternion();
                draggedObject.getWorldQuaternion(worldQuat);
                draggedObject.userData.originalQuaternion = worldQuat.clone();
            }

            const s = draggedObject.userData.originalWorldScale;
            draggedObject.scale.set(s, s, s);
            draggedObject.quaternion.copy(draggedObject.userData.originalQuaternion);

            // Chỉ tính offset nếu chưa có
            if (draggedObject.userData.offsetToFloor === undefined) {
                const box = new three.Box3().setFromObject(draggedObject);
                draggedObject.userData.offsetToFloor = draggedObject.position.y - box.min.y;
            }

            orbit.enabled = false;

            // Không gọi mascot khi kéo/thả. Mascot chỉ nói kết quả phản ứng.
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!draggedObject || fps.isLocked) return;
        updateRaycaster(e);

        // 1. Giả định đang trên mặt bàn (y=1.6)
        let targetY = 1.6;
        movePlane.set(new three.Vector3(0, 1, 0), -targetY);

        if (raycaster.ray.intersectPlane(movePlane, planeIntersectPoint)) {
            // Kiểm tra xem vị trí chuột có nằm trong diện tích mặt bàn không (Bàn 8x4)
            const isOnTable = Math.abs(planeIntersectPoint.x) <= 4 && Math.abs(planeIntersectPoint.z) <= 2;

            if (!isOnTable) {
                // Nếu không ở trên bàn, hạ xuống sàn (y=0)
                targetY = 0;
                movePlane.set(new three.Vector3(0, 1, 0), -targetY);
                raycaster.ray.intersectPlane(movePlane, planeIntersectPoint);
            }
        } else {
            // Trường hợp không cắt được mặt bàn (nhìn lên trời/ra xa), mặc định là sàn
            targetY = 0;
            movePlane.set(new three.Vector3(0, 1, 0), -targetY);
            raycaster.ray.intersectPlane(movePlane, planeIntersectPoint);
        }

        draggedObject.position.x = planeIntersectPoint.x;
        draggedObject.position.z = planeIntersectPoint.z;

        // Luôn đảm bảo cao độ chuẩn xác
        draggedObject.position.y = targetY + (draggedObject.userData.offsetToFloor || 0);
    });

    window.addEventListener('pointerup', () => {
        if (draggedObject) {
            orbit.enabled = true;
            draggedObject = null;
        }
    });

    // Xử lý nút Phóng to / Thu nhỏ trong Context Menu
    const zoomInBtn = document.getElementById('zoom-in-btn');
    const zoomOutBtn = document.getElementById('zoom-out-btn');

    if (zoomInBtn) {
        zoomInBtn.onclick = () => {
            if (selectedObjectForMenu) {
                selectedObjectForMenu.scale.multiplyScalar(1.2);
                if (pouringEffect) pouringEffect.invalidateCavity(selectedObjectForMenu);
                // Giới hạn scale tối đa
                const maxScale = (selectedObjectForMenu.userData.originalScale || 1.0) * 5.0;
                if (selectedObjectForMenu.scale.x > maxScale) {
                    selectedObjectForMenu.scale.set(maxScale, maxScale, maxScale);
                }
            }
            contextmenu.classList.add('hidden');
        };
    }

    if (zoomOutBtn) {
        zoomOutBtn.onclick = () => {
            if (selectedObjectForMenu) {
                selectedObjectForMenu.scale.multiplyScalar(0.8);
                if (pouringEffect) pouringEffect.invalidateCavity(selectedObjectForMenu);
                // Giới hạn scale tối thiểu
                const minScale = (selectedObjectForMenu.userData.originalScale || 1.0) * 0.2;
                if (selectedObjectForMenu.scale.x < minScale) {
                    selectedObjectForMenu.scale.set(minScale, minScale, minScale);
                }
            }
            contextmenu.classList.add('hidden');
        };
    }

    // Ẩn menu khi click ra ngoài
    window.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) {
            contextmenu.classList.add('hidden');
        }
    });

    window.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (fps.isLocked) return;
        updateRaycaster(e);
        const candidates = getInteractionCandidates();
        const intersects = raycaster.intersectObjects(candidates, true);

        if (intersects.length > 0) {
            selectedObjectForMenu = resolveDraggableRoot(intersects[0].object);
            if (!selectedObjectForMenu) return;
            contextmenu.style.top = `${e.clientY}px`;
            contextmenu.style.left = `${e.clientX}px`;
            contextmenu.classList.remove('hidden');
        } else {
            contextmenu.classList.add('hidden');
        }
    });
}

// Cập nhật hoạt ảnh đung đưa của 2 tay (Walking bobbing) và Inspect
const lerpSpeed = 0.1; // Tốc độ chuyển đổi giữa các trạng thái
export function updateArmsAnimation(time, isMoving) {
    const speed = isMoving ? 10 : 1.5;
    const amplitude = isMoving ? 0.05 : 0.005;

    const bob = Math.sin(time * speed) * amplitude;
    const sway = Math.cos(time * speed * 0.5) * amplitude * 0.5;

    // --- LOGIC DI CHUYỂN TAY KHI ĐỔ (POURING ANIMATION) ---
    const isPouringHandToHand = isPouringAction && heldObjectRight && heldObjectLeft;

    // --- TAY TRÁI ---
    let targetPosLeft = new three.Vector3(-0.45 + sway, -0.5 + bob, -0.2);
    let targetRotLeft = new three.Euler(0, 0, sway * 0.5);

    if (isInspectingLeft && heldObjectLeft) {
        targetPosLeft.set(-0.15, -0.2, -0.45);
        targetRotLeft.set(0.2, 0.4, 0);
    } else if (isPouringHandToHand) {
        const isSource = heldObjectLeft === activePourSource;
        const isTarget = heldObjectLeft.userData.toolData && heldObjectLeft !== activePourSource;

        if (isSource) {
            // Tay trái cầm chai -> giữ bên trái
            targetPosLeft.set(-0.18, -0.32, -0.55);
            targetRotLeft.set(1.0, 0.35, 0.08);
        } else if (isTarget) {
            // Tay trái cầm cốc -> cũng giữ bên trái
            targetPosLeft.set(-0.08, -0.45, -0.72);
            targetRotLeft.set(0.05, 0.02, 0);
        }
    }

    leftArm.position.lerp(targetPosLeft, lerpSpeed);
    leftArm.rotation.x = three.MathUtils.lerp(leftArm.rotation.x, targetRotLeft.x, lerpSpeed);
    leftArm.rotation.y = three.MathUtils.lerp(leftArm.rotation.y, targetRotLeft.y, lerpSpeed);
    leftArm.rotation.z = three.MathUtils.lerp(leftArm.rotation.z, targetRotLeft.z, lerpSpeed);

    animateFingers(leftArm, !!heldObjectLeft);

    // --- TAY PHẢI ---
    let targetPosRight = new three.Vector3(0.45 - sway, -0.5 + bob, -0.2);
    let targetRotRight = new three.Euler(0, 0, -sway * 0.5);

    if (isInspectingRight && heldObjectRight) {
        targetPosRight.set(0.15, -0.2, -0.45);
        targetRotRight.set(0.2, -0.4, 0);
    } else if (isPouringHandToHand) {
        const isSource = heldObjectRight === activePourSource;
        const isTarget = heldObjectRight.userData.toolData && heldObjectRight !== activePourSource;

        if (isSource) {
            // Tay phải cầm chai -> giữ bên phải
            targetPosRight.set(0.18, -0.32, -0.55);
            targetRotRight.set(1.0, -0.35, -0.08);
        } else if (isTarget) {
            // Tay phải cầm cốc -> vẫn bên phải
            targetPosRight.set(0.08, -0.45, -0.72);
            targetRotRight.set(0.05, -0.02, 0);
        }
    }

    rightArm.position.lerp(targetPosRight, lerpSpeed);
    rightArm.rotation.x = three.MathUtils.lerp(rightArm.rotation.x, targetRotRight.x, lerpSpeed);
    rightArm.rotation.y = three.MathUtils.lerp(rightArm.rotation.y, targetRotRight.y, lerpSpeed);
    rightArm.rotation.z = three.MathUtils.lerp(rightArm.rotation.z, targetRotRight.z, lerpSpeed);

    // --- FORCE BOTTLE TILT DURING POURING ---
    const hands = [
        { held: heldObjectRight, isRight: true },
        { held: heldObjectLeft, isRight: false }
    ];

    hands.forEach(h => {
        if (h.held) {
            const isSource = h.held === activePourSource;

            if (isPouringAction && isSource) {
                // Chỉ bắt đầu nghiêng lọ khi tay đã đưa vào đủ gần vị trí trung tâm
                const distToTarget = h.isRight ? rightArm.position.distanceTo(targetPosRight) : leftArm.position.distanceTo(targetPosLeft);

                if (distToTarget < 0.12) {
                    // Nghiêng lọ vừa phải (~110 độ) để không quét quá mạnh
                    h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, Math.PI * 0.62, 0.12);
                    h.held.rotation.z = three.MathUtils.lerp(h.held.rotation.z, h.isRight ? -0.25 : 0.25, 0.1);
                }
                h.held.position.lerp(new three.Vector3(0, -0.02, -0.04), 0.1);
            } else if (isPouringAction && !isSource) {
                // ĐỐI VỚI DỤNG CỤ HỨNG: Xoay ngược lại để luôn thẳng đứng tuyệt đối
                h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, 0, 0.25);
                h.held.rotation.y = three.MathUtils.lerp(h.held.rotation.y, 0, 0.25);
                h.held.rotation.z = three.MathUtils.lerp(h.held.rotation.z, 0, 0.25);
                h.held.position.lerp(new three.Vector3(0, -0.02, -0.04), 0.1);
            } else {
                h.held.position.lerp(new three.Vector3(0, 0.1, 0), 0.1);
                h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, 0, 0.2);
            }
        }
    });

    animateFingers(rightArm, !!heldObjectRight);
}

function animateFingers(arm, isGripping) {
    const targetGrip = isGripping ? 1 : 0;
    if (arm.userData.currentGrip === undefined) arm.userData.currentGrip = 0;
    arm.userData.currentGrip = three.MathUtils.lerp(arm.userData.currentGrip, targetGrip, 0.1);

    const grip = arm.userData.currentGrip;

    arm.traverse(node => {
        if (node.name === "seg1") {
            // Relaxed: -0.2, Gripped: -1.2
            node.rotation.x = three.MathUtils.lerp(-0.2, -1.2, grip);
        }
        if (node.name === "seg2") {
            // Relaxed: -0.1, Gripped: -1.0
            node.rotation.x = three.MathUtils.lerp(-0.1, -1.0, grip);
        }
        if (node.name === "finger_thumb") {
            // Ngón cái xoay đặc biệt hơn
            const seg1 = node.getObjectByName("seg1");
            if (seg1) seg1.rotation.x = three.MathUtils.lerp(-0.1, -0.8, grip);
        }
    });
}

export function setArmsVisibility(visible) {
    leftArmGroup.visible = visible;
    rightArmGroup.visible = visible;
}


function ensureLocalEffectGroup(container, name = 'local_reaction_effects') {
    if (!container) return null;
    let group = container.userData[name];
    if (!group) {
        group = new three.Group();
        group.name = name;
        container.add(group);
        container.userData[name] = group;
    }
    return group;
}

function getCavityLocalInfo(container) {
    const points = container?.userData?.cavityPoints || [];
    if (points.length > 0) {
        const box = new three.Box3();
        let minY = Infinity;
        let maxY = -Infinity;
        points.forEach(p => {
            if (!isFinite(p.lx) || !isFinite(p.lz)) return;
            box.expandByPoint(new three.Vector3(p.lx, 0, p.lz));
            minY = Math.min(minY, p.lyBottom);
            maxY = Math.max(maxY, p.lyTop);
        });
        if (isFinite(minY) && isFinite(maxY) && !box.isEmpty()) {
            return {
                centerX: (box.min.x + box.max.x) * 0.5,
                centerZ: (box.min.z + box.max.z) * 0.5,
                radiusX: Math.max((box.max.x - box.min.x) * 0.28, 0.035),
                radiusZ: Math.max((box.max.z - box.min.z) * 0.28, 0.035),
                bottomY: minY + 0.015,
                surfaceY: three.MathUtils.lerp(minY, maxY, Math.min(container.userData.liquidLevel || 0.2, 0.85))
            };
        }
    }

    // Fallback an toàn cho model chưa detect được cavity.
    const localBox = new three.Box3().setFromObject(container);
    const inv = container.matrixWorld.clone().invert();
    const worldCenter = new three.Vector3();
    localBox.getCenter(worldCenter);
    const localCenter = worldCenter.applyMatrix4(inv);
    return {
        centerX: localCenter.x,
        centerZ: localCenter.z,
        radiusX: 0.08,
        radiusZ: 0.08,
        bottomY: localCenter.y - 0.08,
        surfaceY: localCenter.y
    };
}

function createPowderDeposit(container, color) {
    if (!container) return;

    const group = ensureLocalEffectGroup(container, 'powderDeposit');
    if (!group) return;

    const info = getCavityLocalInfo(container);
    const geo = new three.BufferGeometry();
    const points = [];
    const amount = 180;

    for (let i = 0; i < amount; i++) {
        const r = Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        points.push(
            (info.centerX || 0) + Math.cos(a) * r * info.radiusX,
            info.bottomY + Math.random() * 0.045,
            (info.centerZ || 0) + Math.sin(a) * r * info.radiusZ
        );
    }

    geo.setAttribute('position', new three.Float32BufferAttribute(points, 3));

    const mat = new three.PointsMaterial({
        color: color || '#dddddd',
        size: 0.012,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: true
    });

    const powder = new three.Points(geo, mat);
    powder.name = 'solid_powder_inside_container';
    powder.userData.ignoreInteraction = true;
    powder.userData.isInternalChemicalVisual = true;
    powder.userData.container = container;
    group.userData.ignoreInteraction = true;
    group.userData.isInternalChemicalVisual = true;
    group.add(powder);
}

function createPrecipitate(container, color) {
    if (!container) return;

    // Kết tủa phải nằm trong local-space của dụng cụ.
    // Lỗi cũ: material depthTest=false + renderOrder quá cao làm hạt bị vẽ đè lên thành cốc,
    // nhìn như kết tủa nằm ngoài dụng cụ. Ở đây dùng depthTest=true để thành dụng cụ che đúng.
    const group = ensureLocalEffectGroup(container, 'precipitateLayer');
    if (!group) return;
    markInternalEffect(group, container);

    const info = getCavityLocalInfo(container);
    const geo = new THREE.BufferGeometry();
    const points = [];
    const amount = 720;

    // Giữ hạt nằm gọn hơn trong lòng dụng cụ, tránh chạm/thò ra thành cốc.
    const safeRadiusX = Math.max(0.018, info.radiusX * 0.58);
    const safeRadiusZ = Math.max(0.018, info.radiusZ * 0.58);
    const bottomY = info.bottomY + 0.018;
    const topY = Math.max(bottomY + 0.035, Math.min(info.surfaceY - 0.012, info.bottomY + 0.16));

    for (let i = 0; i < amount; i++) {
        const r = Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;

        // Nhiều hạt lắng ở đáy, một phần lơ lửng trong dung dịch.
        const settleBias = Math.random() * Math.random();
        const yBand = three.MathUtils.lerp(topY, bottomY, settleBias);

        points.push(
            (info.centerX || 0) + Math.cos(a) * r * safeRadiusX,
            yBand,
            (info.centerZ || 0) + Math.sin(a) * r * safeRadiusZ
        );
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    const mat = new THREE.PointsMaterial({
        color: color || '#ffffff',
        size: 0.014,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.98,
        depthWrite: true,
        depthTest: true
    });

    const precipitate = new THREE.Points(geo, mat);
    precipitate.name = 'precipitate_inside_container';
    markInternalEffect(precipitate, container);

    // Không renderOrder cực cao nữa, để depth buffer giữ đúng vị trí trong lòng dụng cụ.
    precipitate.renderOrder = 12;
    group.renderOrder = 12;
    group.add(precipitate);
}
