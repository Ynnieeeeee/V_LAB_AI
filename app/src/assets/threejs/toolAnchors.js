import * as THREE from 'three';

const EPSILON = 1e-6;
const DEFAULT_TABLE_Y = 1.6;

export const ASSEMBLY_SLOT_TYPES = {
    TOP: 'top_slot',
    BOTTOM: 'bottom_slot',
    CENTER: 'center_slot',
    HEAT: 'heat_slot',
    HOLDER: 'holder_slot',
    CONTAINER: 'container_slot'
};

function appWindow() {
    return typeof window !== 'undefined' ? window : {};
}

function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return value.split(',').map(item => item.trim()).filter(Boolean);
        }
    }
    return [];
}

export function normalizeObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

export function getTableSurfaceY() {
    const win = appWindow();
    const explicit = Number(win.TABLE_Y ?? win.tableY);
    if (Number.isFinite(explicit)) return explicit;

    const tableObject = win.tableObject || win.labTable || win.tableMesh;
    if (tableObject?.isObject3D) {
        tableObject.updateMatrixWorld?.(true);
        const box = new THREE.Box3().setFromObject(tableObject);
        if (Number.isFinite(box.max.y)) return box.max.y;
    }

    return DEFAULT_TABLE_Y;
}

function shouldIgnoreForBounds(child, options = {}) {
    if (options.includeEffects) return false;
    return Boolean(
        child?.userData?.ignoreInteraction ||
        child?.userData?.isInternalChemicalVisual ||
        child?.userData?.isReactionEffect ||
        child?.userData?.notDraggable ||
        child?.name === 'heating_source_visual'
    );
}

export function getToolWorldBox(object, options = {}) {
    const box = new THREE.Box3();
    if (!object?.isObject3D) return box;

    object.updateMatrixWorld?.(true);
    object.traverse?.(child => {
        if (!child?.visible || !child.isMesh || shouldIgnoreForBounds(child, options)) return;
        box.expandByObject(child);
    });

    if (box.isEmpty()) box.setFromObject(object);
    return box;
}

export function getToolBoxInfo(object, options = {}) {
    const box = getToolWorldBox(object, options);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();

    if (box.isEmpty()) {
        object?.getWorldPosition?.(center);
        return {
            box,
            center,
            size,
            topCenter: center.clone(),
            bottomCenter: center.clone()
        };
    }

    box.getCenter(center);
    box.getSize(size);
    return {
        box,
        center,
        size,
        topCenter: new THREE.Vector3(center.x, box.max.y, center.z),
        bottomCenter: new THREE.Vector3(center.x, box.min.y, center.z)
    };
}

function vectorFromSnapPoint(point) {
    const value = point?.localPosition || point?.position;
    if (!value) return null;
    return new THREE.Vector3(
        finiteNumber(value.x),
        finiteNumber(value.y),
        finiteNumber(value.z)
    );
}

function makeAutoSnapPoint(tool, type, worldPosition, options = {}) {
    const localPosition = tool.worldToLocal(worldPosition.clone());
    return {
        type,
        name: options.name || type,
        position: localPosition.clone(),
        localPosition: localPosition.clone(),
        positionSpace: 'local',
        source: options.source || 'auto_bbox',
        generated: true
    };
}

function collectWorldVertices(object, maxVertices = 6000) {
    const vertices = [];
    object?.updateMatrixWorld?.(true);
    object?.traverse?.(child => {
        if (!child?.visible || !child.isMesh || shouldIgnoreForBounds(child)) return;
        const attr = child.geometry?.attributes?.position;
        if (!attr?.count) return;

        const stride = Math.max(1, Math.ceil(attr.count / Math.max(1, Math.floor(maxVertices / 4))));
        const vertex = new THREE.Vector3();
        for (let i = 0; i < attr.count; i += stride) {
            vertex.fromBufferAttribute(attr, i).applyMatrix4(child.matrixWorld);
            if (Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z)) {
                vertices.push(vertex.clone());
            }
        }
    });
    return vertices;
}

function detectNeckWorldPosition(tool, info) {
    const height = info.size.y;
    if (!Number.isFinite(height) || height < EPSILON) return info.center.clone();

    const vertices = collectWorldVertices(tool);
    if (vertices.length < 24) return info.center.clone();

    const minY = info.box.min.y + height * 0.18;
    const maxY = info.box.max.y - height * 0.12;
    if (maxY <= minY) return info.center.clone();

    const slices = 18;
    const thickness = Math.max(height / slices, 0.01);
    let best = null;

    for (let i = 1; i < slices; i++) {
        const y = minY + (maxY - minY) * (i / slices);
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let count = 0;

        for (const vertex of vertices) {
            if (Math.abs(vertex.y - y) > thickness) continue;
            minX = Math.min(minX, vertex.x);
            maxX = Math.max(maxX, vertex.x);
            minZ = Math.min(minZ, vertex.z);
            maxZ = Math.max(maxZ, vertex.z);
            count++;
        }

        if (count < 8) continue;
        const diameter = Math.max(maxX - minX, maxZ - minZ);
        if (!Number.isFinite(diameter) || diameter < EPSILON) continue;

        const centerBias = Math.abs(y - info.center.y) / Math.max(height, EPSILON);
        const score = diameter + centerBias * 0.025;
        if (!best || score < best.score) {
            best = {
                score,
                worldPosition: new THREE.Vector3(
                    (minX + maxX) * 0.5,
                    y,
                    (minZ + maxZ) * 0.5
                )
            };
        }
    }

    return best?.worldPosition || info.center.clone();
}

export function detectAutoSnapPoints(tool, options = {}) {
    if (!tool?.isObject3D || !tool.userData) return [];
    if (Array.isArray(tool.userData.snapPoints) && tool.userData.snapPoints.length && !options.force) {
        return tool.userData.snapPoints;
    }

    tool.updateMatrixWorld?.(true);
    const info = getToolBoxInfo(tool);
    if (info.box.isEmpty()) {
        const fallback = getObjectWorldPosition(tool);
        tool.userData.snapPoints = [
            makeAutoSnapPoint(tool, 'mouth', fallback, { name: 'mouth' }),
            makeAutoSnapPoint(tool, 'neck', fallback, { name: 'neck' }),
            makeAutoSnapPoint(tool, 'bottom', fallback, { name: 'bottom' })
        ];
        return tool.userData.snapPoints;
    }

    const mouth = new THREE.Vector3(info.center.x, info.box.max.y, info.center.z);
    const neck = detectNeckWorldPosition(tool, info);
    const bottom = new THREE.Vector3(info.center.x, info.box.min.y, info.center.z);

    tool.userData.snapPoints = [
        makeAutoSnapPoint(tool, 'mouth', mouth, { name: 'mouth' }),
        makeAutoSnapPoint(tool, 'neck', neck, { name: 'neck', source: 'auto_geometry_slice' }),
        makeAutoSnapPoint(tool, 'bottom', bottom, { name: 'bottom' })
    ];
    return tool.userData.snapPoints;
}

export function ensureAutoSnapPoints(tool, options = {}) {
    return detectAutoSnapPoints(tool, options);
}

export function getSnapPointWorldPosition(tool, point) {
    if (!tool?.isObject3D || !point) return null;
    const explicitWorld = point.worldPosition;
    if (point.positionSpace === 'world' && explicitWorld) {
        return new THREE.Vector3(
            finiteNumber(explicitWorld.x),
            finiteNumber(explicitWorld.y),
            finiteNumber(explicitWorld.z)
        );
    }

    if (point.positionSpace === 'world' && point.position) {
        return new THREE.Vector3(
            finiteNumber(point.position.x),
            finiteNumber(point.position.y),
            finiteNumber(point.position.z)
        );
    }

    const local = vectorFromSnapPoint(point);
    if (!local) return null;
    tool.updateMatrixWorld?.(true);
    return tool.localToWorld(local.clone());
}

export function getObjectWorldPosition(object) {
    const position = new THREE.Vector3();
    object?.getWorldPosition?.(position);
    return position;
}

function parentWorldToLocal(parent, worldPosition) {
    const local = worldPosition.clone();
    parent?.worldToLocal?.(local);
    return local;
}

export function moveObjectByWorldDelta(object, worldDelta) {
    if (!object?.isObject3D || !worldDelta) return;

    const beforeWorld = getObjectWorldPosition(object);
    const afterWorld = beforeWorld.clone().add(worldDelta);
    const beforeLocal = parentWorldToLocal(object.parent, beforeWorld);
    const afterLocal = parentWorldToLocal(object.parent, afterWorld);
    const localDelta = afterLocal.sub(beforeLocal);

    object.position.add(localDelta);
    object.updateMatrixWorld?.(true);
}

export function setObjectWorldPosition(object, worldPosition) {
    if (!object?.isObject3D || !worldPosition) return;
    object.position.copy(parentWorldToLocal(object.parent, worldPosition));
    object.updateMatrixWorld?.(true);
}

export function alignObjectCenterXZToWorldPoint(object, targetWorldPoint) {
    if (!object?.isObject3D || !targetWorldPoint) return;
    const info = getToolBoxInfo(object);
    moveObjectByWorldDelta(object, new THREE.Vector3(
        targetWorldPoint.x - info.center.x,
        0,
        targetWorldPoint.z - info.center.z
    ));
}

export function alignObjectBottomToY(object, targetY, clearance = 0) {
    if (!object?.isObject3D || !Number.isFinite(targetY)) return;
    const info = getToolBoxInfo(object);
    moveObjectByWorldDelta(object, new THREE.Vector3(
        0,
        targetY + clearance - info.box.min.y,
        0
    ));
}

export function keepObjectAboveTable(object, tableY = getTableSurfaceY(), clearance = 0) {
    if (!object?.isObject3D) return;
    const info = getToolBoxInfo(object);
    if (Number.isFinite(info.box.min.y) && info.box.min.y < tableY + clearance) {
        alignObjectBottomToY(object, tableY, clearance);
    }
}

export function getToolType(tool) {
    return tool?.userData?.toolType ||
        tool?.userData?.tool_type ||
        tool?.userData?.toolData?.tool_type ||
        tool?.userData?.toolData?.toolType ||
        'unknown';
}

export function getToolLabel(tool) {
    return tool?.userData?.toolData?.name_tool_vi ||
        tool?.userData?.toolData?.name_tool_en ||
        tool?.userData?.name_vi ||
        tool?.userData?.name ||
        tool?.name ||
        tool?.uuid ||
        'tool';
}

export function hasCapability(tool, capability) {
    return normalizeArray(tool?.userData?.capabilities).includes(capability);
}

export function isContainerTool(tool) {
    return getToolType(tool) === 'container' || hasCapability(tool, 'react') || hasCapability(tool, 'contain_liquid');
}

export function isSupportStandTool(tool) {
    return Boolean(
        getToolType(tool) === 'support_stand' ||
        tool?.userData?.isSupportStand === true ||
        tool?.userData?.canSupportTools === true ||
        hasCapability(tool, 'support')
    );
}

export function isHeatingSourceTool(tool) {
    return Boolean(tool?.userData?.isHeatingSource === true || getToolType(tool) === 'heating_source' || hasCapability(tool, 'heat'));
}

function normalizedHorizontalAxis(object, axis = new THREE.Vector3(1, 0, 0)) {
    const quaternion = new THREE.Quaternion();
    object?.getWorldQuaternion?.(quaternion);
    const worldAxis = axis.clone().applyQuaternion(quaternion);
    worldAxis.y = 0;
    if (worldAxis.lengthSq() < EPSILON) worldAxis.set(1, 0, 0);
    return worldAxis.normalize();
}

function anchor(name, type, worldPosition, options = {}) {
    return {
        name,
        type: type || name,
        slotType: options.slotType || type || name,
        worldPosition: worldPosition.clone(),
        priority: Number(options.priority ?? 0),
        generated: options.generated !== false,
        acceptsMultiple: Boolean(options.acceptsMultiple),
        group: options.group || 'generated'
    };
}

function addAnchor(anchorMap, value) {
    if (!value?.name || !value?.worldPosition) return;
    if (!anchorMap.has(value.name)) anchorMap.set(value.name, value);
}

function supportTopWorldPosition(support, info) {
    const explicitAnchor = support?.userData?.supportAnchor;
    if (explicitAnchor?.getWorldPosition) {
        const world = new THREE.Vector3();
        explicitAnchor.getWorldPosition(world);
        if (Number.isFinite(world.x) && Number.isFinite(world.y) && Number.isFinite(world.z)) return world;
    }

    const supportWorld = getObjectWorldPosition(support);
    const fallbackHeight = Math.max(0.25, info.size.y * 0.55);
    const y = supportWorld.y + finiteNumber(support?.userData?.supportHeight, fallbackHeight);
    return new THREE.Vector3(info.center.x, Number.isFinite(y) ? y : info.box.max.y, info.center.z);
}

function supportSlotOffsets(support) {
    const count = Math.max(1, Math.min(7, Math.round(finiteNumber(
        support?.userData?.supportSlotCount ?? support?.userData?.maxSupportSlots,
        5
    ))));
    const offsets = [0];
    for (let i = 1; offsets.length < count; i++) {
        offsets.push(-i);
        if (offsets.length < count) offsets.push(i);
    }
    return offsets;
}

function heatTargetWorldPosition(tool, info) {
    const tableY = getTableSurfaceY();
    if (isSupportStandTool(tool)) {
        return new THREE.Vector3(
            info.center.x,
            Math.max(tableY + 0.32, info.box.min.y + 0.18),
            info.center.z
        );
    }

    const bottom = info.bottomCenter.clone();
    bottom.y = Math.max(tableY + 0.32, bottom.y - 0.04);
    return bottom;
}

function addDefaultAnchors(tool, anchorMap) {
    const info = getToolBoxInfo(tool);
    const center = info.center;
    const top = info.topCenter;
    const bottom = info.bottomCenter;

    addAnchor(anchorMap, anchor('center_slot', 'center_slot', center, { slotType: ASSEMBLY_SLOT_TYPES.CENTER }));
    addAnchor(anchorMap, anchor('top_slot', 'top_slot', top, { slotType: ASSEMBLY_SLOT_TYPES.TOP }));
    addAnchor(anchorMap, anchor('bottom_slot', 'bottom_slot', bottom, { slotType: ASSEMBLY_SLOT_TYPES.BOTTOM }));

    if (isSupportStandTool(tool)) {
        const supportTop = supportTopWorldPosition(tool, info);
        const axis = normalizedHorizontalAxis(tool);
        const spacing = Math.max(0.26, finiteNumber(tool?.userData?.supportSlotSpacing, 0.34));

        anchorMap.set('top_slot', anchor('top_slot', 'support_top', supportTop, {
            slotType: ASSEMBLY_SLOT_TYPES.CONTAINER,
            acceptsMultiple: true,
            priority: 0
        }));
        addAnchor(anchorMap, anchor('support_top', 'support_top', supportTop, {
            slotType: ASSEMBLY_SLOT_TYPES.CONTAINER,
            acceptsMultiple: true,
            priority: 0
        }));

        for (const offset of supportSlotOffsets(tool)) {
            const abs = Math.abs(offset);
            const suffix = offset === 0 ? '' : `_${offset < 0 ? 'left' : 'right'}${abs}`;
            const slotName = `container_slot${suffix}`;
            const slotWorld = supportTop.clone().add(axis.clone().multiplyScalar(offset * spacing));
            addAnchor(anchorMap, anchor(slotName, 'support_top', slotWorld, {
                slotType: ASSEMBLY_SLOT_TYPES.CONTAINER,
                priority: abs,
                group: 'support_slots'
            }));
        }

        const holderWorld = supportTop.clone()
            .add(axis.clone().multiplyScalar(Math.max(0.22, info.size.x * 0.25)))
            .add(new THREE.Vector3(0, Math.max(0.08, info.size.y * 0.12), 0));
        addAnchor(anchorMap, anchor('holder_slot', 'clamp_point', holderWorld, { slotType: ASSEMBLY_SLOT_TYPES.HOLDER }));
        addAnchor(anchorMap, anchor('heat_slot', 'heat_target', heatTargetWorldPosition(tool, info), { slotType: ASSEMBLY_SLOT_TYPES.HEAT }));
        return;
    }

    if (isHeatingSourceTool(tool)) {
        addAnchor(anchorMap, anchor('heating_zone', 'heating_zone', top, { slotType: ASSEMBLY_SLOT_TYPES.HEAT }));
        addAnchor(anchorMap, anchor('heat_slot', 'heating_zone', top, { slotType: ASSEMBLY_SLOT_TYPES.HEAT }));
        return;
    }

    if (isContainerTool(tool)) {
        const gasOut = top.clone().add(normalizedHorizontalAxis(tool).multiplyScalar(Math.max(0.06, info.size.x * 0.22)));
        const holder = center.clone().add(new THREE.Vector3(0, Math.max(0.04, info.size.y * 0.18), 0));

        addAnchor(anchorMap, anchor('opening', 'opening', top, { slotType: ASSEMBLY_SLOT_TYPES.TOP }));
        addAnchor(anchorMap, anchor('liquid_in', 'liquid_in', top, { slotType: ASSEMBLY_SLOT_TYPES.TOP }));
        addAnchor(anchorMap, anchor('gas_out', 'gas_out', gasOut, { slotType: ASSEMBLY_SLOT_TYPES.TOP }));
        addAnchor(anchorMap, anchor('support_target', 'support_target', bottom, { slotType: ASSEMBLY_SLOT_TYPES.BOTTOM }));
        addAnchor(anchorMap, anchor('heat_target', 'heat_target', heatTargetWorldPosition(tool, info), { slotType: ASSEMBLY_SLOT_TYPES.HEAT }));
        addAnchor(anchorMap, anchor('heat_slot', 'heat_target', heatTargetWorldPosition(tool, info), { slotType: ASSEMBLY_SLOT_TYPES.HEAT }));
        addAnchor(anchorMap, anchor('holder_slot', 'clamp_target', holder, { slotType: ASSEMBLY_SLOT_TYPES.HOLDER }));
        addAnchor(anchorMap, anchor('clamp_target', 'clamp_target', holder, { slotType: ASSEMBLY_SLOT_TYPES.HOLDER }));
    }
}

function offsetToVector(offset = [0, 0, 0]) {
    if (Array.isArray(offset)) {
        return new THREE.Vector3(finiteNumber(offset[0]), finiteNumber(offset[1]), finiteNumber(offset[2]));
    }
    return new THREE.Vector3(finiteNumber(offset.x), finiteNumber(offset.y), finiteNumber(offset.z));
}

function bboxRelativeWorldPosition(info, offset) {
    return new THREE.Vector3(
        info.center.x + offset.x * info.size.x * 0.5,
        info.center.y + offset.y * info.size.y * 0.5,
        info.center.z + offset.z * info.size.z * 0.5
    );
}

function metadataWorldPosition(tool, name, point, info) {
    const type = point?.type || name;
    const key = `${name} ${type}`.toLowerCase();

    if (key.includes('support_top') || key.includes('container_slot') || key.includes('top_slot')) {
        return isSupportStandTool(tool) ? supportTopWorldPosition(tool, info) : info.topCenter.clone();
    }
    if (key.includes('support_target') || key.includes('bottom') || key.includes('bottom_slot')) return info.bottomCenter.clone();
    if (key.includes('heat')) return isHeatingSourceTool(tool) ? info.topCenter.clone() : heatTargetWorldPosition(tool, info);
    if (key.includes('opening') || key.includes('liquid_in')) return info.topCenter.clone();
    if (key.includes('center')) return info.center.clone();

    if (point?.anchorObjectName || point?.objectName) {
        const objectName = point.anchorObjectName || point.objectName;
        const child = tool?.getObjectByName?.(objectName);
        if (child?.getWorldPosition) {
            const world = new THREE.Vector3();
            child.getWorldPosition(world);
            return world;
        }
    }

    const offset = offsetToVector(point?.offset);
    if (point?.space === 'local' || point?.coordinateSpace === 'local') {
        tool?.updateMatrixWorld?.(true);
        return tool.localToWorld(offset.clone());
    }
    return bboxRelativeWorldPosition(info, offset);
}

function addMetadataAnchors(tool, anchorMap) {
    const info = getToolBoxInfo(tool);
    const collections = [
        { group: 'ports', values: normalizeObject(tool?.userData?.ports) },
        { group: 'attachPoints', values: normalizeObject(tool?.userData?.attachPoints || tool?.userData?.attach_points) },
        { group: 'assemblySlots', values: normalizeObject(tool?.userData?.assemblySlots || tool?.userData?.assembly_slots || tool?.userData?.slots) }
    ];

    for (const collection of collections) {
        for (const [name, data = {}] of Object.entries(collection.values)) {
            if (anchorMap.has(name)) continue;
            const type = data.type || data.slotType || name;
            addAnchor(anchorMap, anchor(name, type, metadataWorldPosition(tool, name, data, info), {
                slotType: data.slotType || data.slot_type || type,
                group: collection.group,
                generated: false
            }));
        }
    }
}

function addSnapPointAnchors(tool, anchorMap) {
    const snapPoints = ensureAutoSnapPoints(tool);
    snapPoints.forEach((point, index) => {
        const worldPosition = getSnapPointWorldPosition(tool, point);
        if (!worldPosition) return;
        const type = point.type || point.name || 'snap';
        const name = point.name || `snap_${type}_${index}`;
        addAnchor(anchorMap, anchor(name, type, worldPosition, {
            slotType: type,
            group: 'snapPoints',
            generated: point.generated !== false
        }));
    });
}

export function getToolAnchorPoints(tool, options = {}) {
    const anchorMap = new Map();
    if (!tool?.isObject3D) return [];
    addDefaultAnchors(tool, anchorMap);
    if (options.includeSnapPoints === true) addSnapPointAnchors(tool, anchorMap);
    if (options.includeMetadata !== false) addMetadataAnchors(tool, anchorMap);
    return [...anchorMap.values()];
}

export function anchorHorizontalDistance(a, b) {
    const dx = (a?.worldPosition?.x ?? 0) - (b?.worldPosition?.x ?? 0);
    const dz = (a?.worldPosition?.z ?? 0) - (b?.worldPosition?.z ?? 0);
    return Math.sqrt(dx * dx + dz * dz);
}

export function getConnectionDistanceScore(pointA, pointB, connectionType = 'generic') {
    const horizontal = anchorHorizontalDistance(pointA, pointB);
    const vertical = Math.abs((pointA?.worldPosition?.y ?? 0) - (pointB?.worldPosition?.y ?? 0));

    if (connectionType === 'support' || connectionType === 'heat') return horizontal + vertical * 0.2;
    if (connectionType === 'clamp') return horizontal + vertical * 0.4;
    return pointA.worldPosition.distanceTo(pointB.worldPosition);
}

function heatPlacementHasClearance(movingTool, fixedTool, movingInfo, fixedInfo, tableY) {
    if (!isHeatingSourceTool(movingTool)) return false;
    if (isSupportStandTool(fixedTool)) return true;
    if (!isContainerTool(fixedTool)) return true;

    const available = fixedInfo.box.min.y - tableY;
    const needed = Math.max(0.08, movingInfo.size.y * 0.55);
    return available >= needed;
}

export function getPlacementDeltaForAnchors(movingTool, movingPoint, fixedTool, fixedPoint, connectionType = 'generic', options = {}) {
    if (!movingTool?.isObject3D || !movingPoint?.worldPosition || !fixedPoint?.worldPosition) {
        return { valid: false, reason: 'missing-anchor', delta: new THREE.Vector3() };
    }

    const movingInfo = getToolBoxInfo(movingTool);
    const fixedInfo = getToolBoxInfo(fixedTool);
    const tableY = Number.isFinite(options.tableY) ? options.tableY : getTableSurfaceY();
    let delta = fixedPoint.worldPosition.clone().sub(movingPoint.worldPosition);

    if (connectionType === 'heat') {
        if (!isHeatingSourceTool(movingTool)) {
            return { valid: false, reason: 'heat-source-must-move', delta: new THREE.Vector3() };
        }
        if (!heatPlacementHasClearance(movingTool, fixedTool, movingInfo, fixedInfo, tableY)) {
            return { valid: false, reason: 'not-enough-heat-clearance', delta: new THREE.Vector3() };
        }
        delta = new THREE.Vector3(
            fixedPoint.worldPosition.x - movingInfo.center.x,
            tableY - movingInfo.box.min.y,
            fixedPoint.worldPosition.z - movingInfo.center.z
        );
    } else if (connectionType === 'support' && isContainerTool(movingTool) && isSupportStandTool(fixedTool)) {
        delta = new THREE.Vector3(
            fixedPoint.worldPosition.x - movingInfo.center.x,
            fixedPoint.worldPosition.y + finiteNumber(options.clearance, 0.01) - movingInfo.box.min.y,
            fixedPoint.worldPosition.z - movingInfo.center.z
        );
    } else if (connectionType === 'insert') {
        const depth = Math.min(
            Math.max(0.06, movingInfo.size.y * 0.12),
            Math.max(0.08, fixedInfo.size.y * 0.28)
        );
        delta = new THREE.Vector3(
            fixedPoint.worldPosition.x - movingPoint.worldPosition.x,
            fixedPoint.worldPosition.y - depth - movingPoint.worldPosition.y,
            fixedPoint.worldPosition.z - movingPoint.worldPosition.z
        );
    } else if (
        connectionType === 'gas' &&
        ['opening', 'liquid_in'].includes(fixedPoint.type) &&
        ['gas_in', 'gas_out'].includes(movingPoint.type)
    ) {
        const depth = Math.min(0.08, Math.max(0.025, fixedInfo.size.y * 0.08));
        delta = new THREE.Vector3(
            fixedPoint.worldPosition.x - movingPoint.worldPosition.x,
            fixedPoint.worldPosition.y - depth - movingPoint.worldPosition.y,
            fixedPoint.worldPosition.z - movingPoint.worldPosition.z
        );
    } else if (connectionType === 'clamp' && isSupportStandTool(fixedTool)) {
        delta = fixedPoint.worldPosition.clone().sub(movingPoint.worldPosition);
    }

    return { valid: true, reason: '', delta };
}

export function getPlacementWorldPosition(movingTool, placement) {
    return getObjectWorldPosition(movingTool).add(placement.delta);
}

export function applyPlacementDelta(movingTool, placement, options = {}) {
    if (!placement?.valid) return false;
    moveObjectByWorldDelta(movingTool, placement.delta);
    if (options.keepAboveTable !== false) keepObjectAboveTable(movingTool, options.tableY ?? getTableSurfaceY());
    return true;
}
