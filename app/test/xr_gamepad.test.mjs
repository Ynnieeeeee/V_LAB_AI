import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getXboxGrabButton,
    isExternalGrabGamepad
} from '../src/assets/threejs/xrGamepad.js';

function makeGamepad({ id = '', mapping = 'standard', axes = [0, 0, 0, 0], pressed = [] } = {}) {
    const buttons = Array.from({ length: 16 }, (_, index) => ({
        pressed: pressed.includes(index),
        value: pressed.includes(index) ? 1 : 0
    }));
    return { id, mapping, axes, buttons, connected: true, index: 0 };
}

test('maps LT/LB to the left hand and RT/RB to the right hand', () => {
    assert.equal(getXboxGrabButton(makeGamepad({ pressed: [6] }), 'left')?.name, 'xboxLT');
    assert.equal(getXboxGrabButton(makeGamepad({ pressed: [4] }), 'left')?.name, 'xboxLB');
    assert.equal(getXboxGrabButton(makeGamepad({ pressed: [7] }), 'right')?.name, 'xboxRT');
    assert.equal(getXboxGrabButton(makeGamepad({ pressed: [5] }), 'right')?.name, 'xboxRB');
});

test('accepts an Xbox pad wrapped by WebXR as xr-standard gaze input', () => {
    const gamepad = makeGamepad({ mapping: 'xr-standard', pressed: [7] });
    const inputSource = { handedness: 'none', targetRayMode: 'gaze', gamepad };

    assert.equal(isExternalGrabGamepad(gamepad, inputSource), true);
    assert.equal(getXboxGrabButton(gamepad, 'right')?.name, 'xboxRT');
});

test('does not mistake a tracked xr-standard hand controller for an Xbox pad', () => {
    const gamepad = makeGamepad({ mapping: 'xr-standard' });
    const inputSource = { handedness: 'right', targetRayMode: 'tracked-pointer', gamepad };

    assert.equal(isExternalGrabGamepad(gamepad, inputSource), false);
});

test('accepts a full-size xr-standard pad exposed only through Gamepad API', () => {
    const gamepad = makeGamepad({ id: '', mapping: 'xr-standard', pressed: [6] });

    assert.equal(isExternalGrabGamepad(gamepad, null, { allowLayoutFallback: true }), true);
    assert.equal(getXboxGrabButton(gamepad, 'left')?.name, 'xboxLT');
});

test('keeps rejecting a tracked hand controller even when it has eight buttons', () => {
    const gamepad = makeGamepad({ mapping: 'xr-standard', pressed: [7] });
    const inputSource = { handedness: 'right', targetRayMode: 'tracked-pointer', gamepad };

    assert.equal(isExternalGrabGamepad(gamepad, inputSource, { allowLayoutFallback: true }), false);
});
