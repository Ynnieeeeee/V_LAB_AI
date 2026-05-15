import * as three from 'three';
import { triggerMascotSpeech } from './mascot.js';
import { PouringEffect } from './pouringEffect.js';
import { cameraGroup } from './camera.js';

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
let isPouringAction = false; // Trạng thái đang đổ chung

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
    const armGeo = new three.CylinderGeometry(0.045, 0.065, 0.8, 16);
    const armMesh = new three.Mesh(armGeo, skinMaterial);
    armMesh.rotation.x = Math.PI / 2;
    armMesh.position.z = -0.4;
    armGroup.add(armMesh);

    // Bàn tay (Palm)
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

    armGroup.position.set(isRight ? 0.45 : -0.45, -0.5, -0.2);
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
                    root.position.set(0, 0.1, 0);
                    root.rotation.set(0, Math.PI / 2, 0);

                    // Scale khi cầm trên tay (nhỏ đi một chút)
                    const s = root.userData.originalWorldScale * 0.7;
                    root.scale.set(s, s, s);

                    // --- CODE MỚI THÊM: GỌI MASCOT KHI CẦM HÓA CHẤT ---
                    if (root.userData && root.userData.id_chemical) {
                        const { name_vi } = root.userData;
                        const message = `Bạn đang cầm trên tay ${name_vi}. Hãy cẩn thận khi đổ vào ống nghiệm nhé!`;
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
            console.log("Phím Space được nhấn, đối tượng đang cầm/kéo:", heldObj ? heldObj.userData : "null");
            if (heldObj && heldObj.userData.id_chemical) {
                isPouringAction = true;
                // Animation xoay lọ sẽ được xử lý liên tục trong updateArmsAnimation

                // 2. Kích hoạt hiệu ứng hạt tại miệng lọ
                const box = new three.Box3().setFromObject(heldObj);
                const pourPoint = new three.Vector3(
                    (box.min.x + box.max.x) / 2,
                    box.max.y,
                    (box.min.z + box.max.z) / 2
                );
                console.log("Bắt đầu đổ tại vị trí thế giới:", pourPoint, "Màu:", heldObj.userData.color);

                pouringEffect.start(pourPoint, heldObj.userData.color || 0xffffff);
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
    window.checkPouringCollision = () => {
        if (!pouringEffect || !pouringEffect.isPouring) return;

        const sourceObj = heldObjectRight || heldObjectLeft || draggedObject;
        if (!sourceObj || !sourceObj.userData.id_chemical) return;

        // Xác định tay còn lại đang cầm gì
        const otherHandObj = (sourceObj === heldObjectRight) ? heldObjectLeft : (sourceObj === heldObjectLeft ? heldObjectRight : null);

        // 1. Lấy vị trí miệng lọ dựa trên Bounding Box
        const box = new three.Box3().setFromObject(sourceObj);
        const pourPoint = new three.Vector3(
            (box.min.x + box.max.x) / 2,
            box.max.y,
            (box.min.z + box.max.z) / 2
        );

        // 2. ƯU TIÊN KIỂM TRA ĐỔ VÀO TAY CÒN LẠI
        if (otherHandObj && otherHandObj.userData.toolData) {
            const targetPos = new three.Vector3();
            otherHandObj.getWorldPosition(targetPos);

            const dist = pourPoint.distanceTo(targetPos);
            // Tăng khoảng cách lên 1.2m để dễ kích hoạt hơn khi cầm 2 tay
            if (dist < 1.2) {
                if (otherHandObj !== lastPouredTarget) {
                    console.log("Phát hiện đổ tay-sang-tay! Khoảng cách:", dist);
                    lastPouredTarget = otherHandObj;
                    handlePourSuccess(sourceObj, otherHandObj, true);
                }
                return;
            }
        }

        // 3. NẾU KHÔNG ĐỔ VÀO TAY, KIỂM TRA ĐỔ VÀO DỤNG CỤ TRÊN BÀN (Raycast)
        const ray = new three.Raycaster(pourPoint, new three.Vector3(0, -1, 0), 0, 0.5);
        ray.camera = camera;

        const targets = draggableObjects.filter(obj => obj !== sourceObj && obj !== otherHandObj);
        const intersects = ray.intersectObjects(targets, true);

        if (intersects.length > 0) {
            const hit = intersects[0];
            const target = hit.object.userData.root || hit.object;

            if (target !== lastPouredTarget && target.userData.toolData) {
                lastPouredTarget = target;
                handlePourSuccess(sourceObj, target, false);
            }
        }
    };

    // Hàm phụ xử lý khi đổ thành công
    function handlePourSuccess(source, target, isHandToHand) {
        const chemName = source.userData.name_vi;
        const toolName = target.userData.toolData.name_tool_vi;
        const color = source.userData.color || "#ffffff";

        // Hiệu ứng đổi màu
        target.traverse(node => {
            if (node.isMesh && (node.name.toLowerCase().includes('liquid') || node.material.name.toLowerCase().includes('liquid'))) {
                node.material.color.set(color);
            } else if (node.isMesh && target.userData.toolData.material_type === 'GLASS') {
                if (node.material.attenuationColor) node.material.attenuationColor.set(color);
            }
        });

        // Mascot thông báo
        let message = `Bạn đang đổ **${chemName}** vào **${toolName}**.`;
        if (isHandToHand) {
            message = `Khéo léo lắm! Bạn đang đổ trực tiếp **${chemName}** từ tay này sang **${toolName}** ở tay kia.`;
        }

        if (typeof triggerMascotSpeech === 'function') {
            triggerMascotSpeech(message);
        }
        console.log(`Đã đổ ${chemName} vào ${toolName} (${isHandToHand ? 'Tay-Tay' : 'Tay-Bàn'})`);
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
                const message = `Bạn đang cầm trên tay ${name_vi}. Hãy cẩn thận khi đổ vào ống nghiệm nhé!`;
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
        // Nếu tay trái cầm dụng cụ, đưa vào sát giữa hơn
        if (heldObjectLeft.userData.toolData) {
            targetPosLeft.set(-0.05, -0.3, -0.4);
            targetRotLeft.set(0.1, 0.3, 0);
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
        // Nếu tay phải cầm hóa chất, đưa sát vào tay trái hơn
        if (heldObjectRight.userData.id_chemical) {
            targetPosRight.set(0.05, -0.15, -0.45);
            targetRotRight.set(0.2, -0.7, 0);
        }
    }

    rightArm.position.lerp(targetPosRight, lerpSpeed);
    rightArm.rotation.x = three.MathUtils.lerp(rightArm.rotation.x, targetRotRight.x, lerpSpeed);
    rightArm.rotation.y = three.MathUtils.lerp(rightArm.rotation.y, targetRotRight.y, lerpSpeed);
    rightArm.rotation.z = three.MathUtils.lerp(rightArm.rotation.z, targetRotRight.z, lerpSpeed);

    // --- FORCE BOTTLE TILT DURING POURING ---
    const heldObj = heldObjectRight || heldObjectLeft;
    if (heldObj && isPouringAction) {
        const tiltTarget = heldObjectRight ? -Math.PI / 2 : Math.PI / 2;
        heldObj.rotation.z = three.MathUtils.lerp(heldObj.rotation.z, tiltTarget, 0.2);
    } else if (heldObj) {
        heldObj.rotation.z = three.MathUtils.lerp(heldObj.rotation.z, 0, 0.2);
    }

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