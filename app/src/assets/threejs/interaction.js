import * as three from 'three';
import { triggerMascotSpeech } from './mascot.js';
import { PouringEffect } from './pouringEffect.js';
import { detectReaction } from './reactionRules.js';
import { camera, cameraGroup } from './camera.js';

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
            raycaster.far = 15;
            const intersects = raycaster.intersectObjects(draggableObjects, true);
            raycaster.far = oldFar;

            if (intersects.length > 0) {
                let root = intersects[0].object.userData.root || intersects[0].object;

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

                    // --- CODE MỚI THÊM: GỌI MASCOT KHI CẦM HÓA CHẤT ---
                    if (root.userData && (root.userData.id_chemical || root.userData.toolData)) {
                        const name = root.userData.name_vi || root.userData.toolData?.name_tool_vi;
                        const handStr = isRightHand ? "tay phải" : "tay trái";
                        const message = `Bạn đang dùng ${handStr} cầm ${name}. ${root.userData.id_chemical ? 'Hãy cẩn thận khi đổ nhé!' : ''}`;
                        if (typeof triggerMascotSpeech === 'function') {
                            triggerMascotSpeech(message);
                        }
                    }
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
            if (heldObj.userData.id_chemical) {
                isPouringAction = true;
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
                    chemical: heldObj.userData.chemicalName,
                    color: heldObj.userData.liquidColor || heldObj.userData.color
                });
                pouringEffect.startPouring(
                    pourPoint,
                    heldObj.userData.liquidColor || heldObj.userData.color,
                    heldObj.userData.chemicalName
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
                heldObj.rotation.z = 0; // Trả lọ về thẳng đứng
                pouringEffect.stop();
                lastPouredTarget = null; // Reset mục tiêu đổ
            }
        }
    });

    // --- LOGIC KIỂM TRA ĐỔ HÓA CHẤT ---
    const downRaycaster = new three.Raycaster();
    const downVector = new three.Vector3(0, -1, 0);

    function createExplosion(position) {
        const particleCount = 40;
        const geometry = new three.BufferGeometry();
        const positions = [];
        const velocities = [];

        for (let i = 0; i < particleCount; i++) {
            positions.push(position.x, position.y + 0.1, position.z);
            
            // Random spherical direction
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos((Math.random() * 2) - 1);
            const speed = 0.05 + Math.random() * 0.15;
            
            const vx = Math.sin(phi) * Math.cos(theta) * speed;
            const vy = (Math.sin(phi) * Math.sin(theta) * speed) + 0.1; // slight upward bias
            const vz = Math.cos(phi) * speed;
            
            velocities.push(vx, vy, vz);
        }

        geometry.setAttribute('position', new three.Float32BufferAttribute(positions, 3));

        const material = new three.PointsMaterial({
            color: 0xffaa00,
            size: 0.12,
            transparent: true,
            opacity: 1,
            blending: three.AdditiveBlending
        });

        const particles = new three.Points(geometry, material);
        scene.add(particles);

        let age = 0;
        const maxAge = 40; // frames
        
        function animateParticles() {
            if (age >= maxAge) {
                scene.remove(particles);
                geometry.dispose();
                material.dispose();
                return;
            }
            
            const posAttr = geometry.attributes.position;
            for (let i = 0; i < particleCount; i++) {
                posAttr.setX(i, posAttr.getX(i) + velocities[i * 3]);
                posAttr.setY(i, posAttr.getY(i) + velocities[i * 3 + 1]);
                posAttr.setZ(i, posAttr.getZ(i) + velocities[i * 3 + 2]);
                
                // Apply gravity
                velocities[i * 3 + 1] -= 0.005;
            }
            posAttr.needsUpdate = true;
            material.opacity = 1 - (age / maxAge);
            age++;
            
            requestAnimationFrame(animateParticles);
        }
        animateParticles();
    }

    function checkChemicalReaction(sourceContainer, targetContainer) {
        if (!sourceContainer || !targetContainer) return;

        // Không tự phản ứng với chính nó
        if (sourceContainer === targetContainer) return;

        // Chống spam gọi API liên tục (1 giây)
        const now = performance.now();
        if (sourceContainer.userData.lastReactionCheck &&
            now - sourceContainer.userData.lastReactionCheck < 1000) {
            return;
        }
        sourceContainer.userData.lastReactionCheck = now;

        const type1 = sourceContainer.userData.current_chemical_type || sourceContainer.userData.chemicalType || sourceContainer.userData.chemical_type;
        const type2 = targetContainer.userData.current_chemical_type || targetContainer.userData.chemicalType || targetContainer.userData.chemical_type;

        const sourceId = sourceContainer.userData.current_chemical_id || sourceContainer.userData.chemicalId || sourceContainer.userData.id_chemical;
        const targetId = targetContainer.userData.current_chemical_id || targetContainer.userData.chemicalId || targetContainer.userData.id_chemical;

        const reaction = detectReaction(type1, type2);

        console.log("SOURCE:", sourceContainer.userData);
        console.log("TARGET:", targetContainer.userData);
        console.log("REACTION:", type1, "+", type2, reaction);

        if (reaction.has_reaction) {
            targetContainer.userData.isReacting = true;

            const volume = pouringEffect.getOrCreateVolume(targetContainer);
            volume.position.set(0, 0, 0); // Đảm bảo volume ở gốc tọa độ chuẩn

            if (reaction.gas) {
                volume.userData.hasGasEffect = true;
            }

            if (reaction.explosion) {
                createExplosion(targetContainer.position);
            }

            if (reaction.color) {
                const reactionColor = new three.Color(reaction.color);
                
                targetContainer.userData.liquidColor = reactionColor.clone();
                volume.material.color.copy(reactionColor);

                volume.userData.targetColor = reactionColor.clone();
                volume.userData.isColorLerping = true;

                volume.material.uniformsNeedUpdate = true;
                volume.material.needsUpdate = true;
            }

            // Gọi Mascot nói tiếng Việt
            let speechMsg = "";
            if (type1 === "alkali_metal" || type2 === "alkali_metal") {
                speechMsg = "Wow! Phản ứng giữa Kim loại kiềm (Natri) và Nước tỏa rất nhiều nhiệt, sinh ra khí Hidro H₂ có thể gây nổ mạnh!";
            } else if (type1 === "strong_acid" || type2 === "strong_acid" || type1 === "acid" || type2 === "acid") {
                speechMsg = "Phản ứng trung hòa Axit và Bazơ tỏa nhiệt, tạo ra muối và nước trung tính!";
            } else {
                speechMsg = "Phản ứng hóa học đang xảy ra cực kỳ sinh động!";
            }
            triggerMascotSpeech(speechMsg);

            // Đồng bộ trạng thái hóa chất mới
            targetContainer.userData.current_chemical_type = "generic_solution";
            targetContainer.userData.current_chemical_id = sourceId;
        }
    }

    window.checkPouringCollision = () => {
        if (!pouringEffect || !pouringEffect.isPouring) return;

        const potentialSources = [heldObjectRight, heldObjectLeft].filter(obj => obj && (obj.userData.id_chemical || obj.userData.chemicalId));

        potentialSources.forEach(sourceObj => {
            sourceObj.updateMatrixWorld(true);

            // --- BƯỚC 1.5: BỘ DÒ PHẢN ỨNG HÓA HỌC CHỦ ĐỘNG THEO KHOẢNG CÁCH (PROACTIVE REACTION DETECTOR) ---
            const nearbyObjects = draggableObjects.filter(obj => {
                if (!obj || obj === sourceObj) return false;
                const d = obj.position.distanceTo(sourceObj.position);
                return d < 0.25;
            });

            nearbyObjects.forEach(target => {
                checkChemicalReaction(sourceObj, target);
            });

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
                    targetHit.object.userData.root ||
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
                    targetHit.object.userData.root ||
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


    // Hàm phụ xử lý khi đổ thành công
    function handlePourSuccess(source, target, targetMouthPos) {
        if (!target || !target.userData) return;

        // Lấy thông tin chemical_type động (nếu cốc đã phản ứng trước đó, lấy chất mới sinh ra)
        const sourceChemType = source.userData.chemical_type;
        const targetChemType = target.userData.current_chemical_type || target.userData.chemical_type;

        const sourceId = source.userData.id_chemical;
        const targetId = target.userData.current_chemical_id || target.userData.id_chemical;

        // 1. Trường hợp cốc trống hoặc đổ cùng loại chất: Chỉ dâng nước
        if (!targetChemType || targetId === sourceId) {
            target.userData.current_chemical_id = sourceId;
            target.userData.current_chemical_type = sourceChemType;
            
            target.userData.liquidLevel = (target.userData.liquidLevel || 0) + 0.003;
            if (target.userData.liquidLevel > 0.8) target.userData.liquidLevel = 0.8;
            
            const volume = pouringEffect.getOrCreateVolume(target);
            volume.position.set(0, 0, 0); // Đưa volume về đúng gốc tọa độ nội bộ của liquidGroup
            
            // Đồng bộ màu sắc dung dịch ban đầu của hóa chất
            if (source.userData.color) {
                const sourceColor = new three.Color(source.userData.color);
                volume.material.color.copy(sourceColor);
                target.userData.liquidColor = sourceColor.clone();
                volume.material.needsUpdate = true;
            }
            return;
        }

        // 2. Trường hợp trộn 2 chất khác nhau và cốc không trong trạng thái đợi đổi màu cũ kết thúc
        if (targetChemType && targetChemType !== sourceChemType && !target.userData.isReacting) {
            target.userData.isReacting = true; // Khóa tạm thời để tránh spam

            const type1 =
                source.userData.chemicalType ||
                source.userData.chemical_type;

            const type2 =
                target.userData.chemicalType ||
                target.userData.chemical_type;

            console.log("REACTION CHECK:", type1, type2);

            const reaction = detectReaction(type1, type2);

            console.log("REACTION RESULT:", reaction);

            if (reaction.has_reaction) {
                console.log("Phản ứng xảy ra!");

                // --- ĐỒNG BỘ TRẠNG THÁI HÓA CHẤT MỚI SAU PHẢN ỨNG ---
                target.userData.current_chemical_type = "generic_solution";
                target.userData.current_chemical_id = sourceId;

                const volume = pouringEffect.getOrCreateVolume(target);

                if (volume) {
                    if (reaction.gas) {
                        volume.userData.hasGasEffect = true;
                    }

                    if (reaction.explosion) {
                        createExplosion(target.position);
                    }

                    if (reaction.color) {
                        const reactionColor = new three.Color(reaction.color);

                        // Lưu màu mới
                        target.userData.liquidColor = reactionColor.clone();
                        volume.material.color.copy(reactionColor);

                        // Bắt đầu lerp
                        volume.userData.targetColor = reactionColor.clone();
                        volume.userData.isColorLerping = true;

                        // FORCE UPDATE
                        volume.material.uniformsNeedUpdate = true;
                        volume.material.needsUpdate = true;
                    }
                }

                // Gọi Mascot hiển thị câu thoại thuyết minh động
                let speechMsg = "";
                if (type1 === "alkali_metal" || type2 === "alkali_metal") {
                    speechMsg = "Wow! Phản ứng giữa Kim loại kiềm (Natri) và Nước tỏa rất nhiều nhiệt, sinh ra khí Hidro H₂ có thể gây nổ mạnh!";
                } else if (type1 === "strong_acid" || type2 === "strong_acid" || type1 === "acid" || type2 === "acid") {
                    speechMsg = "Phản ứng trung hòa Axit và Bazơ tỏa nhiệt, tạo ra muối và nước trung tính!";
                } else {
                    speechMsg = "Phản ứng hóa học đang xảy ra cực kỳ sinh động!";
                }
                triggerMascotSpeech(speechMsg);
            } else {
                // Trộn vật lý thông thường, không phản ứng -> Mở khóa cho phép thử chất khác
                target.userData.isReacting = false;
            }
        }

        // Tăng mực nước dâng lên khi đổ chất liên tục
        target.userData.liquidLevel = (target.userData.liquidLevel || 0) + 0.003;
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

        if (e.target.closest('#ui') || e.target.closest('#context-menu')) return;
        updateRaycaster(e);
        const intersects = raycaster.intersectObjects(draggableObjects, true);
        if (intersects.length > 0) {
            draggedObject = intersects[0].object.userData.root || intersects[0].object;
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

            // --- CODE MỚI THÊM: GỌI MASCOT KHI KÉO THẢ HÓA CHẤT BẰNG CHUỘT ---
            if (draggedObject.userData && draggedObject.userData.id_chemical) {
                const { name_vi } = draggedObject.userData;
                const message = `Bạn đang cầm trên tay ${name_vi}. Hãy cẩn thận nhé!`;
                if (typeof triggerMascotSpeech === 'function') {
                    triggerMascotSpeech(message);
                }
            }
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

    function checkSolidChemicalReaction(obj) {
        if (!obj) return;
        if (!obj.userData.id_chemical) return;

        draggableObjects.forEach(target => {
            if (!target || target === obj) return;

            const box1 = new three.Box3().setFromObject(obj);
            const box2 = new three.Box3().setFromObject(target);

            // KHÔNG CHẠM -> BỎ
            if (!box1.intersectsBox(box2)) return;

            const type1 = obj.userData.chemicalType || obj.userData.chemical_type;
            const type2 = target.userData.current_chemical_type || target.userData.chemicalType || target.userData.chemical_type;

            const sourceId = obj.userData.id_chemical;
            const targetId = target.userData.current_chemical_id || target.userData.id_chemical;

            if (!sourceId || !targetId) return;

            const reaction = detectReaction(type1, type2);

            console.log("SOURCE (Solid):", obj.userData);
            console.log("TARGET (Solid):", target.userData);
            console.log("REACTION (Solid):", type1, "+", type2, reaction);

            if (reaction.has_reaction) {
                console.log("REACTION!");

                // EFFECT
                const volume = pouringEffect.getOrCreateVolume(target);
                volume.position.set(0, 0, 0); // Đảm bảo volume ở vị trí chuẩn

                if (reaction.gas) {
                    volume.userData.hasGasEffect = true;
                }

                if (reaction.explosion) {
                    createExplosion(target.position);
                }

                // COLOR
                if (reaction.color) {
                    const newColor = new three.Color(reaction.color);
                    volume.material.color.copy(newColor);
                    target.userData.liquidColor = newColor.clone();
                    volume.material.uniformsNeedUpdate = true;
                    volume.material.needsUpdate = true;
                }

                // SPEECH / MASCOT
                let speechMsg = "";
                if (type1 === "alkali_metal" || type2 === "alkali_metal") {
                    speechMsg = "Wow! Phản ứng giữa Kim loại kiềm (Natri) và Nước tỏa rất nhiều nhiệt, sinh ra khí Hidro H₂ có thể gây nổ mạnh!";
                } else if (type1 === "strong_acid" || type2 === "strong_acid" || type1 === "acid" || type2 === "acid") {
                    speechMsg = "Phản ứng trung hòa Axit và Bazơ tỏa nhiệt, tạo ra muối và nước trung tính!";
                } else {
                    speechMsg = "Phản ứng hóa học đang xảy ra cực kỳ sinh động!";
                }
                triggerMascotSpeech(speechMsg);

                // LƯU TRẠNG THÁI HÓA CHẤT MỚI
                target.userData.current_chemical_type = "generic_solution";
                target.userData.current_chemical_id = sourceId;
            }
        });
    }

    window.addEventListener('pointerup', () => {
        if (draggedObject) {
            checkSolidChemicalReaction(draggedObject);
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
        const intersects = raycaster.intersectObjects(draggableObjects, true);

        if (intersects.length > 0) {
            selectedObjectForMenu = intersects[0].object.userData.root || intersects[0].object;
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
        const isSource = heldObjectLeft.userData.id_chemical;
        const isTarget = heldObjectLeft.userData.toolData;

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
        const isSource = heldObjectRight.userData.id_chemical;
        const isTarget = heldObjectRight.userData.toolData;

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
            const isSource = h.held.userData.id_chemical;

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