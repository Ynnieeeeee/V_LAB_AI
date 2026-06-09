import * as THREE from 'three';

function isToolLike(object) {
    return Boolean(
        object?.userData?.id_tool ||
        object?.userData?.toolData?.id_tool ||
        object?.userData?.toolType ||
        object?.userData?.isSupportStand ||
        object?.userData?.isHeatingSource
    );
}


function isHeatingSourceObject(object) {
    return Boolean(object?.userData?.isHeatingSource === true);
}

function isSupportStandObject(object) {
    return Boolean(
        object?.userData?.toolType === 'support_stand' ||
        object?.userData?.isSupportStand === true ||
        object?.userData?.canSupportTools === true
    );
}

function getBoxCenterAndSize(object) {
    object.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    return { box, center, size };
}

function isHeatingSourcePlacedUnderSupport(source, support) {
    if (!isHeatingSourceObject(source) || !isSupportStandObject(support)) return false;

    const sourceInfo = getBoxCenterAndSize(source);
    const supportInfo = getBoxCenterAndSize(support);

    const dx = sourceInfo.center.x - supportInfo.center.x;
    const dz = sourceInfo.center.z - supportInfo.center.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

    // Không dùng pivot vì pivot model Tripo/GLB có thể lệch. Lấy footprint từ bbox + metadata radius.
    const bboxRadius = Math.max(supportInfo.size.x, supportInfo.size.z) * 0.5;
    const metaRadius = Number(support?.userData?.supportRadius ?? 0);
    const allowedRadius = Math.max(0.35, metaRadius || 0, bboxRadius) + 0.18;

    // Nguồn nhiệt đặt dưới giá thường nằm trong bbox khung/chân giá đỡ.
    // Đây là overlap hợp lệ, không phải va chạm cần tách ngang.
    const sourceIsNotAboveSupport = sourceInfo.box.min.y <= supportInfo.box.max.y + 0.25;
    const sourceIsNearSupportBase = sourceInfo.box.max.y >= supportInfo.box.min.y - 0.2;

    return horizontalDistance <= allowedRadius && sourceIsNotAboveSupport && sourceIsNearSupportBase;
}

function referencesTool(reference, object) {
    return reference === object || reference === object?.uuid;
}

export function shouldIgnoreOverlap(object, other) {
    if (!object?.userData || !other?.userData) return false;

    if (object.userData.isOnSupportStand && object.userData.supportStand === other) return true;
    if (other.userData.isOnSupportStand && other.userData.supportStand === object) return true;
    if (object.userData.supportStand === other) return true;
    if (other.userData.supportStand === object) return true;

    // Nếu nhiều dụng cụ cùng nằm trên một giá đỡ, việc tách nhau do slot support xử lý,
    // không dùng collision push tự do vì sẽ làm lệch khỏi tâm/anchor.
    if (object.userData.isOnSupportStand && other.userData.isOnSupportStand && object.userData.supportStand === other.userData.supportStand) return true;

    if (object.userData.heatingSource === other) return true;
    if (other.userData.heatingSource === object) return true;

    // Nguồn nhiệt đặt dưới giá đỡ là trạng thái hợp lệ.
    // Nếu không bỏ qua cặp này, bbox của chân/khung giá đỡ sẽ đẩy nguồn nhiệt văng ngang.
    if (isHeatingSourcePlacedUnderSupport(object, other)) return true;
    if (isHeatingSourcePlacedUnderSupport(other, object)) return true;

    // Nếu dụng cụ đang nằm trên giá và nguồn nhiệt ở dưới cùng giá đó,
    // đây cũng là bố cục hợp lệ: không tách ngang nguồn nhiệt khỏi cụm giá đỡ.
    if (isHeatingSourceObject(object) && other.userData.isOnSupportStand && isHeatingSourcePlacedUnderSupport(object, other.userData.supportStand)) return true;
    if (isHeatingSourceObject(other) && object.userData.isOnSupportStand && isHeatingSourcePlacedUnderSupport(other, object.userData.supportStand)) return true;

    if (object.userData.connectedTo === other) return true;
    if (other.userData.connectedTo === object) return true;
    if ((object.userData.assemblyConnections || []).some(conn => conn.fromTool === other || conn.toTool === other)) return true;
    if ((other.userData.assemblyConnections || []).some(conn => conn.fromTool === object || conn.toTool === object)) return true;

    if (referencesTool(object.userData.parentTool, other)) return true;
    if (referencesTool(other.userData.parentTool, object)) return true;
    if (object.userData.parentToolObject === other) return true;
    if (other.userData.parentToolObject === object) return true;

    return false;
}

export function getSupportAnchorWorldPosition(support) {
    const anchor = support?.userData?.supportAnchor;
    const worldPos = new THREE.Vector3();

    if (anchor?.getWorldPosition) {
        anchor.getWorldPosition(worldPos);
    } else if (support?.getWorldPosition) {
        support.getWorldPosition(worldPos);
    }

    return worldPos;
}

function getObjectBBoxCenter(object) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    box.getCenter(center);
    return center;
}

function centerObjectXZToWorldPoint(object, targetWorldPoint) {
    if (!object?.isObject3D || !targetWorldPoint) return;
    const centerBefore = getObjectBBoxCenter(object);
    const dx = targetWorldPoint.x - centerBefore.x;
    const dz = targetWorldPoint.z - centerBefore.z;

    const beforeWorld = new THREE.Vector3();
    object.getWorldPosition(beforeWorld);
    const afterWorld = beforeWorld.clone().add(new THREE.Vector3(dx, 0, dz));
    const beforeLocal = beforeWorld.clone();
    const afterLocal = afterWorld.clone();
    object.parent?.worldToLocal?.(beforeLocal);
    object.parent?.worldToLocal?.(afterLocal);
    const localDelta = afterLocal.sub(beforeLocal);

    object.position.x += localDelta.x;
    object.position.z += localDelta.z;
    object.updateMatrixWorld(true);

    const centerAfter = getObjectBBoxCenter(object);
    console.log('[SupportSnap] container bbox center before:', centerBefore);
    console.log('[SupportSnap] container bbox center after:', centerAfter);
    console.log('[SupportSnap] deltaXZ:', dx, dz);
}

export function getSupportSlotPosition(support, index, count = 1) {
    const worldPos = getSupportAnchorWorldPosition(support);

    // Một dụng cụ thì nằm đúng tâm anchor, không offset ngang.
    if (count <= 1) return worldPos;

    const spacing = Number(support?.userData?.supportSlotSpacing ?? 0.28) || 0.28;
    return worldPos.add(new THREE.Vector3(
        (index - (count - 1) / 2) * spacing,
        0,
        0
    ));
}

export function applySupportSlotOffset(container, support) {
    if (!container?.isObject3D || !support?.isObject3D || !support.userData) return;

    support.userData.supportedTools ??= [];
    support.userData.supportedTools = support.userData.supportedTools.filter(tool =>
        tool?.parent &&
        tool.userData?.isOnSupportStand === true &&
        tool.userData?.supportStand === support
    );

    if (!support.userData.supportedTools.includes(container)) {
        support.userData.supportedTools.push(container);
    }

    const tools = support.userData.supportedTools;
    const count = tools.length;
    const index = tools.indexOf(container);
    if (index < 0) return;

    const slotWorldPos = getSupportSlotPosition(support, index, count);
    const targetLocal = slotWorldPos.clone();
    container.parent?.worldToLocal?.(targetLocal);

    // Chỉ chỉnh X/Z. Khi chỉ có 1 dụng cụ, target chính là tâm support anchor.
    container.position.x = targetLocal.x;
    container.position.z = targetLocal.z;
    container.updateMatrixWorld(true);

    // FIX mạnh: pivot container có thể lệch, nên căn tâm bounding box X/Z vào slot/anchor.
    centerObjectXZToWorldPoint(container, slotWorldPos);

    console.log('[SupportSnap] supported count:', count);
    console.log('[SupportSlot] support:', support.name || support.userData?.toolData?.name_tool_vi || support.uuid, 'tool index:', index);
}

export function resolveObjectOverlap(object, sceneObjects, options = {}) {
    const padding = options.padding ?? 0.05;
    const maxIterations = options.maxIterations ?? 5;

    if (!object?.isObject3D || !sceneObjects?.length) return;

    // Không để collision separation đẩy dụng cụ đã snap trên support, vì sẽ làm lệch khỏi tâm.
    if (object.userData?.isOnSupportStand || options.skipIfOnSupportStand) {
        console.log('[CollisionSeparation] skipped support-snapped object:', object.name || object.userData?.toolData?.name_tool_vi || object.uuid);
        return;
    }

    console.log('[CollisionSeparation] checking:', object.name || object.userData?.toolData?.name_tool_vi || object.uuid);

    for (let i = 0; i < maxIterations; i++) {
        object.updateMatrixWorld(true);
        const objectBox = new THREE.Box3().setFromObject(object);
        let resolvedAny = false;

        for (const other of sceneObjects) {
            if (!other?.isObject3D || other === object) continue;
            if (!other.visible) continue;
            if (!isToolLike(other)) continue;
            if (shouldIgnoreOverlap(object, other)) continue;

            other.updateMatrixWorld(true);
            const otherBox = new THREE.Box3().setFromObject(other);
            if (!objectBox.intersectsBox(otherBox)) continue;

            const objectCenter = new THREE.Vector3();
            const otherCenter = new THREE.Vector3();
            objectBox.getCenter(objectCenter);
            otherBox.getCenter(otherCenter);

            const direction = objectCenter.clone().sub(otherCenter);
            direction.y = 0;

            if (direction.lengthSq() < 0.0001) {
                direction.set(1, 0, 0);
            }

            direction.normalize();

            const overlapX = Math.min(objectBox.max.x, otherBox.max.x) - Math.max(objectBox.min.x, otherBox.min.x);
            const overlapZ = Math.min(objectBox.max.z, otherBox.max.z) - Math.max(objectBox.min.z, otherBox.min.z);
            const pushDistance = Math.max(0, Math.min(overlapX, overlapZ)) + padding;
            const pushWorld = direction.multiplyScalar(pushDistance);

            // Chỉ chỉnh X/Z. Nếu object có parent khác scene, đổi world push sang local delta.
            const beforeWorld = new THREE.Vector3();
            object.getWorldPosition(beforeWorld);
            const afterWorld = beforeWorld.clone().add(pushWorld);
            const beforeLocal = beforeWorld.clone();
            const afterLocal = afterWorld.clone();
            object.parent?.worldToLocal?.(beforeLocal);
            object.parent?.worldToLocal?.(afterLocal);
            const localDelta = afterLocal.sub(beforeLocal);

            object.position.x += localDelta.x;
            object.position.z += localDelta.z;
            object.updateMatrixWorld(true);

            resolvedAny = true;
            console.log('[CollisionSeparation] overlap with:', other.name || other.userData?.toolData?.name_tool_vi || other.uuid);
            console.log('[CollisionSeparation] pushed object:', object.name || object.uuid, 'away from:', other.name || other.uuid);
        }

        if (!resolvedAny) break;
    }

    console.log('[CollisionSeparation] final position:', object.position);
}
