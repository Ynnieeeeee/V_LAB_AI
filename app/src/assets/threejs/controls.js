import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as three from 'three';
import { setArmsVisibility } from './interaction.js?v=20260621-xr-input-v23';
import { isExternalGrabGamepad } from './xrGamepad.js?v=20260621-xr-input-v23';

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
    const xrLookPitchSpeed = 1.4;
    const xrMaxLookPitch = three.MathUtils.degToRad(65);
    const xrDeadzone = 0.15;
    const xrEyeHeight = 2.8;
    const xrControllers = { left: null, right: null, gamepad: null };
    const direction = new three.Vector3();
    const rightDirection = new three.Vector3();
    const upDirection = new three.Vector3(0, 1, 0);
    const velocity = new three.Vector3();
    let wasXRPresenting = false;
    let xrLookPitch = 0;
    let isXRHandHolding = () => false;
    const connectedGamepads = new Map();

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
        const xbox360Gamepad = getXbox360Gamepad();
        const xboxMoveAxes = getGamepadStickAxes(xbox360Gamepad, 'left');

        // Tính toán hướng tiến/lùi dựa trên hướng nhìn của camera (phẳng trên mặt đất)
        if (keys.forward) { velocity.z -= moveSpeed; isMoving = true; }
        if (keys.backward) { velocity.z += moveSpeed; isMoving = true; }
        if (keys.left) { velocity.x -= moveSpeed; isMoving = true; }
        if (keys.right) { velocity.x += moveSpeed; isMoving = true; }
        if (Math.abs(xboxMoveAxes.y) > xrDeadzone) { velocity.z += xboxMoveAxes.y * moveSpeed; isMoving = true; }
        if (Math.abs(xboxMoveAxes.x) > xrDeadzone) { velocity.x += xboxMoveAxes.x * moveSpeed; isMoving = true; }

        // Di chuyển cameraGroup dựa trên hướng nhìn cục bộ của camera
        fps.moveForward(-velocity.z);
        fps.moveRight(velocity.x);
        
        // Đảm bảo người chơi luôn ở trên mặt đất (Y=0)
        cameraGroup.position.y = 0; 

        return isMoving;
    };

    const getControllerGamepad = (controller) =>
        controller?.userData?.inputSource?.gamepad ||
        controller?.userData?.gamepad ||
        null;

    const hasAxesInput = (axes) =>
        Math.abs(axes?.x || 0) > xrDeadzone ||
        Math.abs(axes?.y || 0) > xrDeadzone;

    const rememberGamepad = (gamepad) => {
        if (!gamepad) return;
        const key = Number.isFinite(gamepad.index) ? gamepad.index : gamepad;
        connectedGamepads.set(key, gamepad);
    };

    window.addEventListener('gamepadconnected', event => rememberGamepad(event.gamepad));
    window.addEventListener('gamepaddisconnected', event => {
        const gamepad = event.gamepad;
        const key = Number.isFinite(gamepad?.index) ? gamepad.index : gamepad;
        connectedGamepads.delete(key);
    });

    const getBrowserGamepads = () => {
        if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
            Array.from(navigator.getGamepads()).filter(Boolean).forEach(rememberGamepad);
        }
        return Array.from(connectedGamepads.values()).filter(gamepad => gamepad?.connected !== false);
    };

    const getExternalXRGamepad = () => {
        const gamepads = getBrowserGamepads().filter(gamepad =>
            gamepad?.connected !== false &&
            ((gamepad.axes?.length || 0) >= 2 || (gamepad.buttons?.length || 0) > 0)
        );

        return gamepads.find(gamepad =>
            isExternalGrabGamepad(gamepad, null, { allowLayoutFallback: true })
        ) || null;
    };

    const getXbox360Gamepad = () => {
        const externalGamepad = getExternalXRGamepad();
        const candidates = [
            externalGamepad,
            getControllerGamepad(xrControllers.gamepad),
            getControllerGamepad(xrControllers.left),
            getControllerGamepad(xrControllers.right)
        ].filter((gamepad, index, items) => gamepad && items.indexOf(gamepad) === index);

        return candidates.find(gamepad => {
            const controller = [xrControllers.gamepad, xrControllers.left, xrControllers.right]
                .find(item => getControllerGamepad(item) === gamepad);
            return isExternalGrabGamepad(
                gamepad,
                controller?.userData?.inputSource || null,
                { allowLayoutFallback: true }
            );
        }) || null;
    };

    const isGamepadButtonPressed = (gamepad, index) => {
        const button = gamepad?.buttons?.[index];
        if (typeof button === 'number') return button > 0.2;
        return Boolean(button?.pressed || Number(button?.value || 0) > 0.2);
    };

    const getDPadAxes = (gamepad) => ({
        x: (isGamepadButtonPressed(gamepad, 15) ? 1 : 0) - (isGamepadButtonPressed(gamepad, 14) ? 1 : 0),
        y: (isGamepadButtonPressed(gamepad, 13) ? 1 : 0) - (isGamepadButtonPressed(gamepad, 12) ? 1 : 0)
    });

    const getGamepadStickAxes = (gamepad, stick = 'auto') => {
        const axes = gamepad?.axes || [];
        const leftAxes = { x: axes[0] ?? 0, y: axes[1] ?? 0 };
        const rightAxes = { x: axes[2] ?? 0, y: axes[3] ?? 0 };

        if (stick === 'left') {
            const dpadAxes = getDPadAxes(gamepad);
            return hasAxesInput(leftAxes) || !hasAxesInput(dpadAxes) ? leftAxes : dpadAxes;
        }

        if (stick === 'right') {
            return hasAxesInput(rightAxes) || axes.length >= 4 ? rightAxes : leftAxes;
        }

        if (hasAxesInput(rightAxes)) return rightAxes;
        if (hasAxesInput(leftAxes)) return leftAxes;

        const dpadAxes = getDPadAxes(gamepad);
        return hasAxesInput(dpadAxes) ? dpadAxes : leftAxes;
    };

    const getStickAxes = (controller, stick = 'auto') =>
        getGamepadStickAxes(getControllerGamepad(controller), stick);

    const getExternalXRGamepadAxes = (stick = 'left') =>
        getGamepadStickAxes(getExternalXRGamepad(), stick);

    const getFirstActiveAxes = (...axisGroups) =>
        axisGroups.find(hasAxesInput) || { x: 0, y: 0 };

    const applyDeadzone = (value) => Math.abs(value) > xrDeadzone ? value : 0;

    const updateXRPresentationState = (isPresenting) => {
        if (isPresenting) {
            cameraGroup.position.y = xrEyeHeight;
            if (crosshair) crosshair.classList.add('hidden');
            setArmsVisibility(false);
        } else if (wasXRPresenting) {
            cameraGroup.position.y = 0;
            xrLookPitch = 0;
            camera.rotation.x = 0;
            if (!fps.isLocked && crosshair) crosshair.classList.add('hidden');
            if (!fps.isLocked) setArmsVisibility(false);
        }

        wasXRPresenting = isPresenting;
    };

    const connectXRController = (controller, inputSource) => {
        const rawHandedness = inputSource?.handedness;
        const inputGamepad = inputSource?.gamepad || null;
        const handedness = rawHandedness === 'left' || rawHandedness === 'right'
            ? rawHandedness
            : (controller?.userData?.slot === 1 ? 'left' : 'right');
        // Cardboard/phone gaze inputs normally report handedness "none". They
        // still emit valid select events and must not be mistaken for an Xbox
        // pad. Only full-size gamepads use the separate polling path.
        const isGenericGamepadInput = isExternalGrabGamepad(
            inputGamepad,
            inputSource,
            { allowLayoutFallback: false }
        );

        controller.name = handedness === 'left' ? 'Left Controller' : 'Right Controller';
        controller.userData.handedness = handedness;
        controller.userData.inputSource = inputSource;
        controller.userData.gamepad = inputGamepad;
        controller.userData.isGenericGamepadInput = isGenericGamepadInput;
        controller.userData.isGazeSelectInput =
            !isGenericGamepadInput &&
            (inputSource?.targetRayMode === 'gaze' || rawHandedness === 'none');
        if (controller.userData.grip?.userData) {
            controller.userData.grip.userData.handedness = handedness;
            controller.userData.grip.userData.inputSource = inputSource;
            controller.userData.grip.userData.gamepad = inputGamepad;
            controller.userData.grip.userData.isGenericGamepadInput = controller.userData.isGenericGamepadInput;
            controller.userData.grip.userData.isGazeSelectInput = controller.userData.isGazeSelectInput;
        }
        xrControllers[handedness] = controller;
        if (controller.userData.isGenericGamepadInput) xrControllers.gamepad = controller;
    };

    const disconnectXRController = (controller) => {
        if (xrControllers.left === controller) xrControllers.left = null;
        if (xrControllers.right === controller) xrControllers.right = null;
        if (xrControllers.gamepad === controller) xrControllers.gamepad = null;

        controller.userData.handedness = null;
        controller.userData.inputSource = null;
        controller.userData.gamepad = null;
        controller.userData.isGenericGamepadInput = false;
        controller.userData.isGazeSelectInput = false;
        if (controller.userData.grip?.userData) {
            controller.userData.grip.userData.handedness = null;
            controller.userData.grip.userData.inputSource = null;
            controller.userData.grip.userData.gamepad = null;
            controller.userData.grip.userData.isGenericGamepadInput = false;
            controller.userData.grip.userData.isGazeSelectInput = false;
        }
    };

    const updateXRMovement = (delta) => {
        const xbox360Gamepad = getXbox360Gamepad();

        const leftAxes = getFirstActiveAxes(
            getGamepadStickAxes(xbox360Gamepad, 'left'),
            getStickAxes(xrControllers.left),
            getStickAxes(xrControllers.gamepad, 'left')
        );
        const shouldReserveRightStick = isXRHandHolding('any') || isXRHandHolding('right');
        const rightAxes = shouldReserveRightStick ? { x: 0, y: 0 } : getFirstActiveAxes(
            getGamepadStickAxes(xbox360Gamepad, 'right'),
            getStickAxes(xrControllers.right),
            getStickAxes(xrControllers.gamepad, 'right')
        );
        const moveX = applyDeadzone(leftAxes.x);
        const moveY = applyDeadzone(leftAxes.y);
        const turnX = applyDeadzone(rightAxes.x);
        const lookY = applyDeadzone(rightAxes.y);
        let isMoving = false;

        if (turnX) {
            cameraGroup.rotation.y -= turnX * xrTurnSpeed * delta;
            isMoving = true;
        }

        if (lookY) {
            xrLookPitch = three.MathUtils.clamp(
                xrLookPitch - lookY * xrLookPitchSpeed * delta,
                -xrMaxLookPitch,
                xrMaxLookPitch
            );
            camera.rotation.x = xrLookPitch;
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
        getExternalXRGamepad,
        getExternalXRGamepadAxes,
        setXRHandHoldingProvider,
        isXRHandHolding: (handedness = 'any') => isXRHandHolding(handedness)
    };
}
