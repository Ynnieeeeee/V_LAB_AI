import * as THREE from 'three';
import {
    ensureAutoSnapPoints,
    getSnapPointWorldPosition,
    getToolAnchorPoints,
    getToolBoxInfo,
    getToolLabel,
    isContainerTool,
    normalizeArray,
    normalizeObject
} from './toolAnchors.js?v=20260609-network-topology';
import { spawnSmoke, spawnGasCloud } from './reactionEffects.js';

const GAS_TYPES = new Set(['gas_in', 'gas_out', 'pipe_start', 'pipe_end']);
const LIQUID_TYPES = new Set(['liquid_in', 'liquid_out', 'opening', 'mouth', 'bottom_outlet']);
const SUPPORT_TYPES = new Set([
    'support',
    'support_top',
    'support_target',
    'top_slot',
    'bottom_slot',
    'container_slot',
    'center_slot',
    'holder_slot',
    'clamp',
    'clamp_point',
    'clamp_target',
    'heating_zone',
    'heat_target',
    'heat_slot',
    'neck',
    'bottom'
]);

const GAS_OUTLET_ROLES = new Set(['gas_outlet', 'gas_source', 'vapor_outlet']);
const GAS_INLET_ROLES = new Set(['gas_inlet', 'gas_receiver', 'gas_collection']);

function appWindow() {
    return typeof window !== 'undefined' ? window : null;
}

function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0111/g, 'd')
        .replace(/\u0110/g, 'd')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function vectorFrom(value) {
    if (!value) return null;
    if (value.isVector3) return value.clone();
    if (Array.isArray(value)) {
        return new THREE.Vector3(
            finiteNumber(value[0]),
            finiteNumber(value[1]),
            finiteNumber(value[2])
        );
    }
    return new THREE.Vector3(
        finiteNumber(value.x),
        finiteNumber(value.y),
        finiteNumber(value.z)
    );
}

function pointWorldPosition(tool, point) {
    return getSnapPointWorldPosition(tool, point) ||
        vectorFrom(point?.worldPosition) ||
        vectorFrom(point?.position);
}

function makeLocalSnapPoint(tool, point, id) {
    const source = point?.sourcePoint || point || {};
    const worldPosition =
        vectorFrom(point?.worldPosition) ||
        vectorFrom(source.worldPosition) ||
        (source.positionSpace === 'world' ? vectorFrom(source.position) : null);

    let localPosition = null;
    if (worldPosition && tool?.worldToLocal) {
        tool.updateMatrixWorld?.(true);
        localPosition = tool.worldToLocal(worldPosition.clone());
    } else {
        localPosition =
            vectorFrom(source.localPosition) ||
            vectorFrom(source.position) ||
            vectorFrom(source.offset) ||
            new THREE.Vector3();
    }

    const type = source.type || point?.type || source.name || point?.name || 'snap';
    return {
        id,
        name: source.name || point?.name || id,
        type,
        position: localPosition.clone(),
        localPosition: localPosition.clone(),
        positionSpace: 'local',
        source: source.source || 'graph_anchor',
        generated: source.generated !== false,
        isGraphSnapPoint: true
    };
}

function graphPointId(point, index = 0) {
    const source = point?.sourcePoint || point || {};
    return String(
        source.id ||
        source.name ||
        point?.id ||
        point?.name ||
        `${source.type || point?.type || 'snap'}_${index}`
    );
}

function getToolType(object) {
    return String(
        object?.userData?.toolType ||
        object?.userData?.tool_type ||
        object?.userData?.toolData?.tool_type ||
        object?.userData?.toolData?.toolType ||
        'unknown'
    ).toLowerCase();
}

function toolText(object) {
    return normalizeText([
        getToolType(object),
        object?.name,
        object?.userData?.name,
        object?.userData?.name_vi,
        object?.userData?.toolData?.name_tool_vi,
        object?.userData?.toolData?.name_tool_en
    ].filter(Boolean).join(' '));
}

function hasCapability(object, capability) {
    return normalizeArray(object?.userData?.capabilities).includes(capability) ||
        normalizeArray(object?.userData?.toolData?.capabilities).includes(capability);
}

export function isGasPipe(object) {
    const type = getToolType(object);
    const text = toolText(object);
    return Boolean(
        type === 'gas_tube' ||
        type === 'gas_pipe' ||
        hasCapability(object, 'transfer_gas') ||
        text.includes('ong dan khi') ||
        text.includes('gas tube') ||
        text.includes('delivery tube') ||
        text.includes('rubber tubing') ||
        text.includes('glass tubing')
    );
}

function isGasCollector(object) {
    const type = getToolType(object);
    const text = toolText(object);
    return Boolean(
        type === 'gas_collector' ||
        hasCapability(object, 'collect_gas') ||
        hasCapability(object, 'contain_gas') ||
        text.includes('thu khi') ||
        text.includes('gas collector')
    );
}

function isOpenContainer(object) {
    if (!object?.isObject3D) return false;
    if (isGasPipe(object)) return false;
    return isContainerTool(object) ||
        hasCapability(object, 'receive_liquid') ||
        hasCapability(object, 'contain_liquid') ||
        hasCapability(object, 'react') ||
        ['container', 'dropping_funnel', 'funnel', 'measuring_tool'].includes(getToolType(object));
}

function isInvertedTestTube(object) {
    const text = toolText(object);
    const isTube = text.includes('ong nghiem') || text.includes('test tube') || isGasCollector(object);
    if (!isTube) return false;

    if (object?.userData?.isInverted === true || object?.userData?.inverted === true) return true;

    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion();
    object?.getWorldQuaternion?.(quaternion);
    up.applyQuaternion(quaternion);
    if (up.y < -0.2) return true;

    return ensureGraphSnapPoints(object).some(point =>
        point.occupied &&
        point.connectedMedium === 'gas' &&
        pointHasRole(point, ['gas_inlet', 'gas_collection'])
    );
}

function rolesFromPoint(tool, point) {
    const type = String(point?.type || point?.name || '').toLowerCase();
    const id = String(point?.id || point?.name || '').toLowerCase();
    const role = String(point?.role || '').toLowerCase();
    const key = `${id} ${type} ${role}`;
    const roles = new Set(normalizeArray(point?.roles));

    if (role) roles.add(role);

    if (key.includes('gas_out') || key.includes('pipe_end')) roles.add('gas_outlet');
    if (key.includes('gas_in') || key.includes('pipe_start')) roles.add('gas_inlet');
    if (key.includes('liquid_out') || key.includes('bottom_outlet')) roles.add('liquid_outlet');
    if (key.includes('liquid_in') || key.includes('opening') || key.includes('mouth')) {
        roles.add('liquid_inlet');
        if (isGasCollector(tool)) {
            roles.add('gas_inlet');
            roles.add('gas_collection');
        } else if (isOpenContainer(tool)) {
            roles.add('gas_outlet');
            roles.add('gas_inlet');
        }
    }
    if (key.includes('support') || key.includes('slot') || key.includes('clamp') || key.includes('neck')) {
        roles.add('mechanical_mount');
    }

    if (isGasPipe(tool)) {
        if (key.includes('gas_in') || key.includes('pipe_start')) roles.add('gas_inlet');
        if (key.includes('gas_out') || key.includes('pipe_end')) roles.add('gas_outlet');
    }

    if (!roles.size) {
        if (GAS_TYPES.has(type)) roles.add(type === 'gas_out' ? 'gas_outlet' : 'gas_inlet');
        else if (LIQUID_TYPES.has(type)) roles.add(type === 'liquid_out' ? 'liquid_outlet' : 'liquid_inlet');
        else if (SUPPORT_TYPES.has(type)) roles.add('mechanical_mount');
        else roles.add('generic');
    }

    return Array.from(roles);
}

function primaryRole(tool, point) {
    const roles = rolesFromPoint(tool, point);
    if (roles.includes('gas_outlet')) return 'gas_outlet';
    if (roles.includes('gas_inlet')) return 'gas_inlet';
    if (roles.includes('liquid_outlet')) return 'liquid_outlet';
    if (roles.includes('liquid_inlet')) return 'liquid_inlet';
    if (roles.includes('mechanical_mount')) return 'mechanical_mount';
    return roles[0] || 'generic';
}

function directionForRoles(roles) {
    if (roles.some(role => GAS_OUTLET_ROLES.has(role) || role === 'liquid_outlet')) return 'out';
    if (roles.some(role => GAS_INLET_ROLES.has(role) || role === 'liquid_inlet')) return 'in';
    return 'none';
}

function connectorTypeFor(tool, point, roles) {
    const type = String(point?.type || point?.name || '').toLowerCase();
    if (isGasPipe(tool) || type.includes('out') || type.includes('in') || type.includes('plug')) return 'plug';
    if (roles.some(role => role.includes('inlet') || role.includes('mount'))) return 'socket';
    return isOpenContainer(tool) ? 'socket' : 'plug';
}

function decorateSnapPoint(tool, point, index = 0) {
    if (!point) return null;
    point.id ??= graphPointId(point, index);
    point.name ??= point.id;
    point.type ??= point.name || 'snap';
    const roles = rolesFromPoint(tool, point);
    point.roles = Array.from(new Set([...(normalizeArray(point.roles)), ...roles]));
    point.role = point.role || primaryRole(tool, point);
    point.direction = point.direction || directionForRoles(point.roles);
    point.connectorType = point.connectorType || connectorTypeFor(tool, point, point.roles);
    point.occupied = point.occupied === true;
    point.connectedObject ??= null;
    point.connectedSnapPointId ??= null;
    point.connectedMedium ??= null;
    point.graphNodeId = tool?.uuid || point.graphNodeId || null;
    return point;
}

function hasPointId(points, id) {
    return points.some(point => point?.id === id || point?.name === id);
}

function addGraphAnchorPoint(tool, anchor, index = 0) {
    if (!tool?.userData || !anchor?.worldPosition) return null;
    const id = graphPointId(anchor, index);
    const points = tool.userData.snapPoints || [];
    const existing = points.find(point => point?.id === id || point?.name === id);
    if (existing) {
        const localPosition = tool.worldToLocal(anchor.worldPosition.clone());
        existing.position = localPosition.clone();
        existing.localPosition = localPosition.clone();
        existing.positionSpace = 'local';
        return decorateSnapPoint(tool, existing, index);
    }

    const point = makeLocalSnapPoint(tool, anchor, id);
    points.push(point);
    tool.userData.snapPoints = points;
    return decorateSnapPoint(tool, point, points.length - 1);
}

function addGasPipeFallbackPoints(tool) {
    if (!isGasPipe(tool) || !tool?.userData) return;
    const points = tool.userData.snapPoints || [];

    const info = getToolBoxInfo(tool);
    const axisIsX = info.size.x >= info.size.z;
    const start = info.center.clone();
    const end = info.center.clone();
    if (axisIsX) {
        start.x = info.box.min.x;
        end.x = info.box.max.x;
    } else {
        start.z = info.box.min.z;
        end.z = info.box.max.z;
    }

    const updateOrAdd = (id, type, worldPosition) => {
        const existing = points.find(point => point?.id === id || point?.name === id);
        if (existing) {
            const localPosition = tool.worldToLocal(worldPosition.clone());
            existing.position = localPosition.clone();
            existing.localPosition = localPosition.clone();
            existing.positionSpace = 'local';
            decorateSnapPoint(tool, existing, points.indexOf(existing));
            return;
        }
        points.push(makeLocalSnapPoint(tool, {
            name: id,
            type,
            worldPosition,
            source: 'graph_pipe_bbox'
        }, id));
    };

    if (!hasPointId(points, 'pipe_start')) {
        points.push(makeLocalSnapPoint(tool, {
            name: 'pipe_start',
            type: 'gas_in',
            worldPosition: start,
            source: 'graph_pipe_bbox'
        }, 'pipe_start'));
    } else {
        updateOrAdd('pipe_start', 'gas_in', start);
    }

    if (!hasPointId(points, 'pipe_end')) {
        points.push(makeLocalSnapPoint(tool, {
            name: 'pipe_end',
            type: 'gas_out',
            worldPosition: end,
            source: 'graph_pipe_bbox'
        }, 'pipe_end'));
    } else {
        updateOrAdd('pipe_end', 'gas_out', end);
    }

    tool.userData.snapPoints = points;
}

export function ensureGraphNode(object) {
    if (!object?.isObject3D || !object.userData) return null;
    const type = getToolType(object);
    if (!object.userData.graphNode || object.userData.graphNode.id !== object.uuid) {
        object.userData.graphNode = {
            id: object.uuid,
            object,
            type,
            connections: []
        };
    } else {
        object.userData.graphNode.object = object;
        object.userData.graphNode.type = type;
        object.userData.graphNode.connections ??= [];
    }
    return object.userData.graphNode;
}

export function ensureGraphSnapPoints(object) {
    if (!object?.isObject3D || !object.userData) return [];
    ensureAutoSnapPoints(object);
    object.userData.snapPoints ??= [];

    object.userData.snapPoints.forEach((point, index) => decorateSnapPoint(object, point, index));

    getToolAnchorPoints(object, { includeSnapPoints: false }).forEach((anchor, index) => {
        if (!anchor?.name || !anchor?.worldPosition) return;
        addGraphAnchorPoint(object, anchor, index);
    });

    addGasPipeFallbackPoints(object);
    object.userData.snapPoints.forEach((point, index) => decorateSnapPoint(object, point, index));
    return object.userData.snapPoints;
}

export function resolveGraphSnapPoint(object, pointInfo) {
    const points = ensureGraphSnapPoints(object);
    if (!points.length) return null;

    const source = pointInfo?.sourcePoint || pointInfo || {};
    const id = graphPointId(pointInfo, 0);
    const sourceId = graphPointId(source, 0);
    const name = pointInfo?.name || source.name || source.id || id;
    const type = pointInfo?.type || source.type || null;

    const existing =
        points.find(point => point.id === id || point.name === id) ||
        points.find(point => point.id === sourceId || point.name === sourceId) ||
        points.find(point => point.id === name || point.name === name) ||
        points.find(point => type && point.type === type);

    if (existing) return decorateSnapPoint(object, existing, points.indexOf(existing));

    return addGraphAnchorPoint(object, {
        name,
        type: type || name || 'snap',
        worldPosition: pointInfo?.worldPosition || source.worldPosition,
        source: source.source || 'graph_match'
    }, points.length);
}

function pointHasRole(point, roles) {
    const roleSet = new Set([point?.role, ...normalizeArray(point?.roles)].filter(Boolean));
    return roles.some(role => roleSet.has(role));
}

export function detectConnectionMedium(snapA, snapB) {
    if (pointHasRole(snapA, ['gas_outlet', 'gas_inlet', 'gas_collection']) ||
        pointHasRole(snapB, ['gas_outlet', 'gas_inlet', 'gas_collection']) ||
        GAS_TYPES.has(String(snapA?.type || '').toLowerCase()) ||
        GAS_TYPES.has(String(snapB?.type || '').toLowerCase())) {
        return 'gas';
    }

    if (pointHasRole(snapA, ['liquid_outlet', 'liquid_inlet']) ||
        pointHasRole(snapB, ['liquid_outlet', 'liquid_inlet']) ||
        LIQUID_TYPES.has(String(snapA?.type || '').toLowerCase()) ||
        LIQUID_TYPES.has(String(snapB?.type || '').toLowerCase())) {
        return 'liquid';
    }

    return 'mechanical';
}

export function detectConnectionDirection(snapA, snapB) {
    const aDirection = snapA?.direction || directionForRoles(normalizeArray(snapA?.roles));
    const bDirection = snapB?.direction || directionForRoles(normalizeArray(snapB?.roles));
    if (aDirection === 'out' && bDirection === 'in') return 'out';
    if (aDirection === 'in' && bDirection === 'out') return 'in';
    if (aDirection === 'out') return 'out';
    if (aDirection === 'in') return 'in';
    return 'bidirectional';
}

function connectionMatches(conn, targetObject, options = {}) {
    if (!conn || conn.targetObject !== targetObject) return false;
    const fromId = options.fromSnapPointId || options.snapPointId || null;
    const toId = options.toSnapPointId || null;
    if (!fromId && !toId) return true;
    if (fromId && conn.fromSnapPointId !== fromId && conn.toSnapPointId !== fromId) return false;
    if (toId && conn.fromSnapPointId !== toId && conn.toSnapPointId !== toId) return false;
    return true;
}

function removeConnectionEntries(object, targetObject, options = {}) {
    const graph = object?.userData?.graphNode;
    if (!graph?.connections) return 0;
    const before = graph.connections.length;
    graph.connections = graph.connections.filter(conn => !connectionMatches(conn, targetObject, options));
    return before - graph.connections.length;
}

function clearSnapPointLinks(object, targetObject, options = {}) {
    let cleared = 0;
    const fromId = options.fromSnapPointId || options.snapPointId || null;
    const toId = options.toSnapPointId || null;

    ensureGraphSnapPoints(object).forEach(point => {
        if (point.connectedObject !== targetObject) return;
        if (fromId && point.id !== fromId && point.connectedSnapPointId !== fromId) return;
        if (toId && point.id !== toId && point.connectedSnapPointId !== toId) return;
        point.occupied = false;
        point.connectedObject = null;
        point.connectedSnapPointId = null;
        point.connectedMedium = null;
        cleared++;
    });
    return cleared;
}

export function clearConnectedSnapPoints(objectA, objectB, options = {}) {
    return clearSnapPointLinks(objectA, objectB, {
        fromSnapPointId: options.fromSnapPointId,
        toSnapPointId: options.toSnapPointId
    }) + clearSnapPointLinks(objectB, objectA, {
        fromSnapPointId: options.toSnapPointId,
        toSnapPointId: options.fromSnapPointId
    });
}

export function unregisterGraphConnection(objectA, objectB, options = {}) {
    if (!objectA || !objectB) return 0;
    const removed =
        removeConnectionEntries(objectA, objectB, options) +
        removeConnectionEntries(objectB, objectA, {
            fromSnapPointId: options.toSnapPointId,
            toSnapPointId: options.fromSnapPointId
        });
    clearConnectedSnapPoints(objectA, objectB, options);
    return removed;
}

export function registerGraphConnection(objectA, snapAInfo, objectB, snapBInfo, options = {}) {
    if (!objectA?.isObject3D || !objectB?.isObject3D || objectA === objectB) return null;
    const nodeA = ensureGraphNode(objectA);
    const nodeB = ensureGraphNode(objectB);
    const snapA = resolveGraphSnapPoint(objectA, snapAInfo);
    const snapB = resolveGraphSnapPoint(objectB, snapBInfo);
    if (!nodeA || !nodeB || !snapA || !snapB) return null;

    unregisterGraphConnection(objectA, objectB, {
        fromSnapPointId: snapA.id,
        toSnapPointId: snapB.id
    });

    const medium = options.medium || detectConnectionMedium(snapA, snapB);
    snapA.occupied = true;
    snapA.connectedObject = objectB;
    snapA.connectedSnapPointId = snapB.id;
    snapA.connectedMedium = medium;
    snapB.occupied = true;
    snapB.connectedObject = objectA;
    snapB.connectedSnapPointId = snapA.id;
    snapB.connectedMedium = medium;

    const createdAt = Date.now();
    const forward = {
        id: `${objectA.uuid}:${snapA.id}->${objectB.uuid}:${snapB.id}`,
        fromObjectId: objectA.uuid,
        fromSnapPointId: snapA.id,
        toObjectId: objectB.uuid,
        toSnapPointId: snapB.id,
        targetObject: objectB,
        medium,
        direction: options.direction || detectConnectionDirection(snapA, snapB),
        connectionType: options.connectionType || medium,
        active: true,
        createdAt
    };
    const reverse = {
        id: `${objectB.uuid}:${snapB.id}->${objectA.uuid}:${snapA.id}`,
        fromObjectId: objectB.uuid,
        fromSnapPointId: snapB.id,
        toObjectId: objectA.uuid,
        toSnapPointId: snapA.id,
        targetObject: objectA,
        medium,
        direction: options.reverseDirection || detectConnectionDirection(snapB, snapA),
        connectionType: options.connectionType || medium,
        active: true,
        createdAt
    };

    nodeA.connections.push(forward);
    nodeB.connections.push(reverse);
    return { forward, reverse, snapA, snapB, medium };
}

export function unregisterGraphObject(object) {
    if (!object?.userData?.graphNode) return;
    const connections = [...(object.userData.graphNode.connections || [])];
    connections.forEach(conn => unregisterGraphConnection(object, conn.targetObject));
    object.userData.graphNode.connections = [];
    (object.userData.snapPoints || []).forEach(point => {
        point.occupied = false;
        point.connectedObject = null;
        point.connectedSnapPointId = null;
        point.connectedMedium = null;
    });
}

function hasActiveMediumConnection(object, point, medium) {
    if (!object?.userData?.graphNode || !point) return false;
    return (object.userData.graphNode.connections || []).some(conn =>
        conn.active &&
        conn.medium === medium &&
        conn.fromSnapPointId === point.id &&
        conn.targetObject === point.connectedObject
    );
}

export function findAvailableGasOutlet(object, options = {}) {
    if (!object?.isObject3D) return null;
    const excludeObject = options.excludeObject || null;
    const excludeSnapPointId = options.excludeSnapPointId || null;

    return ensureGraphSnapPoints(object).find(point =>
        point.occupied === true &&
        point.connectedObject &&
        point.connectedObject !== excludeObject &&
        point.id !== excludeSnapPointId &&
        (point.connectedMedium === 'gas' || hasActiveMediumConnection(object, point, 'gas')) &&
        pointHasRole(point, ['gas_outlet', 'gas_source', 'vapor_outlet'])
    ) || null;
}

function findSnapPoint(object, snapPointId) {
    if (!snapPointId) return null;
    return ensureGraphSnapPoints(object).find(point => point.id === snapPointId || point.name === snapPointId) || null;
}

export function findPipeDestination(pipeObject, inletSnapPointId = null, previousObject = null) {
    if (!isGasPipe(pipeObject)) return null;
    const points = ensureGraphSnapPoints(pipeObject);
    const occupied = points.filter(point =>
        point.occupied &&
        point.connectedObject &&
        point.connectedObject !== previousObject &&
        point.id !== inletSnapPointId &&
        (point.connectedMedium === 'gas' || hasActiveMediumConnection(pipeObject, point, 'gas'))
    );

    const gasOutlet = occupied.find(point =>
        pointHasRole(point, ['gas_outlet']) ||
        ['pipe_end', 'gas_out'].includes(String(point.id || point.name || point.type).toLowerCase())
    );
    if (gasOutlet) return gasOutlet;

    return occupied.find(point => pointHasRole(point, ['gas_inlet', 'gas_collection'])) || occupied[0] || null;
}

function getObjectEffectPosition(object) {
    const outlet = findAvailableGasOutlet(object);
    const outletWorld = outlet ? pointWorldPosition(object, outlet) : null;
    if (outletWorld) return outletWorld;

    const info = getToolBoxInfo(object);
    if (!info.box.isEmpty()) return info.topCenter.clone();
    const position = new THREE.Vector3();
    object?.getWorldPosition?.(position);
    return position;
}

function colorFromGas(gasChemicalData = {}, fallback = '#ffffff') {
    try {
        return new THREE.Color(gasChemicalData.color || gasChemicalData.gasColor || fallback);
    } catch {
        return new THREE.Color(fallback);
    }
}

function markEffectObject(object) {
    object.userData ??= {};
    object.userData.ignoreInteraction = true;
    object.userData.notDraggable = true;
    object.userData.isReactionEffect = true;
    object.userData.isAssemblyGraphEffect = true;
    object.traverse?.(child => {
        child.userData ??= {};
        child.userData.ignoreInteraction = true;
        child.userData.notDraggable = true;
        child.userData.isReactionEffect = true;
        child.userData.isAssemblyGraphEffect = true;
    });
}

function disposeEffectObject(scene, object) {
    if (!object) return;
    scene?.remove?.(object);
    object.geometry?.dispose?.();
    const material = object.material;
    if (Array.isArray(material)) material.forEach(item => item?.dispose?.());
    else material?.dispose?.();
}

function sceneForObject(object, options = {}) {
    return options.scene || options.manager?.scene || appWindow()?.scene || object?.parent || null;
}

export function spawnSmokeEffectFree(object, gasChemicalData = {}, options = {}) {
    const scene = sceneForObject(object, options);
    if (!scene) return false;
    const position = vectorFrom(options.position || options.freePosition) || getObjectEffectPosition(object);
    const gasIntensity = finiteNumber(gasChemicalData.gasIntensity ?? gasChemicalData.intensity ?? gasChemicalData.toxicity, 0);
    const smokeDensity = finiteNumber(gasChemicalData.smokeDensity ?? gasChemicalData.smoke ?? gasChemicalData.density, 0);

    if (smokeDensity > 0) spawnSmoke?.(scene, position, { density: smokeDensity });
    if (gasIntensity > 0) spawnGasCloud?.(scene, position, { toxicity: gasIntensity });
    if (smokeDensity <= 0 && gasIntensity <= 0) {
        spawnGasCloud?.(scene, position, { toxicity: 1 });
    }
    return true;
}

export function animateGasInsidePipe(pipeObject, gasChemicalData = {}, options = {}) {
    const scene = sceneForObject(pipeObject, options);
    if (!scene || !pipeObject?.isObject3D) return false;
    const fromPoint = findSnapPoint(pipeObject, options.fromSnapPointId) ||
        ensureGraphSnapPoints(pipeObject).find(point => pointHasRole(point, ['gas_inlet']));
    const toPoint = findSnapPoint(pipeObject, options.toSnapPointId) ||
        ensureGraphSnapPoints(pipeObject).find(point => pointHasRole(point, ['gas_outlet']));
    const start = pointWorldPosition(pipeObject, fromPoint) || getObjectEffectPosition(pipeObject);
    const end = pointWorldPosition(pipeObject, toPoint) || getObjectEffectPosition(pipeObject);
    const distance = Math.max(0.05, start.distanceTo(end));
    const flowRate = clamp(finiteNumber(gasChemicalData.flowRate ?? gasChemicalData.gasFlowRate, 1), 0.15, 4);
    const count = Math.round(clamp(8 + flowRate * 5 + distance * 10, 8, 30));
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const offsets = Array.from({ length: count }, (_, index) => index / count);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
        color: colorFromGas(gasChemicalData),
        size: clamp(0.022 + flowRate * 0.008, 0.022, 0.055),
        transparent: true,
        opacity: 0.78,
        depthWrite: false
    });
    const particles = new THREE.Points(geometry, material);
    markEffectObject(particles);
    scene.add(particles);

    const duration = clamp(distance / (0.45 * flowRate), 0.45, 2.6);
    const lifetime = Math.max(1.2, duration * 2.2);
    const effect = {
        elapsed: 0,
        update(delta = 0.016) {
            this.elapsed += delta;
            const dir = end.clone().sub(start);
            const side = new THREE.Vector3(-dir.z, 0, dir.x);
            if (side.lengthSq() > 1e-6) side.normalize();
            for (let i = 0; i < count; i++) {
                const t = (this.elapsed / duration + offsets[i]) % 1;
                const pos = start.clone().lerp(end, t);
                const ripple = Math.sin((this.elapsed * 9 + i) * 1.7) * 0.006;
                pos.add(side.clone().multiplyScalar(ripple));
                positions[i * 3] = pos.x;
                positions[i * 3 + 1] = pos.y;
                positions[i * 3 + 2] = pos.z;
            }
            geometry.attributes.position.needsUpdate = true;
            material.opacity = Math.max(0, 0.78 * (1 - Math.max(0, this.elapsed - lifetime * 0.65) / (lifetime * 0.35)));
            if (this.elapsed >= lifetime) {
                disposeEffectObject(scene, particles);
                return false;
            }
            return true;
        }
    };

    if (options.manager?.addEffect) {
        options.manager.addEffect(effect);
    } else {
        let last = performance.now();
        const tick = (now) => {
            const keep = effect.update(Math.min(0.05, (now - last) / 1000));
            last = now;
            if (keep !== false) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
    return true;
}

function findLiquidMesh(object) {
    if (!object?.isObject3D) return null;
    const explicit = object.userData?.liquidMesh || object.userData?.liquidObject || object.userData?.liquid;
    if (explicit?.isObject3D) return explicit;
    let found = null;
    object.traverse?.(child => {
        if (found || !child?.isObject3D) return;
        const name = normalizeText(child.name);
        if (child.userData?.isInternalChemicalVisual || child.userData?.isLiquid || name.includes('liquid') || name.includes('water') || name.includes('fluid')) {
            found = child;
        }
    });
    return found;
}

export function displaceWaterLevel(testTubeObject, gasChemicalData = {}) {
    if (!testTubeObject?.userData) return false;
    const flowRate = clamp(finiteNumber(gasChemicalData.flowRate ?? gasChemicalData.gasFlowRate, 1), 0.15, 4);
    const liquidMesh = findLiquidMesh(testTubeObject);
    testTubeObject.userData.collectedGasVolume = finiteNumber(testTubeObject.userData.collectedGasVolume, 0) + flowRate * 0.01;
    if (!liquidMesh?.scale || !liquidMesh?.position) return false;
    const deltaScale = 0.01 * flowRate;
    liquidMesh.scale.y = Math.max(0, liquidMesh.scale.y - deltaScale);
    liquidMesh.position.y -= 0.005 * flowRate;
    liquidMesh.visible = liquidMesh.scale.y > 0.001;
    return true;
}

export function spawnBubbleParticles(testTubeObject, gasChemicalData = {}, options = {}) {
    const scene = sceneForObject(testTubeObject, options);
    if (!scene || !testTubeObject?.isObject3D) return false;
    const snapPoints = ensureGraphSnapPoints(testTubeObject);
    const mouth = snapPoints.find(point => pointHasRole(point, ['gas_inlet', 'gas_collection']) || ['mouth', 'opening', 'gas_in'].includes(point.type));
    const info = getToolBoxInfo(testTubeObject);
    const start = pointWorldPosition(testTubeObject, mouth) || new THREE.Vector3(info.center.x, info.box.min.y, info.center.z);
    const end = new THREE.Vector3(info.center.x, info.box.max.y - Math.max(0.02, info.size.y * 0.08), info.center.z);
    const flowRate = clamp(finiteNumber(gasChemicalData.flowRate ?? gasChemicalData.gasFlowRate, 1), 0.15, 4);
    const count = Math.round(clamp(10 + flowRate * 8, 10, 34));
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const offsets = Array.from({ length: count }, (_, index) => index / count);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
        color: colorFromGas(gasChemicalData, '#dff8ff'),
        size: clamp(0.018 + flowRate * 0.006, 0.018, 0.045),
        transparent: true,
        opacity: 0.72,
        depthWrite: false
    });
    const bubbles = new THREE.Points(geometry, material);
    markEffectObject(bubbles);
    scene.add(bubbles);

    const duration = clamp(1.4 / flowRate, 0.45, 2.8);
    const lifetime = Math.max(1.4, duration * 2.2);
    const effect = {
        elapsed: 0,
        update(delta = 0.016) {
            this.elapsed += delta;
            for (let i = 0; i < count; i++) {
                const t = (this.elapsed / duration + offsets[i]) % 1;
                const pos = start.clone().lerp(end, t);
                const swirl = (i % 5 - 2) * 0.004 + Math.sin(this.elapsed * 5 + i) * 0.004;
                pos.x += swirl;
                pos.z += Math.cos(this.elapsed * 4 + i) * 0.004;
                positions[i * 3] = pos.x;
                positions[i * 3 + 1] = pos.y;
                positions[i * 3 + 2] = pos.z;
            }
            geometry.attributes.position.needsUpdate = true;
            material.opacity = Math.max(0, 0.72 * (1 - Math.max(0, this.elapsed - lifetime * 0.65) / (lifetime * 0.35)));
            if (this.elapsed >= lifetime) {
                disposeEffectObject(scene, bubbles);
                return false;
            }
            return true;
        }
    };

    if (options.manager?.addEffect) options.manager.addEffect(effect);
    else {
        let last = performance.now();
        const tick = (now) => {
            const keep = effect.update(Math.min(0.05, (now - last) / 1000));
            last = now;
            if (keep !== false) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
    return true;
}

export function triggerGasCollectionInInvertedTube(testTubeObject, gasChemicalData = {}, options = {}) {
    if (!testTubeObject?.userData) return false;
    testTubeObject.userData.isCollectingGas = true;
    testTubeObject.userData.collectedGasName = gasChemicalData.gasName || gasChemicalData.name || 'gas';
    spawnBubbleParticles(testTubeObject, gasChemicalData, options);
    displaceWaterLevel(testTubeObject, gasChemicalData);
    return true;
}

export function triggerDestinationEffect(destinationObject, gasChemicalData = {}, options = {}) {
    if (!destinationObject?.isObject3D) return false;
    if (isInvertedTestTube(destinationObject)) {
        return triggerGasCollectionInInvertedTube(destinationObject, gasChemicalData, options);
    }
    if (isGasCollector(destinationObject)) {
        return triggerGasCollectionInInvertedTube(destinationObject, gasChemicalData, options);
    }
    if (isOpenContainer(destinationObject)) {
        return spawnSmokeEffectFree(destinationObject, gasChemicalData, options);
    }
    return spawnSmokeEffectFree(destinationObject, gasChemicalData, options);
}

function nextGasHop(currentObject, previousObject, inletSnapPointId) {
    if (isGasPipe(currentObject)) {
        const outlet = findPipeDestination(currentObject, inletSnapPointId, previousObject);
        if (!outlet?.connectedObject) return null;
        return {
            type: 'pipe',
            fromObject: currentObject,
            nextObject: outlet.connectedObject,
            fromSnapPointId: inletSnapPointId,
            toSnapPointId: outlet.id,
            nextInletSnapPointId: outlet.connectedSnapPointId
        };
    }

    const outlet = findAvailableGasOutlet(currentObject, {
        excludeObject: previousObject,
        excludeSnapPointId: inletSnapPointId
    });
    if (!outlet?.connectedObject) return null;
    return {
        type: 'outlet',
        fromObject: currentObject,
        nextObject: outlet.connectedObject,
        fromSnapPointId: outlet.id,
        toSnapPointId: outlet.connectedSnapPointId,
        nextInletSnapPointId: outlet.connectedSnapPointId
    };
}

export function propagateGasProduct(currentObject, gasChemicalData = {}, options = {}) {
    if (!currentObject?.isObject3D) return false;
    ensureGraphNode(currentObject);
    ensureGraphSnapPoints(currentObject);

    const manager = options.manager || appWindow()?.assemblyGraphManager || null;
    const visited = new Set();
    const pipeHops = [];
    let current = currentObject;
    let previous = null;
    let inletSnapPointId = options.inletSnapPointId || null;

    for (let depth = 0; depth < 12; depth++) {
        if (!current?.isObject3D || visited.has(current)) break;
        visited.add(current);
        ensureGraphNode(current);
        ensureGraphSnapPoints(current);

        const hop = nextGasHop(current, previous, inletSnapPointId);
        if (!hop) {
            if (current !== currentObject) {
                pipeHops.forEach(pipeHop => animateGasInsidePipe(pipeHop.fromObject, gasChemicalData, {
                    ...options,
                    manager,
                    fromSnapPointId: pipeHop.fromSnapPointId,
                    toSnapPointId: pipeHop.toSnapPointId
                }));
                triggerDestinationEffect(current, gasChemicalData, {
                    ...options,
                    manager,
                    position: null,
                    freePosition: null
                });
                return true;
            }
            return spawnSmokeEffectFree(currentObject, gasChemicalData, options);
        }

        if (hop.type === 'pipe') pipeHops.push(hop);

        if (!isGasPipe(hop.nextObject)) {
            pipeHops.forEach(pipeHop => animateGasInsidePipe(pipeHop.fromObject, gasChemicalData, {
                ...options,
                manager,
                fromSnapPointId: pipeHop.fromSnapPointId,
                toSnapPointId: pipeHop.toSnapPointId
            }));
            triggerDestinationEffect(hop.nextObject, gasChemicalData, {
                ...options,
                manager,
                position: null,
                freePosition: null
            });
            return true;
        }

        previous = current;
        current = hop.nextObject;
        inletSnapPointId = hop.nextInletSnapPointId;
    }

    return spawnSmokeEffectFree(currentObject, gasChemicalData, options);
}

export function hasGraphPathToCapability(startObject, capability, medium = null) {
    if (!startObject?.isObject3D) return false;
    const visited = new Set();
    const queue = [startObject];
    while (queue.length) {
        const object = queue.shift();
        if (!object?.isObject3D || visited.has(object)) continue;
        visited.add(object);
        if (object !== startObject && hasCapability(object, capability)) return true;
        ensureGraphNode(object);
        (object.userData.graphNode?.connections || []).forEach(conn => {
            if (!conn.active) return;
            if (medium && conn.medium !== medium) return;
            if (conn.targetObject && !visited.has(conn.targetObject)) queue.push(conn.targetObject);
        });
    }
    return false;
}

export class AssemblyGraphManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.getObjects = options.getObjects || (() => []);
        this.effects = [];
    }

    setObjectsProvider(getObjects) {
        this.getObjects = getObjects || (() => []);
    }

    syncObjects() {
        this.getObjects().filter(Boolean).forEach(object => {
            ensureGraphNode(object);
            ensureGraphSnapPoints(object);
        });
    }

    addEffect(effect) {
        if (effect?.update) this.effects.push(effect);
    }

    update(delta = 0.016) {
        this.effects = this.effects.filter(effect => effect.update(delta) !== false);
    }

    ensureGraphNode(object) {
        return ensureGraphNode(object);
    }

    ensureGraphSnapPoints(object) {
        return ensureGraphSnapPoints(object);
    }

    registerGraphConnection(objectA, snapA, objectB, snapB, options = {}) {
        return registerGraphConnection(objectA, snapA, objectB, snapB, options);
    }

    unregisterGraphConnection(objectA, objectB, options = {}) {
        return unregisterGraphConnection(objectA, objectB, options);
    }

    unregisterGraphObject(object) {
        return unregisterGraphObject(object);
    }

    propagateGasProduct(currentObject, gasChemicalData = {}, options = {}) {
        return propagateGasProduct(currentObject, gasChemicalData, {
            ...options,
            scene: options.scene || this.scene,
            manager: this
        });
    }
}

export function createAssemblyGraphManager(scene, options = {}) {
    return new AssemblyGraphManager(scene, options);
}

export default AssemblyGraphManager;
