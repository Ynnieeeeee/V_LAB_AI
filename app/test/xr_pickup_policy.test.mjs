import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isXRNonPickupSurface,
    isXRPickupTarget
} from '../src/assets/threejs/xrPickupPolicy.js';

function object3D(userData = {}, parent = null) {
    return { isObject3D: true, visible: true, userData, parent };
}

test('rejects a table root and every mesh below it', () => {
    const table = object3D({ isTable: true, isFurniture: true });
    const tableTop = object3D({}, table);

    assert.equal(isXRNonPickupSurface(tableTop), true);
    assert.equal(isXRPickupTarget(table), false);
    assert.equal(isXRPickupTarget(tableTop), false);
});

test('rejects the room mesh used as the visible VR floor', () => {
    const room = object3D({ isRoomSurface: true });

    assert.equal(isXRNonPickupSurface(room), true);
    assert.equal(isXRPickupTarget(room), false);
});

test('keeps ordinary tools and chemical bottles pickup-enabled', () => {
    const tool = object3D({ toolData: { name_tool_vi: 'C\u1ed1c th\u00ed nghi\u1ec7m' } });
    const bottle = object3D({ id_chemical: 'hcl' });

    assert.equal(isXRPickupTarget(tool), true);
    assert.equal(isXRPickupTarget(bottle), true);
});

test('rejects a movable table even though it is draggable on desktop', () => {
    const movableTable = object3D({ isTable: true, isMovableTable: true });

    assert.equal(isXRPickupTarget(movableTable), false);
});
