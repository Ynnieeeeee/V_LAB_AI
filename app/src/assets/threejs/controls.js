import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as three from 'three';
import { setArmsVisibility } from './interaction.js?v=20260618-add-table3';

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
    const xrMoveSpeed = moveSpeed * 60;
    const xrTurnSpeed = 1.8;
    const xrDeadzone = 0.15;
    const xrEyeHeight = 2.8;
    const xrControllers = { left: null, right: null };
    const direction = new three.Vector3();
    const rightDirection = new three.Vector3();
    const upDirection = new three.Vector3(0, 1, 0);
    const velocity = new three.Vector3();
    let wasXRPresenting = false;
    let isXRHandHolding = () => false;

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

    const getStickAxes = (controller) => {
        const axes = controller?.userData?.inputSource?.gamepad?.axes || controller?.userData?.gamepad?.axes || [];
        const xPrimary = axes[2] ?? 0;
        const yPrimary = axes[3] ?? 0;
        const xFallback = axes[0] ?? 0;
        const yFallback = axes[1] ?? 0;

        if (Math.abs(xPrimary) > xrDeadzone || Math.abs(yPrimary) > xrDeadzone) {
            return { x: xPrimary, y: yPrimary };
        }

        return { x: xFallback, y: yFallback };
    };

    const applyDeadzone = (value) => Math.abs(value) > xrDeadzone ? value : 0;

    const updateXRPresentationState = (isPresenting) => {
        if (isPresenting) {
            cameraGroup.position.y = xrEyeHeight;
            if (crosshair) crosshair.classList.add('hidden');
            setArmsVisibility(false);
        } else if (wasXRPresenting) {
            cameraGroup.position.y = 0;
            if (!fps.isLocked && crosshair) crosshair.classList.add('hidden');
            if (!fps.isLocked) setArmsVisibility(false);
        }

        wasXRPresenting = isPresenting;
    };

    const connectXRController = (controller, inputSource) => {
        const handedness = inputSource?.handedness;
        if (handedness !== 'left' && handedness !== 'right') return;

        controller.name = handedness === 'left' ? 'Left Controller' : 'Right Controller';
        controller.userData.handedness = handedness;
        controller.userData.inputSource = inputSource;
        controller.userData.gamepad = inputSource?.gamepad || null;
        if (controller.userData.grip?.userData) {
            controller.userData.grip.userData.handedness = handedness;
            controller.userData.grip.userData.inputSource = inputSource;
            controller.userData.grip.userData.gamepad = inputSource?.gamepad || null;
        }
        xrControllers[handedness] = controller;
    };

    const disconnectXRController = (controller) => {
        if (xrControllers.left === controller) xrControllers.left = null;
        if (xrControllers.right === controller) xrControllers.right = null;

        controller.userData.handedness = null;
        controller.userData.inputSource = null;
        controller.userData.gamepad = null;
        if (controller.userData.grip?.userData) {
            controller.userData.grip.userData.handedness = null;
            controller.userData.grip.userData.inputSource = null;
            controller.userData.grip.userData.gamepad = null;
        }
    };

    const updateXRMovement = (delta) => {
        const leftAxes = getStickAxes(xrControllers.left);
        const rightAxes = isXRHandHolding('any') ? { x: 0, y: 0 } : getStickAxes(xrControllers.right);
        const moveX = applyDeadzone(leftAxes.x);
        const moveY = applyDeadzone(leftAxes.y);
        const turnX = applyDeadzone(rightAxes.x);
        let isMoving = false;

        if (turnX) {
            cameraGroup.rotation.y -= turnX * xrTurnSpeed * delta;
            isMoving = true;
        }

        if (moveX || moveY) {
            camera.getWorldDirection(direction);
            direction.y = 0;

            if (direction.lengthSq() > 0) {
                direction.normalize();
                rightDirection.crossVectors(direction, upDirection).normalize();

                cameraGroup.position.addScaledVector(direction, -moveY * xrMoveSpeed * delta);
                cameraGroup.position.addScaledVector(rightDirection, moveX * xrMoveSpeed * delta);
                cameraGroup.position.y = xrEyeHeight;
                isMoving = true;
            }
        }

        return isMoving;
    };

    const setXRHandHoldingProvider = (provider) => {
        isXRHandHolding = typeof provider === 'function' ? provider : () => false;
    };

    return {
        orbit,
        fps,
        updateMovement,
        updateXRPresentationState,
        connectXRController,
        disconnectXRController,
        updateXRMovement,
        setXRHandHoldingProvider
    };
}
