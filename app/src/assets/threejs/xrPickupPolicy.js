const NON_PICKUP_FLAGS = [
    'isTable',
    'isMovableTable',
    'isFurniture',
    'isFloor',
    'isGround',
    'isRoomSurface'
];

export function isXRNonPickupSurface(object) {
    let node = object;

    while (node) {
        const data = node.userData || {};
        if (NON_PICKUP_FLAGS.some(flag => data[flag] === true)) return true;
        node = node.parent;
    }

    return false;
}

export function isXRPickupTarget(object) {
    return Boolean(
        object?.isObject3D &&
        object.visible !== false &&
        object.userData?.isDeleted !== true &&
        object.userData?.toolData?.is_deleted !== true &&
        !object.userData?.ignoreInteraction &&
        !object.userData?.notDraggable &&
        !isXRNonPickupSurface(object)
    );
}
