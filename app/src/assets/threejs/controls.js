import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as three from 'three';
import { setArmsVisibility } from './interaction.js?v=20260527-liquid-soft-waves';

function isEditableTarget(event) {
    const target = event?.target;
    if (!target) return false;
    return Boolean(
        target.isContentEditable ||
        target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
    );
}

export function initControls(camera, domElement, cameraGroup) {
    const orbit = new OrbitControls(camera, domElement);
    orbit.enableDamping = true;

    const fps = new PointerLockControls(camera, document.body);

    // Trạng thái phím nhấn
    const keys = { forward: false, backward: false, left: false, right: false };
    const moveSpeed = 0.1;
    const direction = new three.Vector3();
    const velocity = new three.Vector3();

    // Lắng nghe sự kiện bàn phím
    const onKeyDown = (event) => {
        if (isEditableTarget(event)) return;
        switch (event.code) {
            case 'ArrowUp':
            case 'KeyW': keys.forward = true; break;
            case 'ArrowLeft':
            case 'KeyA': keys.left = true; break;
            case 'ArrowDown':
            case 'KeyS': keys.backward = true; break;
            case 'ArrowRight':
            case 'KeyD': keys.right = true; break;
        }
    };

    const onKeyUp = (event) => {
        if (isEditableTarget(event)) return;
        switch (event.code) {
            case 'ArrowUp':
            case 'KeyW': keys.forward = false; break;
            case 'ArrowLeft':
            case 'KeyA': keys.left = false; break;
            case 'ArrowDown':
            case 'KeyS': keys.backward = false; break;
            case 'ArrowRight':
            case 'KeyD': keys.right = false; break;
        }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    const crosshair = document.getElementById('crosshair');

    fps.addEventListener('lock', () => { 
        orbit.enabled = false; 
        if (crosshair) crosshair.classList.remove('hidden');
        setArmsVisibility(true);
    });
    fps.addEventListener('unlock', () => { 
        orbit.enabled = true; 
        if (crosshair) crosshair.classList.add('hidden');
        setArmsVisibility(false);
    });

    // Mặc định ẩn tay khi khởi tạo
    setArmsVisibility(false);


    // Hàm cập nhật di chuyển (sẽ gọi trong vòng lặp animate)
    const updateMovement = () => {
        if (!fps.isLocked) return false;

        velocity.set(0, 0, 0);
        let isMoving = false;

        // Tính toán hướng tiến/lùi dựa trên hướng nhìn của camera (phẳng trên mặt đất)
        if (keys.forward) { velocity.z -= moveSpeed; isMoving = true; }
        if (keys.backward) { velocity.z += moveSpeed; isMoving = true; }
        if (keys.left) { velocity.x -= moveSpeed; isMoving = true; }
        if (keys.right) { velocity.x += moveSpeed; isMoving = true; }

        // Di chuyển cameraGroup dựa trên hướng nhìn cục bộ của camera
        fps.moveForward(-velocity.z);
        fps.moveRight(velocity.x);
        
        // Đảm bảo người chơi luôn ở trên mặt đất (Y=0)
        cameraGroup.position.y = 0; 

        return isMoving;
    };

    return { orbit, fps, updateMovement };
}
