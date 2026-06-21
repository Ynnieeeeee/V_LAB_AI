const XBOX_ID_PATTERN = /x[\s-]?box|xinput|x-input|360|microsoft.*gamepad|045e/i;

export const GRAB_BUTTONS = Object.freeze({
    left: Object.freeze([
        Object.freeze({ index: 6, name: 'xboxLT', fpsKey: 'q' }),
        Object.freeze({ index: 4, name: 'xboxLB', fpsKey: 'q' })
    ]),
    right: Object.freeze([
        Object.freeze({ index: 7, name: 'xboxRT', fpsKey: 'e' }),
        Object.freeze({ index: 5, name: 'xboxRB', fpsKey: 'e' })
    ])
});

export function getGamepadButtonValue(gamepad, index) {
    const button = gamepad?.buttons?.[index];
    if (typeof button === 'number') return Number.isFinite(button) ? button : 0;
    return Number(button?.value || (button?.pressed ? 1 : 0));
}

export function isGamepadButtonActive(gamepad, index, threshold = 0.12) {
    const button = gamepad?.buttons?.[index];
    return Boolean(button?.pressed || getGamepadButtonValue(gamepad, index) > threshold);
}

export function getXboxGrabButton(gamepad, handedness = 'right') {
    const candidates = handedness === 'left' ? GRAB_BUTTONS.left : GRAB_BUTTONS.right;
    return candidates.find(candidate => isGamepadButtonActive(gamepad, candidate.index)) || null;
}

export function hasXboxButtonLayout(gamepad) {
    return (gamepad?.buttons?.length || 0) >= 8;
}

export function isFullSizeGamepad(gamepad) {
    return hasXboxButtonLayout(gamepad) && (gamepad?.axes?.length || 0) >= 4;
}

export function isExternalGrabGamepad(gamepad, inputSource = null, options = {}) {
    if (!gamepad || gamepad.connected === false || !hasXboxButtonLayout(gamepad)) return false;

    const idMatches = XBOX_ID_PATTERN.test(gamepad.id || '');
    const standardMapping = gamepad.mapping === 'standard';
    const trackedHandController = Boolean(
        inputSource?.targetRayMode === 'tracked-pointer' &&
        (inputSource.handedness === 'left' || inputSource.handedness === 'right')
    );
    const untrackedXRSource = Boolean(
        inputSource &&
        (
            inputSource.targetRayMode === 'gaze' ||
            !inputSource.handedness ||
            inputSource.handedness === 'none'
        )
    );

    if (trackedHandController) return false;
    if (idMatches || standardMapping || untrackedXRSource) return true;

    // Chromium-based Android XR browsers sometimes expose a Bluetooth/XInput
    // pad through navigator.getGamepads() with mapping "xr-standard", an empty
    // id and no XRInputSource. Eight buttons plus two sticks identifies the
    // full-size pad without confusing the smaller tracked hand controllers.
    if (isFullSizeGamepad(gamepad)) return true;

    // Empty/non-standard IDs are common on Android. Only use the layout fallback
    // outside a tracked xr-standard hand controller, otherwise an Oculus/Vive
    // controller could be mistaken for a full Xbox pad.
    return Boolean(
        options.allowLayoutFallback &&
        !trackedHandController &&
        (gamepad.axes?.length || 0) >= 2
    );
}
