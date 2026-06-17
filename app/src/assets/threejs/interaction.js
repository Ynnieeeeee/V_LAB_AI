import * as three from 'three';
import { notifyLab } from './labNotifier.js';
import { PouringEffect, getToolLocalMeshBox } from './pouringEffect.js?v=20260527-liquid-soft-waves';
import { detectReaction } from './reactionRules.js?v=20260527-liquid-soft-waves';
import { selectDominantCavityPoints } from './CavityCSG.js?v=20260527-liquid-soft-waves';
import {
    getSelectedQuantity,
    recordPourAction,
    validateExperimentBeforeReaction,
    validateReactionResult,
    describeNextRequirement,
    hasActiveExperimentPlan,
    markReactionSuccess
} from './ExperimentSessionManager.js';
import { camera, cameraGroup } from './camera.js';
import {
    spawnFireParticles,
    spawnSmoke,
    spawnGasCloud,
    createShockwave,
    heatDistortion,
    spawnPrecipitate,
    spawnFoam,
    phaseSeparation as applyPhaseSeparation,
    decolorizeLiquid
} from './reactionEffects.js';
import {
    hasGasProduct,
    hasExplicitSmoke,
    shouldEmitSmokeOrGas,
    reactionGasDebug
} from './reactionGasUtils.js';
import {
    canToggleHeatingSource,
    releaseHeatingSourceFromSupportStand,
    releaseContainerFromSupportStand,
    releaseContainerFromHeatingSource,
    toggleHeatingSource
} from './HeatingManager.js';
import {
    applySupportSlotOffset,
    resolveObjectOverlap
} from './CollisionSeparationHelper.js?v=20260609-network-topology';
import { SNAP_DISTANCE } from './LabAssemblyManager.js?v=20260609-network-topology';
import {
    ensureAutoSnapPoints,
    getTableSurfaceY,
    keepObjectAboveTable,
    moveObjectByWorldDelta
} from './toolAnchors.js?v=20260609-network-topology';
const THREE = three;
const DEFAULT_REACTION_HEAT_TEMPERATURE = 45;

function isEditableTarget(event) {
    const target = event?.target;
    if (!target) return false;
    return Boolean(
        target.isContentEditable ||
        target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
    );
}

function isSolidChemical(obj) {
    const s = String(
        obj?.userData?.current_physical_state ||
        obj?.userData?.physical_state ||
        obj?.userData?.physicalState ||
        obj?.userData?.state ||
        ''
    ).toLowerCase();
    return s.includes('rắn') || s.includes('ran') || s.includes('solid') || s.includes('powder') || s.includes('bột');
}


function isContainerWithChemical(obj) {
    return !!(
        obj?.userData?.toolData &&
        (obj.userData.current_chemical_id || obj.userData.current_chemical_type || obj.userData.chemicalName)
    );
}

function isPourSource(obj) {
    return !!(obj?.userData && (obj.userData.id_chemical || obj.userData.chemicalId || isContainerWithChemical(obj)));
}

function isChemicalBottleObject(obj) {
    return Boolean(obj?.userData && (obj.userData.id_chemical || obj.userData.chemicalId) && !obj.userData.toolData);
}

function isDescendantOf(object, ancestor) {
    let node = object;
    while (node) {
        if (node === ancestor) return true;
        node = node.parent;
    }
    return false;
}

function isTableObject(object) {
    if (!object?.isObject3D) return false;
    if (object.userData?.isTable || object.parent?.userData?.isTable) return true;
    const table = window.tableObject || window.labTable || window.tableMesh;
    return Boolean(table?.isObject3D && isDescendantOf(object, table));
}

function getTableRoot(object) {
    let node = object;
    while (node) {
        if (node.userData?.isTable) return node;
        node = node.parent;
    }

    const tables = Array.isArray(window.labTables)
        ? window.labTables
        : [window.tableObject, window.labTable, window.tableMesh].filter(Boolean);
    return tables.find(table => table?.isObject3D && isDescendantOf(object, table)) || null;
}

function getLabTables(excludeObject = null) {
    const rawTables = Array.isArray(window.labTables)
        ? window.labTables
        : [window.tableObject, window.labTable, window.tableMesh];
    const seen = new Set();
    return rawTables.filter(table => {
        if (!table?.isObject3D || seen.has(table.uuid)) return false;
        seen.add(table.uuid);
        if (table.visible === false || table.userData?.isDeleted === true) return false;
        if (excludeObject && (table === excludeObject || isDescendantOf(table, excludeObject) || isDescendantOf(excludeObject, table))) return false;
        return true;
    });
}

function getTableSurfaceYForObject(object) {
    const table = getTableRoot(object) || object;
    if (!table?.isObject3D) return getTableSurfaceY();
    table.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(table);
    if (Number.isFinite(box.max.y)) return box.max.y;
    return Number(table.userData?.tableSurfaceY ?? getTableSurfaceY()) || getTableSurfaceY();
}

function getTableSurfaceUnderRay(ray, excludeObject = null) {
    const candidates = [];
    const plane = new three.Plane(new three.Vector3(0, 1, 0), 0);
    const point = new three.Vector3();

    getLabTables(excludeObject).forEach(table => {
        table.updateMatrixWorld(true);
        const box = new three.Box3().setFromObject(table);
        if (box.isEmpty() || !Number.isFinite(box.max.y)) return;

        plane.constant = -box.max.y;
        const hit = ray.intersectPlane(plane, point);
        if (!hit) return;

        const padding = 0.04;
        const insideTableFootprint =
            hit.x >= box.min.x - padding &&
            hit.x <= box.max.x + padding &&
            hit.z >= box.min.z - padding &&
            hit.z <= box.max.z + padding;
        if (!insideTableFootprint) return;

        candidates.push({
            table,
            point: hit.clone(),
            surfaceY: box.max.y,
            distanceSq: ray.origin.distanceToSquared(hit)
        });
    });

    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    return candidates[0] || null;
}

const MOVABLE_TABLE_PLACEMENT_PADDING = 0.12;
const ROOM_EDGE_PADDING = 0.18;

function isMovableTableObject(object) {
    return object?.userData?.isMovableTable === true;
}

function getRoomBounds() {
    const bounds = window.labRoomBounds || {};
    return {
        minX: Number.isFinite(bounds.minX) ? bounds.minX : -10,
        maxX: Number.isFinite(bounds.maxX) ? bounds.maxX : 10,
        minZ: Number.isFinite(bounds.minZ) ? bounds.minZ : -10,
        maxZ: Number.isFinite(bounds.maxZ) ? bounds.maxZ : 10
    };
}

function getObjectWorldBox(object, padding = 0) {
    object?.updateMatrixWorld?.(true);
    const box = new three.Box3().setFromObject(object);
    if (!box.isEmpty() && padding > 0) {
        box.expandByVector(new three.Vector3(padding, 0, padding));
    }
    return box;
}

function boxesOverlapXZ(boxA, boxB) {
    if (!boxA || !boxB || boxA.isEmpty() || boxB.isEmpty()) return false;
    return (
        boxA.min.x < boxB.max.x &&
        boxA.max.x > boxB.min.x &&
        boxA.min.z < boxB.max.z &&
        boxA.max.z > boxB.min.z
    );
}

function isObjectOrAncestor(object, maybeAncestor) {
    return object === maybeAncestor || isDescendantOf(object, maybeAncestor);
}

function collectMovableTableBlockers(object) {
    const blockers = [];
    const seen = new Set();
    const addBlocker = (candidate) => {
        if (!candidate?.isObject3D || seen.has(candidate.uuid)) return;
        if (candidate === object || isObjectOrAncestor(candidate, object) || isObjectOrAncestor(object, candidate)) return;
        if (candidate.visible === false || candidate.userData?.isDeleted === true) return;
        if (candidate.userData?.ignoreInteraction || candidate.userData?.isInternalChemicalVisual) return;
        seen.add(candidate.uuid);
        blockers.push(candidate);
    };

    const knownTables = Array.isArray(window.labTables)
        ? window.labTables
        : [window.tableObject, window.labTable, window.tableMesh];
    knownTables.forEach(addBlocker);
    addBlocker(window.chemicalCabinet);
    draggableObjects.forEach(addBlocker);

    return blockers;
}

function getMovableTablePlacementBlocker(object) {
    if (!isMovableTableObject(object)) return null;

    const tableBox = getObjectWorldBox(object, MOVABLE_TABLE_PLACEMENT_PADDING);
    const bounds = getRoomBounds();
    if (
        tableBox.min.x < bounds.minX + ROOM_EDGE_PADDING ||
        tableBox.max.x > bounds.maxX - ROOM_EDGE_PADDING ||
        tableBox.min.z < bounds.minZ + ROOM_EDGE_PADDING ||
        tableBox.max.z > bounds.maxZ - ROOM_EDGE_PADDING
    ) {
        return { reason: 'room-bounds' };
    }

    const blockers = collectMovableTableBlockers(object);
    return blockers.find(blocker => boxesOverlapXZ(tableBox, getObjectWorldBox(blocker))) || null;
}

function isMovableTablePlacementValid(object) {
    return !getMovableTablePlacementBlocker(object);
}

function clampMovableTableToRoom(object) {
    if (!isMovableTableObject(object)) return;
    object.updateMatrixWorld(true);

    const bounds = getRoomBounds();
    const box = getObjectWorldBox(object);
    let dx = 0;
    let dz = 0;

    if (box.min.x < bounds.minX + ROOM_EDGE_PADDING) dx = bounds.minX + ROOM_EDGE_PADDING - box.min.x;
    if (box.max.x > bounds.maxX - ROOM_EDGE_PADDING) dx = bounds.maxX - ROOM_EDGE_PADDING - box.max.x;
    if (box.min.z < bounds.minZ + ROOM_EDGE_PADDING) dz = bounds.minZ + ROOM_EDGE_PADDING - box.min.z;
    if (box.max.z > bounds.maxZ - ROOM_EDGE_PADDING) dz = bounds.maxZ - ROOM_EDGE_PADDING - box.max.z;

    if (dx || dz) {
        object.position.x += dx;
        object.position.z += dz;
        object.updateMatrixWorld(true);
    }
}

function updateMovableTablePlacementState(object) {
    if (!isMovableTableObject(object)) return true;
    clampMovableTableToRoom(object);
    const isValid = isMovableTablePlacementValid(object);
    object.userData.placementInvalid = !isValid;
    if (isValid) object.userData.lastValidFloorPosition = object.position.clone();
    return isValid;
}

export function findOpenFloorPositionForObject(object, options = {}) {
    if (!object?.isObject3D) return null;

    const savedPosition = object.position.clone();
    object.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(object);
    const offsetToFloor = Number.isFinite(object.userData?.offsetToFloor)
        ? object.userData.offsetToFloor
        : object.position.y - box.min.y;

    const preferredPositions = options.preferredPositions || [
        [-6.5, 4.8], [6.5, 4.8],
        [-6.5, -4.8], [6.5, -4.8],
        [-7.4, 0], [7.4, 0],
        [0, 6.6], [0, -6.6]
    ];

    const tryPosition = (x, z) => {
        object.position.set(x, offsetToFloor, z);
        clampMovableTableToRoom(object);
        object.updateMatrixWorld(true);
        return isMovableTablePlacementValid(object) ? object.position.clone() : null;
    };

    for (const [x, z] of preferredPositions) {
        const position = tryPosition(x, z);
        if (position) {
            object.position.copy(savedPosition);
            object.updateMatrixWorld(true);
            return position;
        }
    }

    const bounds = getRoomBounds();
    for (let x = bounds.minX + 2; x <= bounds.maxX - 2; x += 1) {
        for (let z = bounds.minZ + 2; z <= bounds.maxZ - 2; z += 1) {
            const position = tryPosition(x, z);
            if (position) {
                object.position.copy(savedPosition);
                object.updateMatrixWorld(true);
                return position;
            }
        }
    }

    object.position.copy(savedPosition);
    object.updateMatrixWorld(true);
    return null;
}

function liftObjectBottomToSurface(object, surfaceY, clearance = 0.01) {
    if (!object?.isObject3D || !Number.isFinite(surfaceY)) return false;
    object.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return false;

    const targetBottomY = surfaceY + clearance;
    if (box.min.y >= targetBottomY) return false;

    object.position.y += targetBottomY - box.min.y;
    object.updateMatrixWorld(true);
    updateOffsetToFloor(object);
    return true;
}

function getObjectWorldPositionClone(object) {
    const position = new three.Vector3();
    object?.updateMatrixWorld?.(true);
    object?.getWorldPosition?.(position);
    return position;
}

function getChemicalCabinetHome(object) {
    if (!isChemicalBottleObject(object)) return null;
    const data = object.userData || {};
    if (!data.cabinetParent?.isObject3D || !data.cabinetLocalPosition?.isVector3) return null;

    data.cabinetParent.updateMatrixWorld(true);
    const worldPosition = data.cabinetParent.localToWorld(data.cabinetLocalPosition.clone());

    return {
        parent: data.cabinetParent,
        localPosition: data.cabinetLocalPosition.clone(),
        localQuaternion: data.cabinetLocalQuaternion?.isQuaternion ? data.cabinetLocalQuaternion.clone() : null,
        localScale: data.cabinetLocalScale?.isVector3 ? data.cabinetLocalScale.clone() : null,
        worldPosition,
        worldQuaternion: data.cabinetWorldQuaternion?.isQuaternion ? data.cabinetWorldQuaternion.clone() : null,
        worldScale: data.cabinetWorldScale?.isVector3 ? data.cabinetWorldScale.clone() : null
    };
}

function markChemicalBottleOutOfCabinet(object) {
    if (isChemicalBottleObject(object) && object.userData) {
        object.userData.isInCabinet = false;
    }
}

function shouldReturnChemicalBottleToCabinet(object, intersections = [], options = {}) {
    const home = getChemicalCabinetHome(object);
    if (!home) return false;

    const hitCabinet = intersections.some(hit =>
        hit?.object &&
        !isDescendantOf(hit.object, object) &&
        isDescendantOf(hit.object, home.parent)
    );
    if (hitCabinet) return true;
    if (options.allowNearHome !== true) return false;

    const current = getObjectWorldPositionClone(object);
    const dx = current.x - home.worldPosition.x;
    const dz = current.z - home.worldPosition.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    const verticalDistance = Math.abs(current.y - home.worldPosition.y);
    const maxHomeDistance = options.maxHomeDistance ?? 1.4;
    const maxVerticalDistance = options.maxVerticalDistance ?? 3.0;

    return horizontalDistance <= maxHomeDistance && verticalDistance <= maxVerticalDistance;
}

function returnChemicalBottleToCabinetHome(object) {
    const home = getChemicalCabinetHome(object);
    if (!home) return false;

    home.parent.add(object);
    object.position.copy(home.localPosition);
    if (home.localQuaternion) {
        object.quaternion.copy(home.localQuaternion);
        object.rotation.setFromQuaternion(object.quaternion, object.rotation.order || 'YXZ');
    }
    if (home.localScale) object.scale.copy(home.localScale);

    object.userData.isInCabinet = true;
    object.userData.keepManualRotation = false;
    object.userData.wasManuallyRotated = false;
    if (home.localScale) object.userData.customScale = home.localScale.clone();
    object.userData.hasCustomScale = true;

    object.updateMatrixWorld(true);
    const worldQuaternion = new three.Quaternion();
    const worldScale = new three.Vector3();
    object.getWorldQuaternion(worldQuaternion);
    object.getWorldScale(worldScale);
    object.userData.chemicalBottleUprightWorldQuaternion = worldQuaternion.clone();
    object.userData.originalWorldQuaternion = worldQuaternion.clone();
    object.userData.originalQuaternion = worldQuaternion.clone();
    object.userData.customWorldScale = worldScale.clone();
    object.userData.originalWorldScale = worldScale.clone();
    updateOffsetToFloor(object);
    if (pouringEffect) pouringEffect.invalidateCavity(object);
    return true;
}

function getWorldQuaternionClone(object) {
    const quaternion = new three.Quaternion();
    object?.getWorldQuaternion?.(quaternion);
    return quaternion;
}

function captureHoldRotationState(object) {
    if (!object?.userData || !object.rotation) return;
    object.updateMatrixWorld(true);
    const worldQuaternion = getWorldQuaternionClone(object);
    object.userData.rotationBeforeHold = object.rotation.clone();
    object.userData.worldQuaternionBeforeHold = worldQuaternion.clone();

    if (isChemicalBottleObject(object) && !object.userData.chemicalBottleUprightWorldQuaternion) {
        object.userData.chemicalBottleUprightWorldQuaternion =
            object.userData.originalWorldQuaternion?.clone?.() || worldQuaternion.clone();
    }
}

function restoreRotationAfterHoldDrop(object, wasManuallyRotated = false) {
    if (!object?.userData || !object.rotation) return false;

    const applyWorldQuaternion = (quaternion) => {
        if (!quaternion?.isQuaternion) return false;
        object.quaternion.copy(quaternion);
        object.rotation.setFromQuaternion(object.quaternion, object.rotation.order || 'YXZ');
        object.updateMatrixWorld(true);
        return true;
    };

    if (isChemicalBottleObject(object)) {
        object.userData.keepManualRotation = false;
        object.userData.wasManuallyRotated = false;
        return applyWorldQuaternion(
            object.userData.chemicalBottleUprightWorldQuaternion ||
            object.userData.originalWorldQuaternion ||
            object.userData.worldQuaternionBeforeHold
        );
    }

    if (wasManuallyRotated) return false;

    if (applyWorldQuaternion(object.userData.worldQuaternionBeforeHold)) return true;

    if (object.userData.rotationBeforeHold) {
        object.rotation.copy(object.userData.rotationBeforeHold);
        object.updateMatrixWorld(true);
        return true;
    }

    object.rotation.set(
        object.userData.defaultRotationX || 0,
        object.userData.defaultRotationY || 0,
        object.userData.defaultRotationZ || 0
    );
    object.updateMatrixWorld(true);
    return true;
}

function hasToolCapability(obj, capability) {
    const capabilities = obj?.userData?.capabilities || obj?.userData?.toolData?.capabilities || [];
    return Array.isArray(capabilities) && capabilities.includes(capability);
}

function isPourReceiver(obj) {
    if (!obj?.userData?.toolData) return false;
    if (obj.userData.isHeatingSource || obj.userData.isSupportStand || obj.userData.canSupportTools) return false;

    const toolType = String(obj.userData.toolType || obj.userData.tool_type || obj.userData.toolData?.tool_type || '').toLowerCase();
    if (toolType === 'container' || toolType === 'dropping_funnel') return true;

    return hasToolCapability(obj, 'receive_liquid') ||
        hasToolCapability(obj, 'contain_liquid') ||
        hasToolCapability(obj, 'contain_solid') ||
        hasToolCapability(obj, 'react');
}

function getChemicalId(obj) {
    return obj?.userData?.current_chemical_id || obj?.userData?.id_chemical || obj?.userData?.chemicalId || null;
}

function getChemicalType(obj) {
    return obj?.userData?.current_chemical_type || obj?.userData?.chemicalType || obj?.userData?.chemical_type || null;
}

function getChemicalName(obj) {
    return obj?.userData?.current_chemical_name || obj?.userData?.chemicalName || obj?.userData?.name_vi || 'Hóa chất';
}

function getChemicalColor(obj) {
    return obj?.userData?.liquidColor || obj?.userData?.color || '#3498db';
}

function getPhysicalState(obj) {
    return obj?.userData?.current_physical_state || obj?.userData?.physical_state || obj?.userData?.physicalState || obj?.userData?.state || 'Lỏng';
}

function getVisiblePourAmount(quantity = {}) {
    const amount = Number(quantity.amount);
    const unit = String(quantity.unit || 'ml').toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return 0.12;
    if (unit.includes('ml')) return three.MathUtils.clamp(amount * 0.035, 0.12, 0.42);
    if (unit.includes('l')) return three.MathUtils.clamp(amount * 0.55, 0.16, 0.52);
    return three.MathUtils.clamp(amount * 0.04, 0.1, 0.35);
}

function queueLiquidLevelRise(container, amount = 0.003, options = {}) {
    if (!container?.userData) return 0;

    const current = Number(container.userData.liquidLevel || 0);
    const queued = Number.isFinite(Number(container.userData.targetLiquidLevel))
        ? Number(container.userData.targetLiquidLevel)
        : current;
    const increment = Math.max(0, Number(amount) || 0.003);
    const nextTarget = three.MathUtils.clamp(Math.max(current, queued) + increment, 0, 0.86);

    container.userData.targetLiquidLevel = nextTarget;
    container.userData.liquidRiseSpeed = options.direct ? 0.0018 : 0.0028;

    if (current <= 0 && nextTarget > 0) {
        container.userData.liquidLevel = Math.min(nextTarget, 0.015);
    }

    return nextTarget;
}

function rememberContainerContents(container, ...items) {
    if (!container?.userData) return;
    const set = new Set(container.userData.contents || []);
    items.flat().filter(Boolean).forEach(item => set.add(String(item)));
    container.userData.contents = Array.from(set);
}

function addContainerComposition(container, ...items) {
    if (!container?.userData) return;
    if (!container.userData.composition) container.userData.composition = {};
    items.flat().filter(Boolean).forEach(item => {
        const key = String(item);
        container.userData.composition[key] = (Number(container.userData.composition[key]) || 0) + 1;
    });
}

function applyReactionState(container, reaction) {
    if (!container?.userData || !reaction) return;
    const state = reaction.producesState || reaction.produces_state || {};
    Object.entries(state).forEach(([key, value]) => {
        if (value === null) {
            delete container.userData[key];
        } else {
            container.userData[key] = value;
        }
    });
    if (state.precipitateSpecies) {
        container.userData.hasPrecipitate = true;
        container.userData.precipitateSpecies = state.precipitateSpecies;
    }
    if (state.complexIon) {
        rememberContainerContents(container, state.complexIon);
        addContainerComposition(container, state.complexIon);
    }
}

function removeInternalLayer(container, layerName) {
    const layer = container?.getObjectByName?.(layerName);
    if (!layer) return;
    layer.traverse?.(child => {
        if (child.geometry) child.geometry.dispose?.();
        if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
            else child.material.dispose?.();
        }
    });
    layer.parent?.remove(layer);
}

function clearPrecipitateLayer(container) {
    removeInternalLayer(container, 'precipitateLayer');
    if (container?.userData) {
        container.userData.hasPrecipitate = false;
        container.userData.precipitateColor = null;
        container.userData.precipitateSpecies = null;
    }
}

function createSilverMirrorCoating(container) {
    if (!container) return null;
    removeInternalLayer(container, 'silverMirrorLayer');

    const layer = new three.Group();
    layer.name = 'silverMirrorLayer';
    markInternalEffect(layer, container);

    const box = new three.Box3().setFromObject(container);
    const inv = container.matrixWorld.clone().invert();
    const min = box.min.clone().applyMatrix4(inv);
    const max = box.max.clone().applyMatrix4(inv);
    const sx = Math.max(0.045, Math.abs(max.x - min.x) * 0.34);
    const sz = Math.max(0.045, Math.abs(max.z - min.z) * 0.34);
    const h = Math.max(0.08, Math.abs(max.y - min.y) * 0.34);
    const y = Math.min(min.y, max.y) + h * 0.72;

    const geometry = new three.CylinderGeometry(sx, sx * 0.95, h, 48, 1, true);
    geometry.scale(1, 1, sz / sx);
    const material = new three.MeshPhysicalMaterial({
        color: '#dfe4ea',
        metalness: 1.0,
        roughness: 0.03,
        transparent: true,
        opacity: 0.72,
        side: three.DoubleSide,
        envMapIntensity: 2.0
    });
    const mesh = new three.Mesh(geometry, material);
    mesh.name = 'silver_mirror_inner_wall';
    mesh.position.set((min.x + max.x) * 0.5, y, (min.z + max.z) * 0.5);
    markInternalEffect(mesh, container);
    layer.add(mesh);
    container.add(layer);
    container.userData.hasSilverMirror = true;
    return layer;
}

function isContainerHoldingLiquid(obj) {
    return !!(
        obj?.userData &&
        (
            (obj.userData.liquidLevel || 0) > 0 ||
            obj.userData.liquidColor ||
            obj.getObjectByName?.('liquid_group')
        )
    );
}

function markInternalEffect(obj, container = null) {
    if (!obj) return obj;
    obj.userData.ignoreInteraction = true;
    obj.userData.isInternalChemicalVisual = true;
    obj.userData.isReactionEffect = true;
    obj.userData.notDraggable = true;
    obj.userData.ignoreRaycast = true;
    if (container) obj.userData.container = container;
    obj.raycast = () => null;
    obj.traverse?.(child => {
        child.userData.ignoreInteraction = true;
        child.userData.isInternalChemicalVisual = true;
        child.userData.isReactionEffect = true;
        child.userData.notDraggable = true;
        child.userData.ignoreRaycast = true;
        if (container) child.userData.container = container;
        child.raycast = () => null;
    });
    return obj;
}

function removeLocalEffectGroup(container, name) {
    const group = container?.userData?.[name] || container?.getObjectByName?.(name);
    if (!group) return;
    group.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(m => m?.dispose?.());
        else child.material?.dispose?.();
    });
    group.parent?.remove(group);
    if (container?.userData) delete container.userData[name];
}

function clearDissolvablePowder(container) {
    // Khi rắn gặp lỏng và không tạo kết tủa, bột ban đầu phải hòa tan, không còn lớp hạt rắn nhìn thấy.
    removeLocalEffectGroup(container, 'powderDeposit');
    removeLocalEffectGroup(container, 'powderDepositLayer');
}

const TOOL_CHEMICAL_OBJECT_KEYS = [
    'liquidVolume',
    'liquidMesh',
    'liquidObject',
    'liquid',
    'volumeGroup',
    'liquidGroup',
    'fillMesh',
    'marchingCubesVolume',
    'powderDeposit',
    'powderDepositLayer',
    'precipitateLayer',
    'silverMirrorLayer',
    'phaseSeparationLayer'
];

const TOOL_CHEMICAL_OBJECT_NAMES = new Set([
    'liquid_group',
    'fluid_volume',
    'powderdeposit',
    'powderdepositlayer',
    'solid_powder_inside_container',
    'precipitatelayer',
    'precipitate_inside_container',
    'silvermirrorlayer',
    'silver_mirror_inner_wall',
    'phaseseparationlayer'
]);

function isToolChemicalVisual(object, tool = null) {
    if (!object || object === tool) return false;
    const data = object.userData || {};
    const name = String(object.name || '').toLowerCase();
    return Boolean(
        data.isLiquid === true ||
        data.isChemicalVolume === true ||
        data.isInternalChemicalVisual === true ||
        data.isPowder === true ||
        TOOL_CHEMICAL_OBJECT_NAMES.has(name)
    );
}

function toolHasChemical(tool) {
    if (!tool?.userData || isChemicalBottleObject(tool)) return false;

    const data = tool.userData;
    if (
        data.currentChemical ||
        data.containedChemical ||
        data.current_chemical_id ||
        data.current_chemical_type ||
        data.current_chemical_name ||
        data.chemicalName ||
        data.chemicalType ||
        data.liquidVolume ||
        data.liquidMesh ||
        data.liquidObject ||
        data.liquid ||
        data.volumeGroup ||
        data.liquidGroup ||
        data.fillMesh ||
        data.marchingCubesVolume ||
        data.hasLiquid === true ||
        data.hasSolidDeposit === true ||
        data.hasPrecipitate === true ||
        data.hasSilverMirror === true
    ) {
        return true;
    }

    const volumeValues = [
        data.liquidVolume,
        data.liquidLevel,
        data.targetLiquidLevel,
        data.currentLiquidVolume,
        data.currentVolume,
        data.fillLevel,
        data.experimentState?.totalVolume
    ];
    if (volumeValues.some(value => Number(value) > 0)) return true;

    if (Array.isArray(data.chemicals) && data.chemicals.length > 0) return true;
    if (Array.isArray(data.contents) && data.contents.length > 0) return true;
    if (Array.isArray(data.products) && data.products.length > 0) return true;
    if (Array.isArray(data.reactionProducts) && data.reactionProducts.length > 0) return true;
    if (data.composition && Object.keys(data.composition).length > 0) return true;
    if (Array.isArray(data.experimentState?.contents) && data.experimentState.contents.length > 0) return true;

    let found = false;
    tool.traverse(child => {
        if (isToolChemicalVisual(child, tool)) found = true;
    });

    return found;
}

function collectToolChemicalObjects(tool) {
    const objects = new Set();
    const addObject = (object) => {
        if (object?.isObject3D && object !== tool) objects.add(object);
    };

    const volume = pouringEffect?.volumes?.get?.(tool);
    addObject(volume);
    addObject(volume?.userData?.group);

    TOOL_CHEMICAL_OBJECT_KEYS.forEach(key => addObject(tool?.userData?.[key]));
    TOOL_CHEMICAL_OBJECT_NAMES.forEach(name => addObject(tool?.getObjectByName?.(name)));

    tool?.traverse?.(child => {
        if (isToolChemicalVisual(child, tool)) addObject(child);
    });

    return Array.from(objects).filter(object =>
        !Array.from(objects).some(other => other !== object && isDescendantOf(object, other))
    );
}

function removeObject3DFromScene(object, fallbackScene = null) {
    if (!object) return;
    object.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(material => material?.dispose?.());
        else child.material?.dispose?.();
    });

    if (object.parent) object.parent.remove(object);
    else fallbackScene?.remove?.(object);
}

function resetToolChemicalState(tool) {
    if (!tool?.userData) return;
    const data = tool.userData;

    [
        'currentChemical',
        'containedChemical',
        'current_chemical_id',
        'current_chemical_type',
        'current_chemical_name',
        'chemicalType',
        'chemicalName',
        'current_physical_state',
        'physical_state',
        'liquidColor',
        'pendingReaction',
        'pendingReason',
        'pendingSourceSnapshot',
        'pendingReactionStartedAt',
        'indicator',
        'complexIon',
        'precipitateColor',
        'precipitateSpecies',
        'upperLayerColor',
        'lowerLayerColor'
    ].forEach(key => {
        data[key] = null;
    });

    TOOL_CHEMICAL_OBJECT_KEYS.forEach(key => {
        data[key] = null;
    });

    data.hasLiquid = false;
    data.hasSolidDeposit = false;
    data.hasPrecipitate = false;
    data.hasSilverMirror = false;
    data.hasGasEffect = false;
    data.hasSmokeEffect = false;
    data.twoLayerLiquid = false;
    data.phaseSeparated = false;
    data.isReacting = false;

    data.liquidLevel = 0;
    data.targetLiquidLevel = 0;
    data.liquidVolume = null;
    data.currentLiquidVolume = 0;
    data.maxLiquidVolume = 0;
    data.currentVolume = 0;
    data.fillLevel = 0;

    data.chemicals = [];
    data.contents = [];
    data.products = [];
    data.reactionProducts = [];
    data.composition = {};

    if (data.experimentState) {
        data.experimentState.contents = [];
        data.experimentState.totalVolume = 0;
        data.experimentState.reactionHistory = [];
    }
}

function removeChemicalFromTool(tool, scene = null) {
    if (!tool) return false;

    const objectsToRemove = collectToolChemicalObjects(tool);
    pouringEffect?.clearSmokeEffectForTarget?.(tool);
    pouringEffect?.volumes?.delete?.(tool);

    objectsToRemove.forEach(object => removeObject3DFromScene(object, scene));
    resetToolChemicalState(tool);
    pouringEffect?.invalidateCavity?.(tool);
    return objectsToRemove.length > 0;
}

function formatReactionMessage(reaction) {
    const raw = reaction?.raw || {};
    const speech = reaction?.reactionMessage || raw?.reaction_message || raw?.reactionMessage || 'Phản ứng hóa học đã xảy ra.';
    const equation = reaction?.equation || raw?.reaction_data?.equation || raw?.equation || '';
    return equation ? `${speech}\n${equation}` : speech;
}

function resolveDraggableRoot(hitObject) {
    let node = hitObject;
    while (node) {
        if (draggableObjects.includes(node)) return node;
        if (node.userData?.root && draggableObjects.includes(node.userData.root)) return node.userData.root;
        if (node.userData?.container && draggableObjects.includes(node.userData.container)) return node.userData.container;
        if (node.userData?.ignoreInteraction || node.userData?.isInternalChemicalVisual) return null;
        node = node.parent;
    }
    return null;
}

function findRootTool(object) {
    let current = object;

    while (current) {
        if (draggableObjects.includes(current)) return current;
        if (current.userData?.root && draggableObjects.includes(current.userData.root)) return current.userData.root;
        if (current.userData?.container && draggableObjects.includes(current.userData.container)) return current.userData.container;
        if (current.userData?.toolData || current.userData?.isTool) return current;
        current = current.parent;
    }

    return null;
}

function getInteractionCandidates() {
    return draggableObjects.filter(obj =>
        obj &&
        obj !== heldObjectRight &&
        obj !== heldObjectLeft &&
        obj.visible !== false &&
        obj.userData?.isDeleted !== true &&
        obj.userData?.toolData?.is_deleted !== true &&
        !obj.userData?.ignoreInteraction &&
        !obj.userData?.isInternalChemicalVisual
    );
}

function getWorldCenter(obj) {
    const box = new three.Box3().setFromObject(obj);
    const center = new three.Vector3();
    box.getCenter(center);
    return center;
}

function getObjectWorldScale(object) {
    const scale = new three.Vector3(1, 1, 1);
    object?.updateMatrixWorld?.(true);
    object?.getWorldScale?.(scale);
    return scale;
}

function getLocalScaleForWorldScale(parent, worldScale) {
    const parentScale = new three.Vector3(1, 1, 1);
    parent?.updateMatrixWorld?.(true);
    parent?.getWorldScale?.(parentScale);

    return new three.Vector3(
        worldScale.x / (Math.abs(parentScale.x) > 1e-6 ? parentScale.x : 1),
        worldScale.y / (Math.abs(parentScale.y) > 1e-6 ? parentScale.y : 1),
        worldScale.z / (Math.abs(parentScale.z) > 1e-6 ? parentScale.z : 1)
    );
}

function getSavedScale(object) {
    if (!object?.scale) return new three.Vector3(1, 1, 1);
    return object.userData?.customWorldScale?.clone?.() || getObjectWorldScale(object);
}

function rememberCustomScale(object, worldScale = null) {
    if (!object?.userData || !object?.scale) return null;
    const savedWorld = worldScale?.clone?.() || getObjectWorldScale(object);
    object.userData.customWorldScale = savedWorld;
    object.userData.customScale = getLocalScaleForWorldScale(object.parent, savedWorld);
    object.userData.hasCustomScale = true;
    console.log('[Scale] saved display scale:', savedWorld);
    return savedWorld;
}

function restoreCustomScale(object, savedWorldScale = null) {
    if (!object?.scale) return;
    const worldScale = savedWorldScale?.clone?.() || object.userData?.customWorldScale?.clone?.();
    if (!worldScale) return;
    object.scale.copy(getLocalScaleForWorldScale(object.parent, worldScale));
}

function updateOffsetToFloor(object) {
    if (!object?.userData) return;
    object.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(object);
    object.userData.offsetToFloor = object.position.y - box.min.y;
}

function attachKeepWorldTransform(parent, child) {
    if (!parent || !child) return;
    child.updateMatrixWorld(true);
    const savedScale = getSavedScale(child);
    console.log('[Scale] before move:', child.scale);
    parent.attach(child);
    restoreCustomScale(child, savedScale);
    rememberCustomScale(child, savedScale);
    child.updateMatrixWorld(true);
    console.log('[Scale] after move:', child.scale);
}

async function persistToolScale(object) {
    const idTool = object?.userData?.toolData?.id_tool || object?.userData?.id_tool;
    if (!idTool || !object?.scale) return;
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const scale = object.scale;
    try {
        const baseUrl = window.API_URL || 'http://127.0.0.1:8000';
        await fetch(`${baseUrl}/api/lab/tools/${idTool}/scale`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                scale_x: scale.x,
                scale_y: scale.y,
                scale_z: scale.z
            })
        });
    } catch (error) {
        console.warn('[Scale] failed to persist scale:', error);
    }
}

export const draggableObjects = [];
let heldObjectRight = null; // Đối tượng tay phải
let heldObjectLeft = null;  // Đối tượng tay trái
let isInspectingRight = false;
let isInspectingLeft = false;

const raycaster = new three.Raycaster();
const mouse = new three.Vector2();
const movePlane = new three.Plane(new three.Vector3(0, 1, 0), 0);
const planeIntersectPoint = new three.Vector3();
let selectedObjectForMenu = null;
let draggedObject = null;

async function persistToolRotation(object) {
    const idTool = object?.userData?.toolData?.id_tool || object?.userData?.id_tool;
    if (!idTool || !object?.rotation) return;
    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const baseUrl = window.API_URL || 'http://127.0.0.1:8000';
        await fetch(`${baseUrl}/api/lab/tools/${idTool}/rotation`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                rotation_x: object.rotation.x,
                rotation_y: object.rotation.y,
                rotation_z: object.rotation.z
            })
        });
    } catch (error) {
        console.warn('[ToolRotate] persist rotation failed:', error);
    }
}


function getToolId(object) {
    return object?.userData?.toolData?.id_tool || object?.userData?.id_tool;
}

async function persistToolSoftDelete(object) {
    const idTool = getToolId(object);
    if (!idTool) throw new Error('Không tìm thấy id_tool của dụng cụ');

    const token = localStorage.getItem('access_token');
    if (!token) throw new Error('Bạn cần đăng nhập để xóa dụng cụ');

    const baseUrl = window.API_URL || 'http://127.0.0.1:8000';
    const res = await fetch(`${baseUrl}/api/lab/tools/${idTool}/soft-delete`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        }
    });

    if (!res.ok) {
        let detail = 'Không thể xóa dụng cụ';
        try {
            const data = await res.json();
            detail = data?.detail || detail;
        } catch (_) {}
        throw new Error(detail);
    }

    return res.json();
}

function disposeObjectResources(object) {
    object?.traverse?.((child) => {
        if (child.geometry?.dispose) child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) {
            material.forEach(m => m?.dispose?.());
        } else if (material?.dispose) {
            material.dispose();
        }
    });
}

function removeToolFromCurrentLab(object, scene) {
    if (!object) return;

    object.userData.isDeleted = true;
    if (object.userData.toolData) object.userData.toolData.is_deleted = true;

    if (heldObjectRight === object) heldObjectRight = null;
    if (heldObjectLeft === object) heldObjectLeft = null;
    if (draggedObject === object) draggedObject = null;
    if (selectedObjectForMenu === object) selectedObjectForMenu = null;

    try { releaseContainerFromSupportStand(object); } catch (_) {}
    try { releaseContainerFromHeatingSource(object); } catch (_) {}
    try { releaseHeatingSourceFromSupportStand(object); } catch (_) {}
    try { window.labAssemblyManager?.detachMagneticBinding?.(object); } catch (_) {}

    const draggableIndex = draggableObjects.indexOf(object);
    if (draggableIndex !== -1) draggableObjects.splice(draggableIndex, 1);
    if (object.userData?.isMovableTable && Array.isArray(window.labTables)) {
        const tableIndex = window.labTables.indexOf(object);
        if (tableIndex !== -1) window.labTables.splice(tableIndex, 1);
    }

    object.traverse?.((child) => {
        if (child.userData) {
            child.userData.root = null;
            child.userData.container = null;
            child.userData.isInteractable = false;
            child.userData.ignoreInteraction = true;
        }
    });

    object.visible = false;
    if (object.parent) {
        object.parent.remove(object);
    } else if (scene) {
        scene.remove(object);
    }

    const instanceId = object.userData?.instanceId;
    if (instanceId) {
        document.getElementById(`ui-${instanceId}`)?.remove();
    }

    const list = document.getElementById('tool-list');
    if (list && !list.querySelector('li')) {
        list.innerHTML = '<li class="text-gray-500 text-xs italic py-2">Bàn trống...</li>';
    }

    disposeObjectResources(object);
    window.heatingManager?.unregisterObject?.(object);
    window.labAssemblyManager?.unregisterObject?.(object);
}

function markToolManuallyRotated(object) {
    if (!object?.userData) return;
    object.userData.wasManuallyRotated = true;
    object.userData.manualRotationDirty = true;
    object.userData.keepManualRotation = true;
}

function rotateToolObject(object, dx = 0, dy = 0, dz = 0, currentMode = 'normal') {
    if (!object?.rotation) return false;
    const savedPosition = object.position?.clone?.();
    const savedScale = getSavedScale(object);

    object.rotation.order = object.rotation.order || 'YXZ';
    object.rotation.x += dx;
    object.rotation.y += dy;
    object.rotation.z += dz;

    if (savedPosition && object.position) object.position.copy(savedPosition);
    restoreCustomScale(object, savedScale);
    rememberCustomScale(object, savedScale);
    markToolManuallyRotated(object);
    object.updateMatrixWorld(true);

    console.log('[ToolRotate] mode:', currentMode);
    console.log('[ToolRotate] object:', object.name || object.userData?.name_tool_vi || object.userData?.toolData?.name_tool_vi || object.uuid);
    console.log('[ToolRotate] rotation:', object.rotation);
    console.log('[ToolRotate] scale preserved:', object.scale);
    return true;
}

function translateToolObject(object, worldDelta, options = {}) {
    if (!object?.isObject3D || !worldDelta) return false;
    if (worldDelta.lengthSq?.() === 0) return false;

    const savedScale = getSavedScale(object);
    if (options.detachAssembly !== false) {
        releaseHeatingSnapIfNeeded(object);
    }

    moveObjectByWorldDelta(object, worldDelta);
    if (options.keepAboveTable !== false) {
        keepObjectAboveTable(object, getTableSurfaceY(), 0);
    }

    restoreCustomScale(object, savedScale);
    rememberCustomScale(object, savedScale);
    updateOffsetToFloor(object);
    if (pouringEffect) pouringEffect.invalidateCavity(object);
    object.updateMatrixWorld(true);
    return true;
}


function toggleHeatingForObject(object) {
    if (!canToggleHeatingSource(object)) {
        notifyLab('Dụng cụ này không phải nguồn nhiệt có thể bật/tắt.');
        return false;
    }
    const isOn = toggleHeatingSource(object);
    const name = object.userData.toolData?.name_tool_vi || object.userData.toolData?.name_tool_en || 'nguồn nhiệt';
    notifyLab(isOn ? `Đã bật ${name}.` : `Đã tắt ${name}.`);
    return true;
}

function isHeatingContainer(object) {
    return object?.userData?.toolType === 'container';
}

function isHeatingSourceObject(object) {
    return object?.userData?.isHeatingSource === true;
}

function isAutoAssemblySnapEnabled() {
    return window.ENABLE_AUTO_ASSEMBLY_SNAP === true;
}

function isAutoCollisionSeparationEnabled() {
    return window.ENABLE_AUTO_COLLISION_SEPARATION === true;
}

function snapToHeatingSourceIfNear(object) {
    if (!isAutoAssemblySnapEnabled()) {
        if (object?.userData?.isUnderSupportStand) releaseHeatingSourceFromSupportStand(object);
        return false;
    }

    const tryAssemblyConnect = () => {
        const connection = window.labAssemblyManager?.tryAutoConnect?.(object, draggableObjects, { maxDistance: 0.9 });
        if (connection && pouringEffect) pouringEffect.invalidateCavity(object);
        return Boolean(connection);
    };

    if (tryAssemblyConnect()) return true;

    if (isHeatingSourceObject(object)) {
        // NEW HEATING RULE:
        // Không tự snap/đẩy/căn nguồn nhiệt vào giá đỡ hoặc dụng cụ cần đun.
        // Người dùng tự đặt nguồn nhiệt ở đâu thì giữ nguyên ở đó.
        if (object.userData?.isUnderSupportStand) releaseHeatingSourceFromSupportStand(object);
        return false;
    }
    if (!isHeatingContainer(object)) return false;

    // Không snap container vào nguồn nhiệt nữa. HeatingManager chỉ kiểm tra vị trí thực tế.
    return false;
}

function snapToMagneticSnapPointIfNear(object) {
    const binding = window.labAssemblyManager?.tryMagneticSnapAndBind?.(object, draggableObjects, {
        maxDistance: SNAP_DISTANCE
    });
    if (!binding) return false;
    updateOffsetToFloor(object);
    if (pouringEffect) pouringEffect.invalidateCavity(object);
    return true;
}

function completeAssemblyDrop(object) {
    if (!object?.isObject3D) return false;
    if (isMovableTableObject(object)) return true;
    const legacySnapped = snapToHeatingSourceIfNear(object);
    if (legacySnapped) {
        window.labAssemblyManager?.detachMagneticBinding?.(object, { preserveWorld: false });
        return true;
    }

    if (snapToMagneticSnapPointIfNear(object)) return true;
    return Boolean(window.labAssemblyManager?.finalizeMagneticDrag?.(object));
}

function releaseHeatingSnapIfNeeded(object) {
    if (!object?.userData) return;
    window.labAssemblyManager?.disconnectTool?.(object);
    if (object.userData.isSnappedToSupport) releaseContainerFromSupportStand(object);
    if (object.userData.isSnappedToHeatingSource) releaseContainerFromHeatingSource(object);
    if (object.userData.isUnderSupportStand) releaseHeatingSourceFromSupportStand(object);
}

function toolDisplayName(object) {
    return object?.userData?.toolData?.name_tool_vi ||
        object?.userData?.toolData?.name_tool_en ||
        object?.userData?.name_vi ||
        object?.name ||
        'dụng cụ';
}

function toggleManualAssembly(object) {
    if (!object?.isObject3D) return false;

    if (object.userData?.isAttached || object.userData?.parentTool) {
        window.labAssemblyManager?.detachMagneticBinding?.(object);
        updateOffsetToFloor(object);
        notifyLab?.(`ÄÃ£ thÃ¡o ${toolDisplayName(object)} khá»i liÃªn káº¿t.`);
        return true;
    }

    if (object.userData?.isAssemblySnapped || object.userData?.assemblyConnections?.length) {
        releaseHeatingSnapIfNeeded(object);
        updateOffsetToFloor(object);
        notifyLab?.(`Đã tháo ${toolDisplayName(object)} khỏi vị trí lắp.`);
        return true;
    }

    const connection = window.labAssemblyManager?.tryAutoConnect?.(object, draggableObjects, { maxDistance: 1.15 });
    if (!connection) {
        notifyLab?.('Chưa có điểm lắp hợp lệ gần dụng cụ này. Hãy đưa dụng cụ lại gần cổ bình, giá đỡ, ống dẫn hoặc vị trí cần gắn rồi bấm M.');
        return false;
    }

    updateOffsetToFloor(object);
    resolvePlacementOverlapAfterLegacyLogic(object);
    if (pouringEffect) pouringEffect.invalidateCavity(object);
    notifyLab?.(`Đã lắp ${toolDisplayName(object)} vào vị trí phù hợp.`);
    return true;
}

function resolvePlacementOverlapAfterLegacyLogic(object, options = {}) {
    if (!object?.isObject3D) return;
    const savedScale = getSavedScale(object);

    if (object.userData?.isOnSupportStand && object.userData?.supportStand) {
        if (object.userData?.isAssemblySnapped && window.labAssemblyManager?.enforceConnectionPlacement?.(object)) {
            restoreCustomScale(object, savedScale);
            rememberCustomScale(object, savedScale);
            object.updateMatrixWorld(true);
            return;
        }
        // Dụng cụ trên giá đỡ phải bám tâm/slot của support anchor.
        // Không dùng collision push tự do vì dễ làm lệch khỏi tâm giá đỡ.
        applySupportSlotOffset(object, object.userData.supportStand);
        restoreCustomScale(object, savedScale);
        rememberCustomScale(object, savedScale);
        object.updateMatrixWorld(true);
        return;
    }

    const allowCollisionSeparation = options.allowCollisionSeparation ?? isAutoCollisionSeparationEnabled();
    if (allowCollisionSeparation) {
        resolveObjectOverlap(object, draggableObjects, {
            padding: 0.08,
            maxIterations: 5
        });
    }

    restoreCustomScale(object, savedScale);
    rememberCustomScale(object, savedScale);
    object.updateMatrixWorld(true);
}

export let pouringEffect;
let lastPouredTarget = null;
let isPouringAction = false;
let activePourSource = null;
let selectedDirectPourSource = null;
export const pouringState = { currentPourTargetPos: null }; // Sử dụng object state chuẩn

// Nhóm đại diện cho 2 tay người chơi, gắn vào camera
const leftArmGroup = new three.Group();
const rightArmGroup = new three.Group();

function createArm(isRight = true) {
    const armGroup = new three.Group();

    const skinMaterial = new three.MeshPhysicalMaterial({
        color: 0xdbac82,
        roughness: 0.6,
        metalness: 0.05,
        clearcoat: 0.1,
        sheen: 0.5,
        sheenColor: 0xffffff
    });

    // Cánh tay (Forearm)
    const armGeo = new three.CylinderGeometry(0.035, 0.05, 0.65, 16);
    const armMat = new three.MeshStandardMaterial({ color: 0xe0ac69 });
    const armMesh = new three.Mesh(armGeo, armMat);
    armMesh.rotation.x = Math.PI / 2;
    armMesh.position.z = -0.325; // nủa chiều dài 0.65
    armGroup.add(armMesh);

    armGroup.position.set(isRight ? 0.38 : -0.38, -0.68, -0.32);
    const handGroup = new three.Group();
    handGroup.position.z = -0.8;
    armGroup.add(handGroup);

    const palmGeo = new three.BoxGeometry(0.12, 0.04, 0.14);
    const palmMesh = new three.Mesh(palmGeo, skinMaterial);
    handGroup.add(palmMesh);

    // Tạo các ngón tay
    const fingerData = [
        { name: 'thumb', x: 0.07, z: -0.02, rotY: 0.6, rotZ: -0.4, scale: 0.8 },
        { name: 'index', x: 0.04, z: -0.08, rotY: 0.1, rotZ: 0, scale: 1.0 },
        { name: 'middle', x: 0.01, z: -0.09, rotY: 0, rotZ: 0, scale: 1.1 },
        { name: 'ring', x: -0.02, z: -0.085, rotY: -0.1, rotZ: 0, scale: 1.0 },
        { name: 'pinky', x: -0.05, z: -0.07, rotY: -0.2, rotZ: 0, scale: 0.8 }
    ];

    fingerData.forEach(data => {
        const finger = new three.Group();
        const sideMult = isRight ? 1 : -1;
        finger.position.set(data.x * sideMult, 0, data.z);
        finger.rotation.y = data.rotY * sideMult;
        finger.rotation.z = data.rotZ * sideMult;

        // Đốt ngón tay 1
        const seg1Geo = new three.CylinderGeometry(0.012, 0.014, 0.06 * data.scale, 8);
        const seg1 = new three.Mesh(seg1Geo, skinMaterial);
        seg1.name = "seg1";
        seg1.position.z = -0.03 * data.scale;
        finger.add(seg1);

        // Đốt ngón tay 2
        const seg2Geo = new three.CylinderGeometry(0.009, 0.012, 0.05 * data.scale, 8);
        const seg2 = new three.Mesh(seg2Geo, skinMaterial);
        seg2.name = "seg2";
        seg2.position.z = -0.05 * data.scale;
        seg2.position.y = 0.02 * data.scale;
        finger.add(seg2);

        finger.name = "finger_" + data.name;
        handGroup.add(finger);
    });

    // Nhóm chứa vật thể được nhặt
    const itemSlot = new three.Group();
    itemSlot.name = "itemSlot";
    itemSlot.position.set(0, 0.06, -0.05); // Đặt giữa lòng bàn tay
    handGroup.add(itemSlot);

    // Hơi xoay bàn tay vào trong cho tự nhiên
    handGroup.rotation.y = isRight ? -0.2 : 0.2;
    handGroup.rotation.z = isRight ? -0.1 : 0.1;

    return armGroup;
}

const leftArm = createArm(false);
const rightArm = createArm(true);
leftArmGroup.add(leftArm);
rightArmGroup.add(rightArm);
const playerArmGroups = [leftArmGroup, rightArmGroup];
playerArmGroups.forEach(group => {
    group.traverse(node => {
        if (node.isMesh) node.userData.isPlayerArmVisual = true;
    });
});

export function registerDraggableObject(obj) {
    obj.updateMatrixWorld(true);
    if (obj.userData?.id_chemical && !obj.userData?.toolData) {
        const bottleScale = obj.userData.customScale?.clone?.() || obj.scale.clone();
        const displayScale = obj.userData.customWorldScale?.clone?.() || getObjectWorldScale(obj);
        obj.userData.customScale = bottleScale.clone();
        obj.userData.customWorldScale = displayScale.clone();
        obj.userData.originalWorldScale = displayScale.clone();
        obj.userData.hasCustomScale = true;
    }
    if (!obj.userData.hasCustomScale || !obj.userData.customScale || !obj.userData.customWorldScale) {
        rememberCustomScale(obj);
    }

    // Lưu Scale và Quaternion nguyên bản ngay khi đăng ký
    if (!obj.userData.originalWorldScale) {
        obj.userData.originalWorldScale = getObjectWorldScale(obj);
    }
    if (!obj.userData.originalQuaternion) {
        const worldQuat = new three.Quaternion();
        obj.getWorldQuaternion(worldQuat);
        obj.userData.originalQuaternion = worldQuat.clone();
        obj.userData.originalWorldQuaternion ??= worldQuat.clone();
    } else if (!obj.userData.originalWorldQuaternion && obj.userData.originalQuaternion?.isQuaternion) {
        obj.userData.originalWorldQuaternion = obj.userData.originalQuaternion.clone();
    }
    if (isChemicalBottleObject(obj) && !obj.userData.chemicalBottleUprightWorldQuaternion) {
        obj.userData.chemicalBottleUprightWorldQuaternion =
            obj.userData.originalWorldQuaternion?.clone?.() ||
            obj.userData.originalQuaternion?.clone?.() ||
            getWorldQuaternionClone(obj);
    }

    if (obj.userData.offsetToFloor === undefined) {
        const box = new three.Box3().setFromObject(obj);
        obj.userData.offsetToFloor = obj.position.y - box.min.y;
    }

    // --- BƯỚC 1: TÍNH TOÁN TỰ ĐỘNG VỊ TRÍ MIỆNG LỌ ---
    ensureAutoSnapPoints(obj);

    if (obj.userData.id_chemical && !obj.userData.pourAnchor) {
        // Tính bounding box chỉ dựa trên Mesh (bỏ qua label sprite phía trên)
        const meshBox = new three.Box3();
        obj.traverse(child => {
            if (child.isMesh && child.name !== "fluid_volume") {
                meshBox.expandByObject(child);
            }
        });

        if (!meshBox.isEmpty()) {
            const center = new three.Vector3();
            meshBox.getCenter(center);

            // --- ĐỔ ĐÚNG TỪ MIỆNG CHAI (CÁCH CHUẨN) ---
            // Giả lập cổ chai nằm phía trước local -Z
            const localMouth = new three.Vector3(0, 0.42, -0.18);
            obj.userData.pourAnchor = localMouth.clone();
            console.log(`[System] Đã xác định pourAnchor chuẩn cho ${obj.userData.name_vi}:`, obj.userData.pourAnchor);
        }
    }

    // Đánh dấu để Raycaster nhận diện được root model
    obj.traverse(child => {
        child.userData.root = obj;
        child.userData.isInteractable = true;
    });
    draggableObjects.push(obj);
}

export function initInteractionEvents(camera, controlsManager, scene) {
    const { orbit, fps } = controlsManager;
    const contextmenu = document.getElementById('context-menu');
    const crosshair = document.getElementById('crosshair');
    pouringEffect = new PouringEffect(scene);

    // Thêm 2 tay vào camera
    camera.add(leftArmGroup);
    camera.add(rightArmGroup);

    const updateRaycaster = (event) => {
        if (fps.isLocked) {
            raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        } else {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
        }
    };

    // --- LOGIC CẦM NẮM (FPS) ---
    const ensureFpsAimLabel = () => {
        let label = document.getElementById('fps-aim-label');
        if (label) return label;

        label = document.createElement('div');
        label.id = 'fps-aim-label';
        label.className = 'hidden pointer-events-none fixed left-1/2 z-50 rounded bg-black/70 px-2 py-1 text-xs font-semibold text-white shadow-lg';
        label.style.top = 'calc(50% + 18px)';
        label.style.transform = 'translateX(-50%)';
        document.body.appendChild(label);
        return label;
    };

    const fpsAimLabel = ensureFpsAimLabel();
    const crosshairDot = crosshair?.querySelector?.('div') || null;

    const getAimLabelText = (object) => {
        const instanceId = object?.userData?.instanceId || object?.userData?.toolData?.id_tool || object?.uuid;
        const suffix = instanceId ? ` #${String(instanceId).slice(-4)}` : '';
        return `${toolDisplayName(object)}${suffix}`;
    };

    const updateFpsAimIndicator = () => {
        requestAnimationFrame(updateFpsAimIndicator);

        if (!fps.isLocked) {
            window.currentFpsAimTool = null;
            window.currentFpsAimHit = null;
            fpsAimLabel.classList.add('hidden');
            if (crosshairDot) {
                crosshairDot.style.backgroundColor = '';
                crosshairDot.style.transform = '';
            }
            return;
        }

        raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        const oldFar = raycaster.far;
        raycaster.far = 6;
        const intersects = raycaster.intersectObjects(getInteractionCandidates(), true);
        raycaster.far = oldFar;

        const hit = intersects.find(item => resolveDraggableRoot(item.object));
        const aimedTool = hit ? resolveDraggableRoot(hit.object) : null;
        window.currentFpsAimTool = aimedTool;
        window.currentFpsAimHit = hit || null;

        if (!aimedTool) {
            fpsAimLabel.classList.add('hidden');
            if (crosshairDot) {
                crosshairDot.style.backgroundColor = '';
                crosshairDot.style.transform = '';
            }
            return;
        }

        fpsAimLabel.textContent = getAimLabelText(aimedTool);
        fpsAimLabel.classList.remove('hidden');
        if (crosshairDot) {
            crosshairDot.style.backgroundColor = '#22d3ee';
            crosshairDot.style.transform = 'scale(1.8)';
        }
    };

    updateFpsAimIndicator();

    function getPourSourceWorldPoint(sourceObj) {
        const pourPoint = new three.Vector3();
        if (!sourceObj?.isObject3D) return pourPoint;

        sourceObj.updateMatrixWorld(true);
        if (sourceObj.userData?.pourAnchor) {
            pourPoint.copy(sourceObj.userData.pourAnchor).applyMatrix4(sourceObj.matrixWorld);
            return pourPoint;
        }

        const box = new three.Box3().setFromObject(sourceObj);
        pourPoint.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
        return pourPoint;
    }

    function getDirectPourAimedTool() {
        return fps.isLocked ? (window.currentFpsAimTool || null) : (selectedObjectForMenu || null);
    }

    function findFpsPourReceiverUnderCrosshair(sourceObj = null) {
        if (!fps.isLocked) return null;

        const receivers = getInteractionCandidates().filter(obj =>
            obj &&
            obj !== sourceObj &&
            isPourReceiver(obj)
        );
        if (!receivers.length) return null;

        raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        const oldFar = raycaster.far;
        raycaster.far = 8;
        const hits = raycaster.intersectObjects(receivers, true);
        raycaster.far = oldFar;

        for (const hit of hits) {
            const root = resolveDraggableRoot(hit.object);
            if (root && root !== sourceObj && isPourReceiver(root)) return root;
        }
        return null;
    }

    function getPreferredPourTargetForSource(sourceObj = null) {
        const crosshairTarget = findFpsPourReceiverUnderCrosshair(sourceObj);
        if (crosshairTarget) return crosshairTarget;

        const aimedTool = getDirectPourAimedTool();
        if (aimedTool && aimedTool !== sourceObj && isPourReceiver(aimedTool)) return aimedTool;

        return null;
    }

    function setDirectPourSource(sourceObj) {
        if (selectedDirectPourSource?.userData) {
            selectedDirectPourSource.userData.isDirectPourSource = false;
        }
        selectedDirectPourSource = sourceObj || null;
        if (selectedDirectPourSource?.userData) {
            selectedDirectPourSource.userData.isDirectPourSource = true;
        }
    }

    function clearDirectPourSource(message = null) {
        setDirectPourSource(null);
        if (message) notifyLab?.(message);
    }

    function previewDirectPour(sourceObj, targetObj, targetMouthPos) {
        if (!pouringEffect || !sourceObj || !targetObj) return;

        const pourPoint = getPourSourceWorldPoint(sourceObj);
        pouringEffect.startPouring(
            pourPoint,
            getChemicalColor(sourceObj),
            getChemicalName(sourceObj),
            getChemicalType(sourceObj),
            getPhysicalState(sourceObj)
        );
        pouringEffect.emit(pourPoint);
        pouringState.currentPourTargetPos = targetMouthPos.clone();

        window.setTimeout(() => {
            if (!isPouringAction) {
                pouringEffect.stop();
                pouringState.currentPourTargetPos = null;
            }
        }, 450);
    }

    async function pourDirectlyIntoTarget(sourceObj, targetObj) {
        if (!isPourSource(sourceObj) || !isPourReceiver(targetObj) || sourceObj === targetObj) return false;

        const targetMouthPos = getContainerEffectPosition(targetObj);
        previewDirectPour(sourceObj, targetObj, targetMouthPos);
        await handlePourSuccess(sourceObj, targetObj, targetMouthPos, { direct: true });
        return true;
    }

    async function handleDirectPourCommand() {
        if (heldObjectRight || heldObjectLeft || draggedObject) return false;

        const aimedTool = getDirectPourAimedTool();

        if (!selectedDirectPourSource || !selectedDirectPourSource.parent) {
            if (isPourSource(aimedTool)) {
                setDirectPourSource(aimedTool);
                notifyLab?.(`Đã chọn nguồn rót: ${getChemicalName(aimedTool)}. Nhắm vào cốc/bình/ống nghiệm muốn nhận rồi bấm P hoặc Space.`);
                return true;
            }

            notifyLab?.('Hãy nhắm vào chai/lọ hoặc dụng cụ đang chứa hóa chất rồi bấm P để chọn nguồn rót.');
            return false;
        }

        if (aimedTool && aimedTool !== selectedDirectPourSource && isPourSource(aimedTool) && !isPourReceiver(aimedTool)) {
            setDirectPourSource(aimedTool);
            notifyLab?.(`Đã đổi nguồn rót sang: ${getChemicalName(aimedTool)}. Nhắm vào dụng cụ nhận rồi bấm P hoặc Space.`);
            return true;
        }

        const target = getPreferredPourTargetForSource(selectedDirectPourSource);
        if (!target) {
            notifyLab?.(`Đang chọn nguồn rót ${getChemicalName(selectedDirectPourSource)}. Hãy nhắm đúng vào dụng cụ nhận rồi bấm P hoặc Space.`);
            return false;
        }

        await pourDirectlyIntoTarget(selectedDirectPourSource, target);
        return true;
    }

    function getHeldPourSourceForHand(handedness = null) {
        const preferred = handedness === 'left' ? heldObjectLeft :
            handedness === 'right' ? heldObjectRight :
            null;
        if (isPourSource(preferred)) return preferred;
        if (isPourSource(heldObjectRight)) return heldObjectRight;
        if (isPourSource(heldObjectLeft)) return heldObjectLeft;
        if (isPourSource(draggedObject)) return draggedObject;
        return null;
    }

    function beginPouringFromHeldObject(sourceObj, options = {}) {
        if (!sourceObj?.isObject3D || !isPourSource(sourceObj)) return false;

        const now = performance.now();
        if (!options.ignoreCooldown && sourceObj.userData.lastReactionCheck &&
            now - sourceObj.userData.lastReactionCheck < 1000) {
            return false;
        }
        sourceObj.userData.lastReactionCheck = now;

        isPouringAction = true;
        activePourSource = sourceObj;

        const pourPoint = getPourSourceWorldPoint(sourceObj);
        pouringEffect.startPouring(
            pourPoint,
            getChemicalColor(sourceObj),
            getChemicalName(sourceObj),
            getChemicalType(sourceObj),
            getPhysicalState(sourceObj)
        );
        return true;
    }

    function stopActivePouring(options = {}) {
        const sourceObj = activePourSource || heldObjectRight || heldObjectLeft || draggedObject;
        isPouringAction = false;
        activePourSource = null;
        if (options.resetRotation && sourceObj?.rotation) sourceObj.rotation.z = 0;
        pouringEffect?.stop();
        pouringState.currentPourTargetPos = null;
        lastPouredTarget = null;
        return true;
    }

    let activeXRHandRayController = null;
    const handRayOrigin = new three.Vector3();
    const handRayDirection = new three.Vector3();
    const handRayEnd = new three.Vector3();
    const handRayCameraPosition = new three.Vector3();

    const getHandRayCamera = () => {
        const xrCamera = controlsManager.isXRPresenting?.()
            ? controlsManager.getXRCamera?.()
            : null;
        if (xrCamera?.isArrayCamera) return xrCamera.cameras?.[0] || camera;
        return xrCamera || camera;
    };

    const setHandInteractionRaycaster = () => {
        if (controlsManager.isXRPresenting?.() && activeXRHandRayController?.isObject3D) {
            activeXRHandRayController.updateMatrixWorld(true);
            activeXRHandRayController.getWorldPosition(handRayOrigin);
            handRayDirection.set(0, 0, -1).transformDirection(activeXRHandRayController.matrixWorld).normalize();
            raycaster.ray.origin.copy(handRayOrigin);
            raycaster.ray.direction.copy(handRayDirection);
            raycaster.camera = getHandRayCamera();
            return;
        }

        raycaster.setFromCamera({ x: 0, y: 0 }, getHandRayCamera());
    };

    const getXRHandAimedRoot = (candidates = []) => {
        if (!controlsManager.isXRPresenting?.() || !activeXRHandRayController?.isObject3D) return null;
        const aimedRoot = resolveDraggableRoot(controlsManager.xrControllerAimTargets?.get(activeXRHandRayController));
        return aimedRoot && (!candidates.length || candidates.includes(aimedRoot)) ? aimedRoot : null;
    };

    const getHandRayFallbackRoot = (candidates = [], maxDistance = 8) => {
        if (!controlsManager.isXRPresenting?.() || !activeXRHandRayController?.isObject3D) return null;

        let closest = null;
        handRayEnd.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, maxDistance);

        candidates.forEach((candidate) => {
            if (!candidate?.isObject3D) return;

            const box = new three.Box3().setFromObject(candidate);
            if (box.isEmpty()) return;

            const expandedBox = box.clone().expandByScalar(0.38);
            const hitPoint = raycaster.ray.intersectBox(expandedBox, new three.Vector3());
            const center = box.getCenter(new three.Vector3());
            const rayDistanceSq = raycaster.ray.distanceSqToPoint(center);
            const tipDistanceSq = expandedBox.distanceToPoint(handRayEnd) ** 2;
            const score = hitPoint
                ? raycaster.ray.origin.distanceToSquared(hitPoint)
                : Math.min(rayDistanceSq, tipDistanceSq);

            if (hitPoint || rayDistanceSq < 0.42 || tipDistanceSq < 0.42) {
                if (!closest || score < closest.score) {
                    closest = { object: candidate, score };
                }
            }
        });

        return closest?.object || null;
    };

    const getXRReachFallbackRoot = (candidates = [], maxDistance = 2.3) => {
        if (!controlsManager.isXRPresenting?.()) return null;

        const points = [];
        if (activeXRHandRayController?.isObject3D) {
            activeXRHandRayController.updateMatrixWorld(true);
            activeXRHandRayController.getWorldPosition(handRayOrigin);
            points.push({ point: handRayOrigin.clone(), weight: 0.75 });
        }

        const handCamera = getHandRayCamera();
        handCamera.updateMatrixWorld?.(true);
        handCamera.getWorldPosition(handRayCameraPosition);
        points.push({ point: handRayCameraPosition.clone(), weight: 1 });

        let closest = null;
        candidates.forEach((candidate) => {
            if (!candidate?.isObject3D) return;

            const box = new three.Box3().setFromObject(candidate);
            if (box.isEmpty()) return;

            const score = points.reduce((best, item) => {
                const distance = box.distanceToPoint(item.point);
                return Math.min(best, distance * item.weight);
            }, Infinity);

            if (score <= maxDistance && (!closest || score < closest.score)) {
                closest = { object: candidate, score };
            }
        });

        return closest?.object || null;
    };

    const getHandInteractionTargetRoot = (candidates = []) => {
        setHandInteractionRaycaster();

        const aimedRoot = getXRHandAimedRoot(candidates);
        if (aimedRoot) return aimedRoot;

        const oldFar = raycaster.far;
        raycaster.far = controlsManager.isXRPresenting?.() ? 8 : oldFar;
        const intersects = raycaster.intersectObjects(candidates, true);
        raycaster.far = oldFar;

        for (const hit of intersects) {
            const root = resolveDraggableRoot(hit.object);
            if (root) return root;
        }

        const handFallbackRoot = getHandRayFallbackRoot(candidates);
        if (handFallbackRoot) return handFallbackRoot;

        const reachFallbackRoot = getXRReachFallbackRoot(candidates);
        if (reachFallbackRoot) return reachFallbackRoot;

        if (controlsManager.isXRPresenting?.()) {
            raycaster.setFromCamera({ x: 0, y: 0 }, getHandRayCamera());
            const oldCameraFar = raycaster.far;
            raycaster.far = 8;
            const cameraIntersects = raycaster.intersectObjects(candidates, true);
            raycaster.far = oldCameraFar;

            for (const hit of cameraIntersects) {
                const root = resolveDraggableRoot(hit.object);
                if (root) return root;
            }
        }

        return null;
    };

    const handleHandInteraction = (isRightHand = true) => {
        let currentHeld = isRightHand ? heldObjectRight : heldObjectLeft;
        const arm = isRightHand ? rightArm : leftArm;

        if (currentHeld) {
            // Thả vật thể về Scene. Lưu scale/rotation trước khi attach để không lấy rotation tay/camera làm rotation cuối.
            const savedScale = getSavedScale(currentHeld);
            const wasManuallyRotated = currentHeld.userData.wasManuallyRotated === true;

            attachKeepWorldTransform(scene, currentHeld);
            markChemicalBottleOutOfCabinet(currentHeld);

            // Nếu người dùng KHÔNG chủ động xoay dụng cụ trong lúc cầm, trả về rotation trước khi cầm.
            // Không gọi invalidateCavity ở đây vì chỉ đổi parent/rotation; liquid volume vẫn bám theo dụng cụ.
            restoreRotationAfterHoldDrop(currentHeld, wasManuallyRotated);
            restoreCustomScale(currentHeld, savedScale);
            rememberCustomScale(currentHeld, savedScale);
            currentHeld.updateMatrixWorld(true);

            // Tìm điểm va chạm để đặt vật thể
            setHandInteractionRaycaster();

            // Ẩn tạm thời các nhóm camera và vật thể để tránh va chạm sai
            const originalVisible = currentHeld.visible;
            const originalCameraVisible = cameraGroup.visible;
            currentHeld.visible = false;
            cameraGroup.visible = false;

            const sceneIntersects = raycaster.intersectObjects(scene.children, true);

            currentHeld.visible = originalVisible;
            cameraGroup.visible = originalCameraVisible;

            const returnedToCabinet = shouldReturnChemicalBottleToCabinet(currentHeld, sceneIntersects) &&
                returnChemicalBottleToCabinetHome(currentHeld);

            if (!returnedToCabinet) {
            let dropSurfaceY = null;
            if (sceneIntersects.length > 0) {
                // Ưu tiên tìm mặt bàn hoặc sàn nhà
                let bestHit = sceneIntersects[0];
                for (let i = 0; i < sceneIntersects.length; i++) {
                    const hit = sceneIntersects[i];
                    const isTable = isTableObject(hit.object);
                    if (isTable) {
                        bestHit = hit;
                        break;
                    }
                }
                dropSurfaceY = isTableObject(bestHit.object) ? getTableSurfaceYForObject(bestHit.object) : bestHit.point.y;
                currentHeld.position.copy(bestHit.point);
            } else {
                // Nếu không chạm gì, đặt phía trước người chơi 1m
                const handCamera = getHandRayCamera();
                const forward = new three.Vector3();
                handCamera.getWorldDirection(forward);
                handCamera.getWorldPosition(handRayCameraPosition);
                currentHeld.position.copy(handRayCameraPosition).add(forward.multiplyScalar(1));
                currentHeld.position.y = 0;
                dropSurfaceY = 0;
            }

            // Bảo toàn scale sau khi đổi vị trí đặt xuống.
            restoreCustomScale(currentHeld, savedScale);
            rememberCustomScale(currentHeld, savedScale);
            currentHeld.updateMatrixWorld(true);

            // Đảm bảo tiếp đất chuẩn (Không lơ lửng)
            currentHeld.updateMatrixWorld(true);
            const box = new three.Box3().setFromObject(currentHeld);
            const bottomY = box.min.y;
            // Tính toán khoảng cách chênh lệch để vật thể chạm đất/bàn
            const bottomOffset = currentHeld.position.y - bottomY;
            currentHeld.position.y += bottomOffset;
            updateOffsetToFloor(currentHeld);

            completeAssemblyDrop(currentHeld);
            resolvePlacementOverlapAfterLegacyLogic(currentHeld);
            restoreCustomScale(currentHeld, savedScale);
            liftObjectBottomToSurface(currentHeld, dropSurfaceY);
            currentHeld.updateMatrixWorld(true);
            } else {
                currentHeld.updateMatrixWorld(true);
            }

            console.log('[FPS Drop] object:', currentHeld.name || currentHeld.userData?.name_tool_vi || currentHeld.userData?.toolData?.name_tool_vi || currentHeld.uuid);
            console.log('[FPS Drop] rotationBeforeHold:', currentHeld.userData.rotationBeforeHold);
            console.log('[FPS Drop] wasManuallyRotated:', currentHeld.userData.wasManuallyRotated);
            console.log('[FPS Drop] final rotation:', currentHeld.rotation);
            console.log('[FPS Drop] final scale:', currentHeld.scale);

            // Sau khi thả xong, lần cầm sau sẽ bắt đầu trạng thái manual mới.
            delete currentHeld.userData.rotationBeforeHold;
            delete currentHeld.userData.worldQuaternionBeforeHold;
            currentHeld.userData.wasManuallyRotated = false;

            if (isRightHand) heldObjectRight = null;
            else heldObjectLeft = null;

        } else {
            // NHẶT VẬT THỂ
            const candidates = getInteractionCandidates();
            const root = getHandInteractionTargetRoot(candidates);

            if (root) {
                // Kiểm tra xem vật này có đang bị tay kia cầm không
                if (root === heldObjectRight || root === heldObjectLeft) return;

                window.labAssemblyManager?.detachMagneticBinding?.(root);
                releaseHeatingSnapIfNeeded(root);

                // Lưu rotation thực tế trước khi gắn vào tay. Rotation tay/camera chỉ dùng để hiển thị lúc đang cầm,
                // không được trở thành rotation cuối khi thả nếu người dùng không xoay thủ công.
                captureHoldRotationState(root);
                root.userData.wasManuallyRotated = false;
                if (isChemicalBottleObject(root)) root.userData.keepManualRotation = false;
                if (root.userData.defaultRotationX === undefined) root.userData.defaultRotationX = root.rotation.x || 0;
                if (root.userData.defaultRotationY === undefined) root.userData.defaultRotationY = root.rotation.y || 0;
                if (root.userData.defaultRotationZ === undefined) root.userData.defaultRotationZ = root.rotation.z || 0;

                if (isRightHand) heldObjectRight = root;
                else heldObjectLeft = root;

                const slot = arm.getObjectByName("itemSlot");
                if (slot) {
                    // Lưu trạng thái gốc trong không gian thế giới (World) để khôi phục chính xác
                    if (!root.userData.originalWorldScale) {
                        root.userData.originalWorldScale = getObjectWorldScale(root);
                    }

                    const worldQuat = new three.Quaternion();
                    root.getWorldQuaternion(worldQuat);
                    root.userData.originalWorldQuaternion = worldQuat.clone();

                    const savedScale = getSavedScale(root);
                    attachKeepWorldTransform(slot, root);
                    markChemicalBottleOutOfCabinet(root);
                    if (pouringEffect) pouringEffect.invalidateCavity(root);
                    root.position.set(0, 0.1, 0);
                    root.rotation.order = 'YXZ';
                    if (!root.userData.keepManualRotation) {
                        root.rotation.set(0, isRightHand ? -Math.PI / 2 : Math.PI / 2, 0);
                    }

                    // Scale khi cầm trên tay (nhỏ đi một chút)
                    restoreCustomScale(root, savedScale);

                    // Không hiện thông báo khi chỉ cầm/nhặt dụng cụ hoặc hóa chất.
                    // Thông báo chỉ hiển thị sau khi phản ứng thật sự xảy ra.
                }
            }
        }
    };

    const xrButtonState = new Map();
    const xrPourButtonState = new Map();
    const xrToggleDebounceMs = 140;
    const xrGrabButtonNames = new Set(['trigger', 'grip']);
    const xrPourButtonNames = new Set(['buttonA', 'buttonB', 'buttonX', 'buttonY']);

    const getXRControllerHandedness = (controller) => {
        const handedness = controller?.userData?.handedness || controller?.userData?.inputSource?.handedness;
        if (handedness === 'left' || handedness === 'right') return handedness;
        return controller?.userData?.slot === 1 ? 'left' : 'right';
    };

    const releaseXRPress = (controller, inputName = null) => {
        const previous = xrButtonState.get(controller);
        if (!previous) return;
        if (inputName && previous.activeInputName && previous.activeInputName !== inputName) return;

        previous.pressed = false;
        previous.activeInputName = null;
        previous.lastInputAt = performance.now();
        xrButtonState.set(controller, previous);
    };

    const handleXRPressAsHandInteraction = (controller, inputName = 'select', options = {}) => {
        if (!controller) return false;

        const previous = xrButtonState.get(controller) || {
            pressed: false,
            activeInputName: null,
            lastInputAt: 0,
            lastToggleAt: 0
        };
        const now = performance.now();

        if (options.markPressed) {
            if (previous.pressed) {
                previous.activeInputName ??= inputName;
                previous.lastInputAt = now;
                xrButtonState.set(controller, previous);
                return false;
            }

            previous.pressed = true;
            previous.activeInputName = inputName;
            previous.lastInputAt = now;
        } else {
            previous.lastInputAt = now;
        }

        if (now - (previous.lastToggleAt || 0) < xrToggleDebounceMs) {
            xrButtonState.set(controller, previous);
            return false;
        }

        const handedness = getXRControllerHandedness(controller);
        const isRightHand = handedness !== 'left';
        const beforeHeld = isRightHand ? heldObjectRight : heldObjectLeft;

        const runHandInteraction = (rayController) => {
            activeXRHandRayController = rayController;
            try {
                handleHandInteraction(isRightHand);
            } finally {
                activeXRHandRayController = null;
            }
        };

        runHandInteraction(controller);

        let afterHeld = isRightHand ? heldObjectRight : heldObjectLeft;
        if (!beforeHeld && afterHeld === beforeHeld) {
            runHandInteraction(null);
            afterHeld = isRightHand ? heldObjectRight : heldObjectLeft;
        }
        const toggled = Boolean(beforeHeld) || beforeHeld !== afterHeld;

        if (toggled) {
            previous.lastToggleAt = now;
        }

        xrButtonState.set(controller, previous);
        return toggled;
    };

    const isXRButtonPressed = (button) => Boolean(
        button?.pressed ||
        Number(button?.value || 0) > 0.45
    );

    const getPressedXRButtonName = (buttons = [], allowedNames = null) => {
        const names = ['trigger', 'grip', 'touchpad', 'thumbstick', 'buttonA', 'buttonB', 'buttonX', 'buttonY'];
        const pressedIndex = Array.from(buttons).findIndex((button, index) => {
            const name = names[index] || `button${index}`;
            return (!allowedNames || allowedNames.has(name)) && isXRButtonPressed(button);
        });
        if (pressedIndex < 0) return null;
        return names[pressedIndex] || `button${pressedIndex}`;
    };

    const getXRControllerForInputSource = (inputSource, fallbackIndex = 0) => {
        const xrControllerSlots = controlsManager.xrControllerSlots || [];
        return xrControllerSlots.find(controller => controller?.userData?.inputSource === inputSource) ||
            xrControllerSlots.find(controller =>
                inputSource?.handedness &&
                controller?.userData?.handedness === inputSource.handedness
            ) ||
            xrControllerSlots.find(controller => controller?.userData?.slot === fallbackIndex) ||
            xrControllerSlots[fallbackIndex] ||
            null;
    };

    let xrPressSession = null;
    let xrSessionPressHandlers = null;

    const getXRControllerForSessionEvent = (event) => {
        const inputSources = Array.from(controlsManager.getXRSession?.()?.inputSources || []);
        const fallbackIndex = Math.max(0, inputSources.indexOf(event?.inputSource));
        return getXRControllerForInputSource(event?.inputSource, fallbackIndex);
    };

    const refreshXRPressSessionListeners = () => {
        const session = controlsManager.getXRSession?.() || null;
        if (session === xrPressSession) return;

        if (xrPressSession && xrSessionPressHandlers) {
            Object.entries(xrSessionPressHandlers).forEach(([eventName, handler]) => {
                xrPressSession.removeEventListener(eventName, handler);
            });
        }

        xrPressSession = session;
        xrSessionPressHandlers = null;
        if (!session) return;

        const press = (event, inputName) => {
            const controller = getXRControllerForSessionEvent(event);
            refreshXRControllerInputSource(controller, event?.inputSource);
            handleXRPressAsHandInteraction(controller, inputName, { markPressed: true });
        };
        const release = (event, inputName) => {
            const controller = getXRControllerForSessionEvent(event);
            releaseXRPress(controller, inputName);
        };

        xrSessionPressHandlers = {
            selectstart: event => press(event, 'select'),
            select: event => press(event, 'select'),
            selectend: event => release(event, 'select'),
            squeezestart: event => press(event, 'squeeze'),
            squeeze: event => press(event, 'squeeze'),
            squeezeend: event => release(event, 'squeeze'),
            end: () => {
                stopActivePouring({ resetRotation: false });
                xrPourButtonState.clear();
                xrPressSession = null;
                xrSessionPressHandlers = null;
            }
        };

        Object.entries(xrSessionPressHandlers).forEach(([eventName, handler]) => {
            session.addEventListener(eventName, handler);
        });
    };

    const refreshXRControllerInputSource = (controller, inputSource) => {
        if (!controller || !inputSource) return;
        controller.userData.inputSource = inputSource;
        controller.userData.gamepad = inputSource.gamepad || controller.userData.gamepad || null;
        if (inputSource.handedness === 'left' || inputSource.handedness === 'right') {
            controller.userData.handedness = inputSource.handedness;
        }
    };

    const processXRPourButton = (controller, inputName, pressed) => {
        if (!controller) return;

        const previous = xrPourButtonState.get(controller) || {
            pressed: false,
            activeInputName: null,
            source: null
        };

        if (pressed && !previous.pressed) {
            const source = getHeldPourSourceForHand(getXRControllerHandedness(controller));
            if (beginPouringFromHeldObject(source, { ignoreCooldown: true })) {
                previous.pressed = true;
                previous.activeInputName = inputName;
                previous.source = source;
            }
            xrPourButtonState.set(controller, previous);
            return;
        }

        if (!pressed && previous.pressed) {
            if (!previous.source || activePourSource === previous.source) {
                stopActivePouring({ resetRotation: false });
            }
            previous.pressed = false;
            previous.activeInputName = null;
            previous.source = null;
            xrPourButtonState.set(controller, previous);
            return;
        }

        xrPourButtonState.set(controller, previous);
    };

    const processXRControllerButtons = (controller, buttons = []) => {
        if (!controller) return;

        const pourButtonName = getPressedXRButtonName(buttons, xrPourButtonNames);
        processXRPourButton(controller, pourButtonName, Boolean(pourButtonName));

        const pressedButtonName = getPressedXRButtonName(buttons, xrGrabButtonNames);
        const pressed = Boolean(pressedButtonName);
        const previous = xrButtonState.get(controller) || {
            pressed: false,
            activeInputName: null,
            lastInputAt: 0,
            lastToggleAt: 0
        };

        if (pressed && !previous.pressed) {
            handleXRPressAsHandInteraction(controller, pressedButtonName, { markPressed: true });
            return;
        }

        if (!pressed && previous.pressed) {
            releaseXRPress(controller, previous.activeInputName);
            return;
        }

        if (pressed && previous.pressed) {
            const now = performance.now();
            const handedness = getXRControllerHandedness(controller);
            const isRightHand = handedness !== 'left';
            const currentHeld = isRightHand ? heldObjectRight : heldObjectLeft;

            if (!currentHeld && now - (previous.lastInputAt || 0) > 160) {
                handleXRPressAsHandInteraction(controller, pressedButtonName);
                return;
            }

            previous.lastInputAt = now;
        }
        xrButtonState.set(controller, previous);
    };

    const updateXRPressButtons = () => {
        refreshXRPressSessionListeners();

        const xrControllerSlots = controlsManager.xrControllerSlots || [];
        const sessionInputSources = Array.from(controlsManager.getXRSession?.()?.inputSources || []);
        const processedControllers = new Set();

        sessionInputSources.forEach((inputSource, index) => {
            const controller = getXRControllerForInputSource(inputSource, index);
            if (!controller) return;

            refreshXRControllerInputSource(controller, inputSource);
            processedControllers.add(controller);
            processXRControllerButtons(controller, inputSource.gamepad?.buttons || []);
        });

        xrControllerSlots.forEach((controller) => {
            if (processedControllers.has(controller)) return;
            const buttons = controller?.userData?.inputSource?.gamepad?.buttons ||
                controller?.userData?.gamepad?.buttons ||
                [];
            processXRControllerButtons(controller, buttons);
        });
    };

    const setupXRPressControls = () => {
        const xrControllerSlots = controlsManager.xrControllerSlots || [];
        xrControllerSlots.forEach((controller) => {
            controller.addEventListener('selectstart', () => handleXRPressAsHandInteraction(controller, 'select', { markPressed: true }));
            controller.addEventListener('select', () => handleXRPressAsHandInteraction(controller, 'select', { markPressed: true }));
            controller.addEventListener('selectend', () => releaseXRPress(controller, 'select'));
            controller.addEventListener('squeezestart', () => handleXRPressAsHandInteraction(controller, 'squeeze', { markPressed: true }));
            controller.addEventListener('squeeze', () => handleXRPressAsHandInteraction(controller, 'squeeze', { markPressed: true }));
            controller.addEventListener('squeezeend', () => releaseXRPress(controller, 'squeeze'));
            controller.addEventListener('disconnected', () => {
                releaseXRPress(controller);
                processXRPourButton(controller, null, false);
            });
        });
    };

    setupXRPressControls();
    controlsManager.updateXRPressButtons = updateXRPressButtons;

    const getXRControllerForPointerFallback = () => {
        const xrControllerSlots = controlsManager.xrControllerSlots || [];
        return xrControllerSlots.find(controller => resolveDraggableRoot(controlsManager.xrControllerAimTargets?.get(controller))) ||
            xrControllerSlots.find(controller => controller?.userData?.inputSource) ||
            xrControllerSlots[1] ||
            xrControllerSlots[0] ||
            null;
    };

    window.addEventListener('pointerdown', (event) => {
        if (!controlsManager.isXRPresenting?.()) return;
        if (event.button !== 0) return;

        const targetTag = event.target?.tagName?.toLowerCase?.();
        if (targetTag && targetTag !== 'canvas') return;

        const controller = getXRControllerForPointerFallback();
        if (!controller) return;

        if (handleXRPressAsHandInteraction(controller, 'pointer', { markPressed: true })) {
            window.addEventListener('pointerup', () => releaseXRPress(controller, 'pointer'), { once: true, capture: true });
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    const toolRotateState = {
        activeAxis: null,
        isDragging: false,
        targetTool: null,
        lastPersistAt: 0,
        speed: 0.01,
        step: 0.12
    };

    const xrHeldRotateDeadzone = 0.18;
    const xrHeldRotateSpeed = 1.65;
    const xrHeldRotationPersistMs = 700;

    const getXRControllerForHand = (handedness) => {
        const xrControllerSlots = controlsManager.xrControllerSlots || [];
        return xrControllerSlots.find(controller => controller?.userData?.handedness === handedness) ||
            xrControllerSlots.find(controller => controller?.userData?.inputSource?.handedness === handedness) ||
            xrControllerSlots.find(controller => handedness === 'left' ? controller?.userData?.slot === 1 : controller?.userData?.slot === 0) ||
            null;
    };

    const getXRRotationAxes = (controller) => {
        const axes = controller?.userData?.inputSource?.gamepad?.axes || controller?.userData?.gamepad?.axes || [];
        const xPrimary = axes[2] ?? 0;
        const yPrimary = axes[3] ?? 0;
        const xFallback = axes[0] ?? 0;
        const yFallback = axes[1] ?? 0;
        const x = Math.abs(xPrimary) > xrHeldRotateDeadzone || Math.abs(yPrimary) > xrHeldRotateDeadzone
            ? xPrimary
            : xFallback;
        const y = Math.abs(xPrimary) > xrHeldRotateDeadzone || Math.abs(yPrimary) > xrHeldRotateDeadzone
            ? yPrimary
            : yFallback;

        return {
            x: Math.abs(x) > xrHeldRotateDeadzone ? x : 0,
            y: Math.abs(y) > xrHeldRotateDeadzone ? y : 0
        };
    };

    const rotateHeldToolWithXRStick = (object, handedness, delta) => {
        if (!object?.isObject3D) return false;
        const controller = getXRControllerForHand(handedness);
        const axes = getXRRotationAxes(controller);
        if (!axes.x && !axes.y) return false;

        selectedObjectForMenu = object;
        const pitch = axes.y * xrHeldRotateSpeed * delta;
        const roll = axes.x * xrHeldRotateSpeed * delta;
        const rotated = rotateToolObject(object, pitch, 0, roll, 'vr');

        if (rotated) {
            const now = performance.now();
            if (now - (object.userData.xrLastRotationPersistAt || 0) > xrHeldRotationPersistMs) {
                object.userData.xrLastRotationPersistAt = now;
                persistToolRotation(object);
            }
        }

        return rotated;
    };

    const updateXRHeldToolRotation = (delta = 0) => {
        if (!controlsManager.isXRPresenting?.()) return false;
        const heldTool = heldObjectRight || heldObjectLeft;
        return rotateHeldToolWithXRStick(heldTool, 'right', delta);
    };

    controlsManager.updateXRHeldToolRotation = updateXRHeldToolRotation;
    controlsManager.setXRHandHoldingProvider?.((handedness) => {
        if (handedness === 'any') return Boolean(heldObjectLeft || heldObjectRight);
        return handedness === 'left' ? Boolean(heldObjectLeft) : Boolean(heldObjectRight);
    });


    const getRaycastToolUnderPointer = (event = null) => {
        if (fps.isLocked) {
            raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        } else if (event) {
            updateRaycaster(event);
        } else {
            return null;
        }
        const candidates = getInteractionCandidates();
        const intersects = raycaster.intersectObjects(candidates, true);
        return intersects.length ? resolveDraggableRoot(intersects[0].object) : null;
    };

    const getActiveToolForRotation = (event = null) => {
        // Ưu tiên đúng vật đang thao tác hiện tại.
        // BUG cũ: selectedObjectForMenu có thể vẫn là nguồn nhiệt đã click trước đó,
        // nên khi đang kéo vật khác mà nhấn phím xoay thì nguồn nhiệt bị xoay.
        // draggedObject phải đứng trước selectedObjectForMenu.
        if (toolRotateState.targetTool) return toolRotateState.targetTool;
        if (fps.isLocked) {
            return heldObjectRight ||
                heldObjectLeft ||
                draggedObject ||
                window.currentFpsAimTool ||
                getRaycastToolUnderPointer(event) ||
                selectedObjectForMenu;
        }
        return heldObjectRight || heldObjectLeft || draggedObject || selectedObjectForMenu || getRaycastToolUnderPointer(event);
    };

    const getKeyboardMoveDelta = (event) => {
        const step = event.shiftKey ? 0.25 : (event.altKey ? 0.025 : 0.08);
        const moveKey = event.key.toLowerCase();
        const forward = new three.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        forward.y = 0;
        if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
        forward.normalize();

        const right = new three.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        right.y = 0;
        if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
        right.normalize();

        switch (moveKey) {
            case 'arrowleft': return right.multiplyScalar(-step);
            case 'arrowright': return right.multiplyScalar(step);
            case 'arrowup': return forward.multiplyScalar(step);
            case 'arrowdown': return forward.multiplyScalar(-step);
            case 'f': return new three.Vector3(0, step, 0);
            case 'g': return new three.Vector3(0, -step, 0);
            default: return null;
        }
    };

    const beginToolRotate = (axis, event = null) => {
        const tool = getActiveToolForRotation(event);
        if (!tool) return false;
        toolRotateState.activeAxis = axis;
        toolRotateState.isDragging = true;
        toolRotateState.targetTool = tool;
        selectedObjectForMenu = tool;
        orbit.enabled = false;
        markToolManuallyRotated(tool);
        contextmenu?.classList?.add('hidden');
        return true;
    };

    const finishToolRotate = (event = null) => {
        const tool = getActiveToolForRotation(event);
        if (toolRotateState.activeAxis && tool) {
            persistToolRotation(tool);
        }
        toolRotateState.activeAxis = null;
        toolRotateState.isDragging = false;
        toolRotateState.targetTool = null;
        if (!draggedObject && !fps.isLocked) orbit.enabled = true;
    };

    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e)) return;
        const key = e.key.toLowerCase();
        const axisByModifier = { r: 'y', t: 'x', y: 'z' };
        const axis = axisByModifier[key];
        const activeTool = getActiveToolForRotation();
        const moveDelta = activeTool ? getKeyboardMoveDelta(e) : null;

        if (key === 'escape' && selectedDirectPourSource) {
            e.preventDefault();
            e.stopImmediatePropagation();
            clearDirectPourSource('Đã hủy nguồn rót đang chọn.');
            return;
        }

        if (key === 'p' && !e.repeat) {
            e.preventDefault();
            e.stopImmediatePropagation();
            handleDirectPourCommand().catch(error => console.error('[DirectPour] failed:', error));
            return;
        }

        if (key === 'm' && activeTool) {
            e.preventDefault();
            e.stopImmediatePropagation();
            selectedObjectForMenu = activeTool;
            toggleManualAssembly(activeTool);
            return;
        }

        if (moveDelta && activeTool) {
            e.preventDefault();
            e.stopImmediatePropagation();
            selectedObjectForMenu = activeTool;
            const isHeld = activeTool === heldObjectRight || activeTool === heldObjectLeft;
            translateToolObject(activeTool, moveDelta, { detachAssembly: !isHeld });
            if (!isHeld) {
                resolvePlacementOverlapAfterLegacyLogic(activeTool);
            }
            return;
        }

        if (axis && activeTool) {
            e.preventDefault();
            e.stopImmediatePropagation();
            beginToolRotate(axis);
            return;
        }

        const stepMap = {
            z: ['y', -toolRotateState.step],
            x: ['y', toolRotateState.step],
            c: ['x', -toolRotateState.step],
            v: ['x', toolRotateState.step],
            b: ['z', -toolRotateState.step],
            n: ['z', toolRotateState.step]
        };
        if (stepMap[key] && activeTool) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const [stepAxis, amount] = stepMap[key];
            selectedObjectForMenu = activeTool;
            rotateToolObject(
                activeTool,
                stepAxis === 'x' ? amount : 0,
                stepAxis === 'y' ? amount : 0,
                stepAxis === 'z' ? amount : 0,
                fps.isLocked ? 'fps' : 'normal'
            );
            persistToolRotation(activeTool);
        }
    }, true);

    window.addEventListener('keyup', (e) => {
        if (isEditableTarget(e)) return;
        const key = e.key.toLowerCase();
        if ({ r: true, t: true, y: true }[key] && toolRotateState.activeAxis) {
            e.preventDefault();
            e.stopImmediatePropagation();
            finishToolRotate(e);
        }
    }, true);

    window.addEventListener('pointerdown', (e) => {
        if (!toolRotateState.activeAxis) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    window.addEventListener('pointermove', (e) => {
        if (!toolRotateState.activeAxis || !(e.buttons & 1)) return;
        const activeTool = getActiveToolForRotation(e);
        if (!activeTool) return;

        e.preventDefault();
        e.stopImmediatePropagation();
        const dx = e.movementX * toolRotateState.speed;
        const dy = e.movementY * toolRotateState.speed;
        rotateToolObject(
            activeTool,
            toolRotateState.activeAxis === 'x' ? dy : 0,
            toolRotateState.activeAxis === 'y' ? dx : 0,
            toolRotateState.activeAxis === 'z' ? dx : 0,
            fps.isLocked ? 'fps' : 'normal'
        );
    }, true);

    window.addEventListener('pointerup', (e) => {
        if (toolRotateState.activeAxis) finishToolRotate(e);
    }, true);

    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e)) return;
        if (!fps.isLocked) return;
        const key = e.key.toLowerCase();
        if (key === 'e') {
            handleHandInteraction(true); // Tay phải
        } else if (key === 'q') {
            handleHandInteraction(false); // Tay trái
        } else if (key === 'f') {
            isInspectingRight = true;
        } else if (key === 'r') {
            isInspectingLeft = true;
        } else if (key === 'h') {
            const heldObj = heldObjectRight || heldObjectLeft;
            if (heldObj) toggleHeatingForObject(heldObj);
        }
    });

    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e)) return;
        if (e.code === 'Space') {
            const heldObj = heldObjectRight || heldObjectLeft || draggedObject; // Kiểm tra cả tay và chuột
            if (!heldObj) {
                if (e.repeat) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                handleDirectPourCommand().catch(error => console.error('[DirectPour] failed:', error));
                return;
            }

            // Chống spam gọi API/Spam Space liên tục (1 giây cooldown)
            const now = performance.now();
            if (heldObj.userData.lastReactionCheck &&
                now - heldObj.userData.lastReactionCheck < 1000) {
                return;
            }
            heldObj.userData.lastReactionCheck = now;

            beginPouringFromHeldObject(heldObj, { ignoreCooldown: true });
            return;

            console.log("Phím Space được nhấn, đối tượng đang cầm/kéo:", heldObj.userData);
            if (isPourSource(heldObj)) {
                isPouringAction = true;
                activePourSource = heldObj;
                // Animation xoay lọ sẽ được xử lý liên tục trong updateArmsAnimation

                // Xác định điểm đổ (miệng lọ) dựa trên thực tế xoay
                let pourPoint = getPourSourceWorldPoint(heldObj);

                console.log({
                    chemical: getChemicalName(heldObj),
                    color: getChemicalColor(heldObj)
                });
                pouringEffect.startPouring(
                    pourPoint,
                    getChemicalColor(heldObj),
                    getChemicalName(heldObj),
                    getChemicalType(heldObj),
                    getPhysicalState(heldObj)
                );
            }
        }
    });

    window.addEventListener('keyup', (e) => {
        if (isEditableTarget(e)) return;
        const key = e.key.toLowerCase();
        if (key === 'f') isInspectingRight = false;
        if (key === 'r') isInspectingLeft = false;
    });

    window.addEventListener('keyup', (e) => {
        if (isEditableTarget(e)) return;
        if (e.code === 'Space') {
            const heldObj = heldObjectRight || heldObjectLeft || draggedObject;
            if (heldObj) {
                isPouringAction = false;
                activePourSource = null;
                heldObj.rotation.z = 0; // Trả lọ về thẳng đứng
                stopActivePouring({ resetRotation: false });
            }
        }
    });

    // --- LOGIC KIỂM TRA ĐỔ HÓA CHẤT ---
    const downRaycaster = new three.Raycaster();
    const downVector = new three.Vector3(0, -1, 0);

    function getFilteredCavityPoints(container) {
        const rawPoints = (container?.userData?.cavityPoints || []).filter(p =>
            Number.isFinite(p?.lx) &&
            Number.isFinite(p?.lz) &&
            Number.isFinite(p?.lyTop) &&
            Number.isFinite(p?.lyBottom) &&
            p.lyTop > p.lyBottom
        );
        if (!rawPoints.length) return rawPoints;
        return container?.userData?.cavitySource === 'csg_scaled_model' || container?.userData?.cavityCSG
            ? selectDominantCavityPoints(rawPoints)
            : rawPoints;
    }

    function getContainerEffectPosition(container) {
        if (!container) return new three.Vector3();
        container.updateMatrixWorld(true);
        const cavityPoints = getFilteredCavityPoints(container);
        if (cavityPoints.length > 0) {
            const box = new three.Box3();
            let topY = -Infinity;
            cavityPoints.forEach(point => {
                box.expandByPoint(new three.Vector3(point.lx, 0, point.lz));
                topY = Math.max(topY, point.lyTop);
            });
            if (!box.isEmpty() && Number.isFinite(topY)) {
                const center = box.getCenter(new three.Vector3());
                return new three.Vector3(center.x, topY + 0.035, center.z).applyMatrix4(container.matrixWorld);
            }
        }
        const box = new three.Box3().setFromObject(container);
        const center = new three.Vector3();
        box.getCenter(center);
        // Đặt hiệu ứng phụ ở gần miệng dụng cụ, không ở ngoài tủ/kệ.
        center.y = box.max.y + 0.035;
        return center;
    }

    function effectPower(...values) {
        for (const value of values) {
            if (value === undefined || value === null || value === false) continue;
            if (value === true) return 1;
            if (typeof value === 'number') return Math.max(0, Math.min(2, value));
            if (typeof value === 'object') {
                const nested = value.intensity ?? value.power ?? value.strength ?? value.density ?? value.toxicity ?? value.value;
                const n = effectPower(nested);
                if (n > 0) return n;
            }
        }
        return 0;
    }


    function reactionTextHaystack(reaction) {
        const raw = reaction?.raw || {};
        const parts = [
            reaction?.reactionMessage,
            reaction?.equation,
            raw?.reaction_message,
            raw?.reactionMessage,
            raw?.equation,
            raw?.reaction_data?.equation,
            ...(reaction?.products || []),
            ...(raw?.products || []),
            ...(raw?.reaction_data?.products || [])
        ];
        return parts.filter(Boolean).join(' ').toLowerCase();
    }

    function hasPrecipitateReaction(reaction) {
        if (!reaction) return false;
        const raw = reaction.raw || {};
        const visual = raw.visual || {};
        const effects = raw.effects || {};
        if (reaction.precipitate || raw.precipitate || visual.precipitate || effects.precipitate) return true;

        const text = reactionTextHaystack(reaction);
        return /(↓|kết tủa|ket tua|precipitate|precipitation|insoluble|không tan|khong tan|agcl|baso₄|baso4|caco₃|caco3|cu\(oh\)₂|cu\(oh\)2|fe\(oh\)₃|fe\(oh\)3|pbcl₂|pbcl2)/i.test(text);
    }

    function getPrecipitateColor(reaction) {
        const raw = reaction?.raw || {};
        const visual = raw.visual || {};
        const effects = raw.effects || {};
        const text = reactionTextHaystack(reaction);

        const explicit =
            reaction?.precipitateColor ||
            reaction?.precipitate_color ||
            raw?.precipitateColor ||
            raw?.precipitate_color ||
            visual?.precipitateColor ||
            visual?.precipitate_color ||
            effects?.precipitateColor ||
            effects?.precipitate_color;

        if (explicit) return explicit;

        if (/xanh lam|xanh dương|blue|cu\(oh\)₂|cu\(oh\)2/i.test(text)) return '#4fc3f7';
        if (/nâu đỏ|đỏ nâu|brown|fe\(oh\)₃|fe\(oh\)3/i.test(text)) return '#8b4a2b';
        if (/vàng|yellow|pbi₂|pbi2|agi/i.test(text)) return '#ffd54f';
        if (/đen|black|pbs|cus/i.test(text)) return '#222222';
        return '#ffffff';
    }

    function createReactionEffect(config) {

        if (!config) return;

        const raw = config.raw || config.reaction || {};
        const visual = raw.visual || {};
        const effectList = Array.isArray(config.effects) ? config.effects : (Array.isArray(raw.effects) ? raw.effects : []);
        const effects = Array.isArray(raw.effects) ? {} : (raw.effects || {});
        const byType = (type) => effectList.find(fx => fx?.type === type);
        const container = config.container || null;
        const position = config.position || getContainerEffectPosition(container);
        const gasAllowed = shouldEmitSmokeOrGas(config);

        const fire = effectPower(config.fire, byType('fire'), raw.fire, visual.fire_effect, effects.fire);
        const smoke = gasAllowed
            ? effectPower(config.smoke, byType('smoke'), raw.smoke, raw.vapor, visual.smoke_effect, visual.vapor_effect, effects.smoke, effects.vapor)
            : 0;
        const gas = gasAllowed
            ? effectPower(config.gas, byType('gas'), raw.gas, visual.gas_effect, effects.gas, hasGasProduct(config))
            : 0;
        const explosion = effectPower(config.explosion, raw.explosion, visual.explosion_effect, effects.explosion);
        const heat = effectPower(config.heat, byType('heat'), raw.heat, effects.heat);
        const foam = gasAllowed && Boolean(config.foam || raw.foam || effects.foam || byType('foam'));

        console.debug("[ReactionFX] interaction gas gate", {
            ...reactionGasDebug(config),
            fire,
            smoke,
            gas,
            explosion,
            heat,
            foam,
            effectActuallyTriggered: []
        });

        // Các hiệu ứng bay lên khỏi miệng cốc dùng world-space.
        // Kết tủa tuyệt đối KHÔNG spawn vào scene ở world-space, vì sẽ bị lệch ra ngoài dụng cụ.
        if (fire > 0) {
            spawnFireParticles(scene, position, { intensity: fire });
        }

        const graphGasHandled = gasAllowed &&
            container?.isObject3D &&
            ((hasExplicitSmoke(config) && smoke > 0) || gas > 0) &&
            Boolean(window.assemblyGraphManager?.propagateGasProduct?.(container, {
                gas: true,
                gasName: config.gasName || raw.gasName || raw.gas_name || visual.gasName || visual.gas_name || 'gas',
                color: config.gasColor || raw.gasColor || raw.gas_color || visual.gasColor || visual.gas_color || '#ffffff',
                gasIntensity: gas,
                smokeDensity: hasExplicitSmoke(config) ? smoke : 0,
                flowRate: config.gasFlowRate || raw.gasFlowRate || raw.gas_flow_rate || visual.gasFlowRate || visual.gas_flow_rate || Math.max(0.5, gas || smoke || 1)
            }, {
                scene,
                position
            }));

        if (!graphGasHandled && gasAllowed && hasExplicitSmoke(config) && smoke > 0) {
            spawnSmoke(scene, position, { density: smoke });
        }

        if (!graphGasHandled && gasAllowed && gas > 0) {
            spawnGasCloud(scene, position, { toxicity: gas });
        }

        if (explosion > 0) {
            createShockwave(scene, position, { power: explosion });
        }

        if (heat > 0) {
            heatDistortion(scene, position, { strength: heat });
        }

        if (gasAllowed && foam) {
            spawnFoam(scene, position, { intensity: effectPower(config.foam, byType('foam'), 1) || 1 });
        }
        console.debug("[ReactionFX] interaction triggered effects", {
            ...reactionGasDebug(config),
            effectActuallyTriggered: [
                fire > 0 ? 'fire' : null,
                graphGasHandled && hasExplicitSmoke(config) && smoke > 0 ? 'graph_smoke' : null,
                graphGasHandled && gas > 0 ? 'graph_gas' : null,
                !graphGasHandled && gasAllowed && hasExplicitSmoke(config) && smoke > 0 ? 'smoke' : null,
                !graphGasHandled && gasAllowed && gas > 0 ? 'gas' : null,
                explosion > 0 ? 'explosion' : null,
                heat > 0 ? 'heat' : null,
                gasAllowed && foam ? 'foam' : null
            ].filter(Boolean)
        });
    }

    function normalizeForCompare(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function chemistryLabels(object) {
        const u = object?.userData || {};
        return [
            u.current_chemical_name,
            u.chemicalName,
            u.name_vi,
            u.formula,
            u.current_chemical_type,
            u.chemicalType,
            u.chemical_type,
            ...(u.contents || []),
            ...(u.products || []),
            ...(u.reactionProducts || []),
            ...Object.keys(u.composition || {})
        ].filter(Boolean).map(normalizeForCompare);
    }

    function hasChemistryLabel(object, needles) {
        const labels = chemistryLabels(object);
        const normalizedNeedles = needles.map(normalizeForCompare);
        return labels.some(label =>
            normalizedNeedles.some(needle => label === needle || label.includes(needle))
        );
    }

    function isPhenolphthaleinCarrier(object) {
        return hasChemistryLabel(object, [
            'phenolphthalein',
            'phenolphtalein',
            'indicator_phenol'
        ]);
    }

    function isBasicCarrier(object) {
        return hasChemistryLabel(object, [
            'naoh',
            'natri hydroxit',
            'sodium hydroxide',
            'amoniac',
            'ammonia',
            'nh3',
            'strong_base',
            'weak_base'
        ]);
    }

    function getPhenolphthaleinBaseReaction(source, target) {
        const matchesIndicatorPair =
            (isPhenolphthaleinCarrier(source) && isBasicCarrier(target)) ||
            (isBasicCarrier(source) && isPhenolphthaleinCarrier(target));
        if (!matchesIndicatorPair) return null;

        return {
            has_reaction: true,
            id: 'phenolphthalein_base_pink',
            color: '#FF1493',
            gas: 0,
            smoke: 0,
            fire: 0,
            explosion: 0,
            heat: 0,
            foam: false,
            precipitate: false,
            result_chemical_type: 'indicator_solution',
            result_chemical_id: 'phenolphthalein_basic_form',
            equation: 'Phenolphthalein + base -> pink form',
            products: ['Phenolphthalein dạng bazơ'],
            effects: [{ type: 'colorChange', color: '#FF1493' }],
            producesState: { indicator: 'pink' },
            reactionMessage: 'Phenolphthalein chuyển hồng cánh sen trong môi trường bazơ.',
            raw: {
                id: 'phenolphthalein_base_pink',
                has_reaction: true,
                color: '#FF1493',
                result_chemical_type: 'indicator_solution',
                equation: 'Phenolphthalein + base -> pink form',
                products: ['Phenolphthalein dạng bazơ'],
                effects: [{ type: 'colorChange', color: '#FF1493' }],
                producesState: { indicator: 'pink' },
                reactionMessage: 'Phenolphthalein chuyển hồng cánh sen trong môi trường bazơ.'
            }
        };
    }

    function isPhenolphthaleinBaseReaction(reaction) {
        return reaction?.id === 'phenolphthalein_base_pink' || reaction?.raw?.id === 'phenolphthalein_base_pink';
    }

    function isSilverOxidePrecipitationReaction(reaction) {
        return reaction?.id === 'ag_no3_nh3_ag2o' || reaction?.raw?.id === 'ag_no3_nh3_ag2o';
    }

    function reactionTemperatureTarget(reaction) {
        const raw = reaction?.raw || {};
        const conditions = reaction?.conditions || raw?.conditions || raw?.reaction_data?.conditions || {};
        const value =
            reaction?.target_temperature ??
            reaction?.targetTemperature ??
            reaction?.requiredTemperature ??
            reaction?.required_temperature ??
            conditions?.minTemperature ??
            raw?.requiredTemperature ??
            raw?.required_temperature;
        const n = Number(value);
        if (Number.isFinite(n)) return n;
        if (reaction?.heating_required || reaction?.heatingRequired) return DEFAULT_REACTION_HEAT_TEMPERATURE;
        return null;
    }

    function reactionRequiresHeating(reaction) {
        return Boolean(
            reaction?.heating_required ||
            reaction?.heatingRequired ||
            reactionTemperatureTarget(reaction) !== null
        );
    }

    function checkTemperature(container, reaction) {
        if (!reactionRequiresHeating(reaction)) return true;
        const current = Number(container?.userData?.currentTemperature ?? container?.userData?.temperature ?? 25);
        const target = reactionTemperatureTarget(reaction);
        const tolerance = Number(reaction?.temperature_tolerance ?? reaction?.temperatureTolerance ?? 5);
        if (target === null) return false;
        return current >= target - tolerance;
    }

    function findActiveHeatingSourceBelowReactionContainer(container) {
        return window.heatingManager?.findActiveHeatingSourceBelowContainer?.(container) || null;
    }

    function getHeatingRequiredMessage(container) {
        const source = findActiveHeatingSourceBelowReactionContainer(container);
        if (!source) {
            return 'Phản ứng cần nhiệt. Hãy đặt nguồn nhiệt đang bật bên dưới dụng cụ chứa phản ứng.';
        }
        return `Phản ứng đang chờ gia nhiệt. Nhiệt độ hiện khoảng ${Number(container?.userData?.currentTemperature ?? 25).toFixed(1)}°C.`;
    }

    function containerHasSpecies(container, name) {
        if (!name || !container?.userData) return true;
        const needle = normalizeForCompare(name);
        const values = [
            container.userData.current_chemical_name,
            container.userData.chemicalName,
            container.userData.current_chemical_type,
            container.userData.chemicalType,
            ...(container.userData.contents || []),
            ...(container.userData.products || []),
            ...(container.userData.reactionProducts || []),
            ...Object.keys(container.userData.composition || {})
        ].filter(Boolean).map(normalizeForCompare);
        return values.some(value => value === needle || value.includes(needle) || needle.includes(value));
    }

    function checkCatalyst(container, reaction) {
        const raw = reaction?.raw || {};
        const conditions = reaction?.conditions || raw?.conditions || raw?.reaction_data?.conditions || {};
        const catalyst = reaction?.catalyst || conditions?.catalyst;
        return containerHasSpecies(container, catalyst);
    }

    function getPendingReactionPayload(reaction) {
        return reaction?.pendingReaction || reaction?.pending_reaction_data || reaction?.reaction || null;
    }

    function isPendingReactionResult(reaction) {
        return Boolean(reaction?.pending_reaction || reaction?.pendingReaction || reaction?.reason === 'pending_temperature');
    }

    function storePendingReaction(container, reaction, source = null) {
        const pending = getPendingReactionPayload(reaction);
        if (!container?.userData || !pending) return false;
        container.userData.pendingReaction = {
            ...pending,
            heating_required: pending.heating_required ?? true,
            target_temperature: pending.target_temperature ?? reaction.requiredTemperature ?? reactionTemperatureTarget(pending),
            temperature_tolerance: pending.temperature_tolerance ?? 5
        };
        container.userData.pendingReason = reaction.pendingReason || reaction.pending_reason || ['temperature'];
        container.userData.pendingSourceSnapshot = source ? {
            name: getChemicalName(source),
            id: getChemicalId(source),
            type: getChemicalType(source),
            color: getChemicalColor(source)
        } : null;
        container.userData.pendingReactionStartedAt = Date.now();
        console.log('[ReactionManager] pending reaction:', container.userData.pendingReaction.name || container.userData.pendingReaction.id);
        console.log('[ReactionManager] temperature ok:', checkTemperature(container, container.userData.pendingReaction));
        return true;
    }

    function applyPendingReaction(container, reaction) {
        if (!container?.userData || !reaction) return;
        const targetObject = container;
        reaction.has_reaction = true;
        console.log('[ReactionManager] triggering pending reaction:', reaction.name || reaction.id);

        createReactionEffect({
            container: targetObject,
            position: getContainerEffectPosition(targetObject),
            color: reaction.color,
            gas: reaction.gas,
            smoke: reaction.smoke,
            fire: reaction.fire,
            explosion: reaction.explosion,
            heat: reaction.heat,
            foam: reaction.foam,
            gasColor: reaction.gasColor,
            smokeColor: reaction.smokeColor,
            raw: reaction.raw || reaction,
            effects: reaction.effects,
            precipitate: reaction.precipitate,
            precipitateColor: reaction.precipitateColor
        });

        queueLiquidLevelRise(targetObject, 0.003);
        const volume = pouringEffect.getOrCreateVolume(targetObject);

        if (reaction.color && volume) {
            const reactionColor = new three.Color(reaction.color);
            volume.userData.targetColor = reactionColor;
            volume.userData.isColorLerping = true;
            volume.material.emissive = reactionColor.clone().multiplyScalar(0.08);
            volume.material.needsUpdate = true;
            targetObject.userData.liquidColor = reactionColor.clone();
        }

        const allowGasVisual = shouldEmitSmokeOrGas(reaction);
        const allowContinuousSmoke = allowGasVisual && hasExplicitSmoke(reaction);
        targetObject.userData.hasGasEffect = allowGasVisual;
        targetObject.userData.hasSmokeEffect = allowContinuousSmoke;
        if (volume) {
            volume.userData.hasGasEffect = allowGasVisual;
            volume.userData.hasSmokeEffect = allowContinuousSmoke;
        }
        if (!allowContinuousSmoke) pouringEffect.clearSmokeEffectForTarget?.(targetObject);

        if (targetObject.userData.hasSolidDeposit) {
            clearDissolvablePowder(targetObject);
            targetObject.userData.hasSolidDeposit = false;
        }

        if (hasPrecipitateReaction(reaction)) {
            const precipitateColor = getPrecipitateColor(reaction);
            createPrecipitate(targetObject, precipitateColor);
            targetObject.userData.hasPrecipitate = true;
            targetObject.userData.precipitateColor = precipitateColor;
            if (volume) volume.userData.hasPrecipitate = true;
        }
        if (reaction.dissolvePrecipitate) {
            clearPrecipitateLayer(targetObject);
            if (volume) volume.userData.hasPrecipitate = false;
        }
        if (reaction.mirrorCoating) createSilverMirrorCoating(targetObject);
        if (reaction.decolorize && volume) decolorizeLiquid(targetObject, reaction.color || '#ffffff');
        if (reaction.twoLayerLiquid && volume) {
            volume.userData.twoLayerLiquid = true;
            targetObject.userData.twoLayerLiquid = true;
            applyPhaseSeparation(targetObject, {
                upperColor: targetObject.userData.upperLayerColor || '#fff4c2',
                lowerColor: targetObject.userData.lowerLayerColor || '#f8f8ff'
            });
        }

        rememberContainerContents(targetObject, reaction.products || [], reaction.result_chemical_id, reaction.result_chemical_type);
        addContainerComposition(targetObject, reaction.products || [], reaction.result_chemical_id, reaction.result_chemical_type);
        applyReactionState(targetObject, reaction);
        markReactionSuccess(targetObject, reaction);

        targetObject.userData.current_chemical_type = reaction.result_chemical_type || 'generic_solution';
        targetObject.userData.current_chemical_id = reaction.result_chemical_id || `${reaction.id || 'heated_reaction'}_${Date.now()}`;
        targetObject.userData.reactionStage = (targetObject.userData.reactionStage || 0) + 1;
        targetObject.userData.chemicalType = targetObject.userData.current_chemical_type;
        targetObject.userData.chemicalName = (reaction.products && reaction.products[0]) || 'Dung dịch phản ứng';
        targetObject.userData.current_chemical_name = targetObject.userData.chemicalName;
        targetObject.userData.color = reaction.color;

        if (volume) {
            volume.userData.chemicalType = targetObject.userData.chemicalType;
            volume.userData.chemicalName = targetObject.userData.chemicalName;
            volume.userData.color = reaction.color;
        }

        targetObject.userData.isReacting = true;
        window.setTimeout(() => {
            if (targetObject?.userData) targetObject.userData.isReacting = false;
        }, 1800);

        notifyLab(hasActiveExperimentPlan()
            ? (window.currentExperimentPlan?.success_message || formatReactionMessage(reaction))
            : formatReactionMessage(reaction));
    }

    function tryTriggerPendingReaction(container) {
        const reaction = container?.userData?.pendingReaction;
        if (!reaction) return;
        const temperatureOk = checkTemperature(container, reaction);
        const catalystOk = checkCatalyst(container, reaction);
        const now = performance.now();
        if (!container.userData.lastPendingReactionLogAt || now - container.userData.lastPendingReactionLogAt > 1000) {
            console.log('[ReactionManager] pending reaction:', reaction.name || reaction.id);
            console.log('[ReactionManager] temperature ok:', temperatureOk);
            container.userData.lastPendingReactionLogAt = now;
        }
        if (!temperatureOk || !catalystOk) return;
        container.userData.pendingReaction = null;
        container.userData.pendingReason = null;
        applyPendingReaction(container, reaction);
    }

    window.ReactionManager = {
        ...(window.ReactionManager || {}),
        tryTriggerPendingReaction,
        checkTemperature,
        checkCatalyst
    };
    window.tryTriggerPendingReaction = tryTriggerPendingReaction;


    window.checkPouringCollision = () => {
        if (!pouringEffect || !pouringEffect.isPouring) return;

        const potentialSources = (activePourSource ? [activePourSource] : [heldObjectRight || heldObjectLeft]).filter(isPourSource);

        potentialSources.forEach(sourceObj => {
            sourceObj.updateMatrixWorld(true);

            // --- BƯỚC 2: CẬP NHẬT TỌA ĐỘ ĐỘNG CỦA ĐIỂM ĐỔ NƯỚC ---
            let pourPoint = new three.Vector3();
            if (sourceObj.userData.pourAnchor) {
                // Lấy tọa độ thế giới từ điểm neo pourAnchor đã tính ở Bước 1
                pourPoint.copy(sourceObj.userData.pourAnchor).applyMatrix4(sourceObj.matrixWorld);
            } else {
                // Fallback nếu chưa có anchor
                const box = new three.Box3().setFromObject(sourceObj);
                pourPoint.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
            }

            // Cập nhật vị trí bắt đầu dòng chảy trong visual effect
            pouringEffect.emit(pourPoint);

            // --- BƯỚC 3: SỬ DỤNG RAYCASTING ĐỂ "BUỘC" DÒNG CHẢY RƠI VÀO CỐC ---
            const allTargets = draggableObjects.filter(obj =>
                obj && obj !== sourceObj && isPourReceiver(obj)
            );

            // Tìm tâm mục tiêu gần nhất trước để định hướng dòng chảy
            let nearestTargetCenter = null;
            let nearestDist = Infinity;

            allTargets.forEach(target => {
                const box = new three.Box3().setFromObject(target);
                const center = new three.Vector3();
                box.getCenter(center);
                const d = pourPoint.distanceTo(center);

                if (d < nearestDist) {
                    nearestDist = d;
                    nearestTargetCenter = center;
                }
            });

            // Hướng đổ THẬT
            let pourDirection;
            if (nearestTargetCenter) {
                // Aim trực tiếp vào tâm cốc
                pourDirection = nearestTargetCenter.clone().sub(pourPoint).normalize();
            } else {
                // fallback hướng xuống
                pourDirection = new three.Vector3(0, -1, 0);
            }

            downRaycaster.set(pourPoint, pourDirection);
            downRaycaster.camera = getHandRayCamera();

            // Danh sách các vật thể có thể nhận chất lỏng (cốc, ống nghiệm, hoặc chính khối chất lỏng)
            const fluidVolumes = Array.from(pouringEffect.volumes.values());
            const raycastTargets = [...allTargets, ...fluidVolumes];

            let intersects = downRaycaster.intersectObjects(raycastTargets, true);
            let targetHit = null;
            let streamEnd = null;
            const explicitTarget = getPreferredPourTargetForSource(sourceObj);

            if (explicitTarget) {
                streamEnd = getContainerEffectPosition(explicitTarget);
                targetHit = { object: explicitTarget, point: streamEnd };
            }

            if (!targetHit && intersects.length > 0) {
                targetHit = intersects[0];

                const targetObj =
                    targetHit.object.userData.container ||
                    resolveDraggableRoot(targetHit.object) ||
                    targetHit.object;

                const targetBox = new three.Box3().setFromObject(targetObj);
                const targetCenter = new three.Vector3();
                targetBox.getCenter(targetCenter);

                // Luôn hút vào miệng cốc (kết thúc ở miệng thay vì center sâu bên dưới)
                streamEnd = new three.Vector3(
                    targetCenter.x,
                    targetBox.max.y + 0.05, // Cao hơn miệng 1 chút để tạo tia đâm vào
                    targetCenter.z
                );
            } else if (!targetHit) {
                // --- CƠ CHẾ TỰ ĐỘNG HÚT (MAGNETIC SNAP) CẢI TIẾN ---
                // Tăng bán kính tìm kiếm lên 0.55m để dễ đổ trúng hơn
                let bestDist = 0.55;
                allTargets.forEach(target => {
                    const targetBox = new three.Box3().setFromObject(target);
                    const targetCenter = new three.Vector3();
                    targetBox.getCenter(targetCenter);

                    const dx = pourPoint.x - targetCenter.x;
                    const dz = pourPoint.z - targetCenter.z;
                    const distXZ = Math.sqrt(dx * dx + dz * dz);

                    // Kiểm tra: Trong bán kính 0.55m và miệng lọ phải cao hơn thân dụng cụ
                    if (distXZ < bestDist && (targetBox.max.y - 0.1) < pourPoint.y) {
                        bestDist = distXZ;
                        // Điểm rơi sẽ là miệng của dụng cụ
                        streamEnd = new three.Vector3(targetCenter.x, targetBox.max.y + 0.05, targetCenter.z);
                        targetHit = { object: target, point: streamEnd };
                    }
                });
            }

            // --- CHỈ ĐỔ KHI LỌ ĐÃ NGHIÊNG ĐỦ ĐỘ (X hoặc Z) ---
            const worldRot = new three.Euler().setFromQuaternion(
                sourceObj.getWorldQuaternion(new three.Quaternion())
            );
            const tiltAmount = Math.max(Math.abs(worldRot.x), Math.abs(worldRot.z));

            if (targetHit && tiltAmount > Math.PI * 0.35) {
                const nearestTarget =
                    targetHit.object.userData.container ||
                    resolveDraggableRoot(targetHit.object) ||
                    targetHit.object;

                pouringState.currentPourTargetPos = streamEnd;
                handlePourSuccess(sourceObj, nearestTarget, streamEnd);
            } else {
                if (tiltAmount > Math.PI * 0.35) {
                    const fallEnd = pourPoint.clone();
                    fallEnd.y = Math.max(pourPoint.y - 1.5, 0);
                    pouringState.currentPourTargetPos = fallEnd;
                } else {
                    pouringState.currentPourTargetPos = null;
                }
            }
        });
    };


    function addSourceContentToContainer(target, source, options = {}) {
        if (!target || !source || !target.userData) return null;

        const sourceState = getPhysicalState(source);
        const sourceColorValue = getChemicalColor(source);
        const targetAlreadyHasLiquid = isContainerHoldingLiquid(target);
        const targetAlreadyHasSolid = isSolidChemical(target) || !!target.userData.hasSolidDeposit;

        // Rắn + dụng cụ trống: giữ dạng bột/hạt.
        // Rắn + lỏng: hòa tan vào pha lỏng, KHÔNG để lại lớp bột rắn.
        if (isSolidChemical(source)) {
            if (!targetAlreadyHasLiquid && !options.forceDissolve) {
                createPowderDeposit(target, sourceColorValue || '#dddddd');
                target.userData.hasSolidDeposit = true;
                target.userData.current_chemical_id = getChemicalId(source);
                target.userData.current_chemical_type = getChemicalType(source);
                target.userData.current_chemical_name = getChemicalName(source);
                target.userData.chemicalType = getChemicalType(source);
                target.userData.chemicalName = getChemicalName(source);
                target.userData.color = sourceColorValue;
                target.userData.current_physical_state = sourceState;
                target.userData.physical_state = sourceState;
                rememberContainerContents(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
                addContainerComposition(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
                return null;
            }

            clearDissolvablePowder(target);
            target.userData.hasSolidDeposit = false;
            target.userData.current_physical_state = 'Lỏng';
            target.userData.physical_state = 'Lỏng';
        }

        // Chất lỏng hoặc chất rắn đang hòa tan đều tạo/cập nhật pha dung dịch.
        // Lỏng + rắn: xóa lớp bột cũ vì bột đã hòa tan vào dung dịch.
        if (!isSolidChemical(source) && targetAlreadyHasSolid && !options.keepPowder) {
            clearDissolvablePowder(target);
            target.userData.hasSolidDeposit = false;
        }

        queueLiquidLevelRise(target, options.amount || 0.003, { direct: options.direct });

        const volume = pouringEffect.getOrCreateVolume(target);
        target.userData.hasGasEffect = false;
        target.userData.hasSmokeEffect = false;
        volume.userData.hasGasEffect = false;
        volume.userData.hasSmokeEffect = false;
        pouringEffect.clearSmokeEffectForTarget?.(target);

        const sourceColor = new three.Color(sourceColorValue || '#3498db');

        // Nếu cốc đã có màu lỏng cũ thì pha màu nhẹ, tránh mất cảm giác đang trộn/hòa tan.
        if (target.userData.liquidColor && !options.forceSourceColor) {
            sourceColor.lerp(target.userData.liquidColor, isSolidChemical(source) ? 0.72 : 0.45);
        }

        volume.userData.chemicalType = options.chemicalType || getChemicalType(source);
        volume.userData.chemicalName = options.chemicalName || getChemicalName(source);
        volume.userData.color = '#' + sourceColor.getHexString();

        if (volume.material) {
            volume.material.color.copy(sourceColor);
            volume.material.needsUpdate = true;
        }

        target.userData.liquidColor = sourceColor.clone();
        target.userData.color = '#' + sourceColor.getHexString();

        // Chỉ ghi đè danh tính hóa chất khi cốc trống/cùng chất.
        if (options.replaceIdentity) {
            target.userData.current_chemical_id = getChemicalId(source);
            target.userData.current_chemical_type = getChemicalType(source);
            target.userData.current_chemical_name = getChemicalName(source);
            target.userData.chemicalType = getChemicalType(source);
            target.userData.chemicalName = getChemicalName(source);
        }

        target.userData.current_physical_state = 'Lỏng';
        target.userData.physical_state = 'Lỏng';

        rememberContainerContents(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
        addContainerComposition(target, getChemicalName(source), getChemicalType(source), getChemicalId(source));
        pouringEffect.update?.(getContainerEffectPosition(target));

        return volume;
    }

    function stopPouringForAutoStop(source) {
        isPouringAction = false;
        activePourSource = null;
        if (source) source.rotation.z = 0;
        pouringEffect.stop();
        lastPouredTarget = null;
    }

    // Hàm phụ xử lý khi đổ thành công
    async function handlePourSuccess(source, target, targetMouthPos, options = {}) {
        if (!target || !target.userData) return;

        const selectedQuantity = getSelectedQuantity(source);
        const visualAmount = Number.isFinite(options.visualAmount)
            ? options.visualAmount
            : (options.direct ? getVisiblePourAmount(selectedQuantity) : 0.003);
        const pourRecord = recordPourAction({
            source,
            target,
            amount: selectedQuantity.amount,
            unit: selectedQuantity.unit,
            physicalState: getPhysicalState(source)
        });
        if (pourRecord.autoStopped) {
            stopPouringForAutoStop(source);
        }

        // Lấy thông tin chemical_type động (nếu cốc đã phản ứng trước đó, lấy chất mới sinh ra)
        const sourceChemType = getChemicalType(source);
        const targetChemType = getChemicalType(target);

        const sourceId = getChemicalId(source);
        const targetId = getChemicalId(target);

        // 1. Trường hợp cốc trống hoặc đổ cùng loại chất.
        // Nếu chất nguồn là RẮN thì KHÔNG tạo liquid volume; chỉ tạo lớp bột/hạt trong dụng cụ.
        if (!targetChemType || targetId === sourceId) {
            addSourceContentToContainer(target, source, {
                replaceIdentity: true,
                forceSourceColor: true,
                amount: visualAmount,
                direct: options.direct
            });
            if (hasActiveExperimentPlan() && pourRecord.recorded) {
                const guidance = describeNextRequirement(target);
                if (guidance) notifyLab(guidance);
            }
            if (pourRecord.autoStopped) {
                stopPouringForAutoStop(source);
                if (pourRecord.message) notifyLab(pourRecord.message);
            }
            return;
        }

        // 2. Trường hợp trộn 2 chất khác nhau và cốc không trong trạng thái đợi đổi màu cũ kết thúc
        if (targetChemType && targetId !== sourceId && !target.userData.isReacting) {
            const now = performance.now();
            if (
                target.lastReactionCheck &&
                now - target.lastReactionCheck < 1500 &&
                !pourRecord.autoStopped
            ) {
                return;
            }
            target.lastReactionCheck = now;
            target.userData.isReacting = true; // Khóa tạm thời để tránh spam

            const type1 = getChemicalType(source);

            const type2 = getChemicalType(target);

            if (sourceId === targetId) {
                target.userData.isReacting = false;
                return;
            }

            console.log("REACTION CHECK:", { type1, type2, sourceId, targetId });

            const indicatorReaction = getPhenolphthaleinBaseReaction(source, target);

            if (hasActiveExperimentPlan() && !indicatorReaction) {
                const validation = validateExperimentBeforeReaction({ source, target, skipTemperature: true });
                if (!validation.ok) {
                    addSourceContentToContainer(target, source, {
                        replaceIdentity: false,
                        forceSourceColor: false,
                        amount: visualAmount,
                        direct: options.direct
                    });
                    target.userData.isReacting = false;
                    notifyLab(validation.message || 'Thí nghiệm chưa đúng điều kiện nên phản ứng chưa xảy ra.');
                    return;
                }
            }

            const reaction = indicatorReaction || await detectReaction(source, target);

            console.log("REACTION RESULT:", reaction);

            if (reaction?.has_reaction || isPendingReactionResult(reaction)) {
                const reactionForSetup = isPendingReactionResult(reaction) ? getPendingReactionPayload(reaction) : reaction;
                const setupValidation = window.labAssemblyManager?.validateReactionSetup?.(
                    reactionForSetup,
                    target
                );
                const allowPendingHeatSetup = setupValidation?.missing === 'heating' && reactionRequiresHeating(reactionForSetup);
                if (setupValidation && !setupValidation.ok && !allowPendingHeatSetup) {
                    addSourceContentToContainer(target, source, {
                        replaceIdentity: false,
                        forceSourceColor: false,
                        amount: visualAmount,
                        direct: options.direct
                    });
                    target.userData.isReacting = false;
                    notifyLab(setupValidation.message || 'Cần lắp đúng bộ dụng cụ trước khi phản ứng xảy ra.');
                    return;
                }
            }

            if (isPendingReactionResult(reaction)) {
                addSourceContentToContainer(target, source, {
                    replaceIdentity: false,
                    forceSourceColor: false,
                    amount: visualAmount,
                    direct: options.direct
                });
                storePendingReaction(target, reaction, source);
                target.userData.isReacting = false;
                const targetTemp = reaction.requiredTemperature ?? reactionTemperatureTarget(getPendingReactionPayload(reaction));
                notifyLab(getHeatingRequiredMessage(target));
                return;
            }

            if (reaction?.has_reaction && reactionRequiresHeating(reaction) && !checkTemperature(target, reaction)) {
                addSourceContentToContainer(target, source, {
                    replaceIdentity: false,
                    forceSourceColor: false,
                    amount: visualAmount,
                    direct: options.direct
                });
                storePendingReaction(target, {
                    pending_reaction: true,
                    pendingReason: ['temperature'],
                    pendingReaction: reaction,
                    requiredTemperature: reactionTemperatureTarget(reaction),
                    currentTemperature: target.userData.currentTemperature ?? 25
                }, source);
                target.userData.isReacting = false;
                notifyLab(getHeatingRequiredMessage(target));
                return;
            }

            if (hasActiveExperimentPlan() && !isPhenolphthaleinBaseReaction(reaction)) {
                const conditionValidation = validateExperimentBeforeReaction({ source, target });
                if (!conditionValidation.ok) {
                    addSourceContentToContainer(target, source, {
                        replaceIdentity: false,
                        forceSourceColor: false,
                        amount: visualAmount,
                        direct: options.direct
                    });
                    target.userData.isReacting = false;
                    notifyLab(conditionValidation.message || 'Thí nghiệm chưa đủ điều kiện nên phản ứng chưa xảy ra.');
                    return;
                }
                const reactionValidation = validateReactionResult(reaction);
                if (!reactionValidation.ok) {
                    addSourceContentToContainer(target, source, {
                        replaceIdentity: false,
                        forceSourceColor: false,
                        amount: visualAmount,
                        direct: options.direct
                    });
                    target.userData.isReacting = false;
                    notifyLab(reactionValidation.message || 'Phản ứng chưa khớp thí nghiệm đã chọn nên chưa được sinh ra.');
                    return;
                }
            }

            if (reaction.has_reaction) {
                console.log("Phản ứng xảy ra!");

                const targetObject = target;

                createReactionEffect({
                    container: targetObject,
                    position: getContainerEffectPosition(targetObject),
                    color: reaction.color,
                    gas: reaction.gas,
                    smoke: reaction.smoke,
                    fire: reaction.fire,
                    explosion: reaction.explosion,
                    heat: reaction.heat,
                    foam: reaction.foam,
                    gasColor: reaction.gasColor,
                    smokeColor: reaction.smokeColor,
                    raw: reaction.raw || reaction,
                    effects: reaction.effects,
                    precipitate: reaction.precipitate,
                    precipitateColor: reaction.precipitateColor
                });

                // Bảo đảm phản ứng lỏng + rắn cũng có pha lỏng trong dụng cụ để hiển thị/tiếp tục trộn.
                queueLiquidLevelRise(targetObject, visualAmount, { direct: options.direct });

                const volume = pouringEffect.getOrCreateVolume(targetObject);

                // đổi màu
                if (reaction.color) {

                    volume.userData.targetColor =
                        new three.Color(reaction.color);

                    volume.userData.isColorLerping = true;

                    // phát sáng nhẹ cho dung dịch
                    volume.material.emissive =
                        new three.Color(reaction.color)
                            .multiplyScalar(0.08);

                    volume.material.needsUpdate = true;
                }

                // hiệu ứng khí chỉ bật khi phản ứng có sản phẩm khí/flag gas-smoke-vapor rõ ràng.
                const allowGasVisual = shouldEmitSmokeOrGas(reaction);
                const allowContinuousSmoke = allowGasVisual && hasExplicitSmoke(reaction);
                volume.userData.hasGasEffect = allowGasVisual;
                volume.userData.hasSmokeEffect = allowContinuousSmoke;
                targetObject.userData.hasGasEffect = allowGasVisual;
                targetObject.userData.hasSmokeEffect = allowContinuousSmoke;
                if (!allowContinuousSmoke) {
                    pouringEffect.clearSmokeEffectForTarget?.(targetObject);
                }

                // cháy
                volume.userData.hasFireEffect =
                    reaction.fire;

                // đánh dấu đang phản ứng
                targetObject.userData.isReacting = true;
                window.setTimeout(() => {
                    if (targetObject?.userData) targetObject.userData.isReacting = false;
                }, 1800);

                console.log("REACTION APPLIED:", reaction);

                // Nếu một trong hai chất ban đầu là rắn thì phần rắn ban đầu đã tham gia phản ứng/hòa tan.
                // Không giữ lại lớp bột cũ; nếu phản ứng tạo kết tủa thì tạo lớp kết tủa mới bên dưới.
                if (isSolidChemical(source) || isSolidChemical(targetObject)) {
                    clearDissolvablePowder(targetObject);
                    targetObject.userData.hasSolidDeposit = false;
                }

                // kết tủa
                // FIX: không chỉ dựa vào reaction.precipitate boolean.
                // Một số API/rule chỉ trả phương trình có dấu ↓ hoặc mô tả "kết tủa".
                if (hasPrecipitateReaction(reaction)) {
                    const precipitateColor = getPrecipitateColor(reaction);
                    createPrecipitate(
                        targetObject,
                        precipitateColor
                    );
                    targetObject.userData.hasPrecipitate = true;
                    targetObject.userData.precipitateColor = precipitateColor;
                    volume.userData.hasPrecipitate = true;
                }

                if (reaction.dissolvePrecipitate) {
                    clearPrecipitateLayer(targetObject);
                    if (volume) volume.userData.hasPrecipitate = false;
                }

                if (reaction.mirrorCoating) {
                    createSilverMirrorCoating(targetObject);
                }

                if (reaction.decolorize && volume) {
                    decolorizeLiquid(targetObject, reaction.color || '#ffffff');
                }

                if (reaction.twoLayerLiquid && volume) {
                    volume.userData.twoLayerLiquid = true;
                    targetObject.userData.twoLayerLiquid = true;
                    applyPhaseSeparation(targetObject, {
                        upperColor: targetObject.userData.upperLayerColor || '#fff4c2',
                        lowerColor: targetObject.userData.lowerLayerColor || '#f8f8ff'
                    });
                }

                rememberContainerContents(
                    targetObject,
                    getChemicalName(source),
                    getChemicalName(targetObject),
                    reaction.products || [],
                    reaction.result_chemical_id,
                    reaction.result_chemical_type
                );
                addContainerComposition(
                    targetObject,
                    getChemicalName(source),
                    getChemicalType(source),
                    reaction.products || [],
                    reaction.result_chemical_id,
                    reaction.result_chemical_type
                );
                applyReactionState(targetObject, reaction);
                markReactionSuccess(targetObject, reaction);

                // --- ĐỒNG BỘ TRẠNG THÁI HÓA CHẤT MỚI SAU PHẢN ỨNG ---
                target.userData.current_chemical_type = reaction.result_chemical_type || "generic_solution";
                target.userData.current_chemical_id = reaction.result_chemical_id ||`${sourceId}_reacted_${Date.now()}`;
                target.userData.reactionStage = (target.userData.reactionStage || 0) + 1;

                target.userData.chemicalType = reaction.result_chemical_type || "generic_solution";
                target.userData.chemicalName = (reaction.products && reaction.products[0]) || "Dung dịch phản ứng";
                target.userData.current_chemical_name = target.userData.chemicalName;
                target.userData.color = reaction.color;

                if (volume) {
                    volume.userData.chemicalType = reaction.result_chemical_type || "generic_solution";
                    volume.userData.chemicalName = (reaction.products && reaction.products[0]) || "Dung dịch phản ứng";
                    volume.userData.color = reaction.color;

                    if (reaction.color) {

                        const reactionColor = new three.Color(reaction.color);

                        // lưu màu mới
                        target.userData.liquidColor = reactionColor.clone();

                        // FORCE đổi màu marching cubes
                        if (volume.material) {

                            volume.material.color.set(reactionColor);

                            volume.material.emissive = reactionColor.clone().multiplyScalar(0.15);

                            volume.material.needsUpdate = true;
                        }

                        // nếu material clone bên trong marching cubes
                        if (volume.mesh && volume.mesh.material) {

                            volume.mesh.material.color.set(reactionColor);

                            volume.mesh.material.needsUpdate = true;
                        }
                    }
                }

                // Thông báo chỉ hiển thị kết quả phản ứng: reaction_message + equation.
                if (hasActiveExperimentPlan() && !isPhenolphthaleinBaseReaction(reaction)) {
                    notifyLab(window.currentExperimentPlan?.success_message || formatReactionMessage(reaction));
                } else {
                    notifyLab(formatReactionMessage(reaction));
                }

                if (isSilverOxidePrecipitationReaction(reaction)) {
                    stopPouringForAutoStop(source);
                }
            } else {
                // Trộn vật lý thông thường, không phản ứng.
                // FIX: trước đây nhánh này chỉ mở khóa + tăng liquidLevel ở cuối,
                // nên khi cốc đang có chất rắn thì không hề tạo volume lỏng => nhìn như không đổ được lỏng vào rắn.
                addSourceContentToContainer(target, source, {
                    replaceIdentity: false,
                    forceSourceColor: false,
                    amount: visualAmount,
                    direct: options.direct
                });
                target.userData.hasGasEffect = false;
                target.userData.hasSmokeEffect = false;
                pouringEffect.clearSmokeEffectForTarget?.(target);
                target.userData.isReacting = false;
                return;
            }
        }

        // Tăng mực nước dâng lên khi đổ chất liên tục sau phản ứng thật.
        if (!options.direct) {
            queueLiquidLevelRise(target, visualAmount, { direct: options.direct });
        }
    }

    // --- LOGIC KÉO THẢ (MOUSE/ORBIT) ---
    window.addEventListener('pointerdown', (e) => {
        if (fps.isLocked) {
            if (e.button === 0) { // Left Click
                handleHandInteraction(true);
            } else if (e.button === 2) { // Right Click
                handleHandInteraction(false);
            }
            return;
        }

        // CHỈ KÉO THẢ BẰNG CHUỘT TRÁI (Button 0)
        if (e.button !== 0) return;
        if (toolRotateState.activeAxis) return;

        updateRaycaster(e);
        const candidates = getInteractionCandidates();
        const intersects = raycaster.intersectObjects(candidates, true);
        if (intersects.length > 0) {
            draggedObject = resolveDraggableRoot(intersects[0].object);
            if (!draggedObject) return;
            const isMovableTableDrag = isMovableTableObject(draggedObject);

            // Khi bắt đầu kéo một vật mới, vật đó cũng phải trở thành vật đang được chọn.
            // Tránh context menu/rotation còn trỏ tới vật cũ như nguồn nhiệt.
            selectedObjectForMenu = draggedObject;

            if (!isMovableTableDrag) {
                window.labAssemblyManager?.beginMagneticDrag?.(draggedObject);
                releaseHeatingSnapIfNeeded(draggedObject);
            }
            const savedScale = getSavedScale(draggedObject);
            attachKeepWorldTransform(scene, draggedObject);
            markChemicalBottleOutOfCabinet(draggedObject);
            if (pouringEffect) pouringEffect.invalidateCavity(draggedObject);

            // Khôi phục scale và hướng xoay chuẩn (World)
            if (!draggedObject.userData.originalWorldScale) {
                draggedObject.userData.originalWorldScale = getObjectWorldScale(draggedObject);
            }
            if (!draggedObject.userData.originalQuaternion) {
                const worldQuat = new three.Quaternion();
                draggedObject.getWorldQuaternion(worldQuat);
                draggedObject.userData.originalQuaternion = worldQuat.clone();
            }

            restoreCustomScale(draggedObject, savedScale);
            // Không reset quaternion khi bắt đầu kéo; giữ rotation hiện tại của dụng cụ.

            // Chỉ tính offset nếu chưa có
            updateOffsetToFloor(draggedObject);
            if (isMovableTableDrag) {
                draggedObject.userData.dragStartFloorPosition = draggedObject.position.clone();
                draggedObject.userData.lastValidFloorPosition = draggedObject.position.clone();
                draggedObject.userData.placementInvalid = false;
            }

            orbit.enabled = false;

            // Không hiện thông báo khi kéo/thả. Thông báo chỉ nêu kết quả phản ứng.
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!draggedObject || fps.isLocked || toolRotateState.activeAxis) return;
        updateRaycaster(e);

        // 1. Giả định đang trên mặt bàn (y=1.6)
        if (isMovableTableObject(draggedObject)) {
            movePlane.set(new three.Vector3(0, 1, 0), 0);
            if (raycaster.ray.intersectPlane(movePlane, planeIntersectPoint)) {
                draggedObject.position.x = planeIntersectPoint.x;
                draggedObject.position.z = planeIntersectPoint.z;
                draggedObject.position.y = draggedObject.userData.offsetToFloor || 0;
                updateMovableTablePlacementState(draggedObject);
            }
            return;
        }

        const tableSurfaceHit = getTableSurfaceUnderRay(raycaster.ray, draggedObject);
        let targetY = tableSurfaceHit?.surfaceY ?? getTableSurfaceY();
        movePlane.set(new three.Vector3(0, 1, 0), -targetY);

        if (raycaster.ray.intersectPlane(movePlane, planeIntersectPoint)) {
            if (tableSurfaceHit) {
                planeIntersectPoint.copy(tableSurfaceHit.point);
            }
            // Kiểm tra xem vị trí chuột có nằm trong diện tích mặt bàn không (Bàn 8x4)
            const isOnTable = Boolean(tableSurfaceHit) || (Math.abs(planeIntersectPoint.x) <= 4 && Math.abs(planeIntersectPoint.z) <= 2);

            if (!isOnTable) {
                // Nếu không ở trên bàn, hạ xuống sàn (y=0)
                targetY = 0;
                movePlane.set(new three.Vector3(0, 1, 0), -targetY);
                raycaster.ray.intersectPlane(movePlane, planeIntersectPoint);
            }
        } else {
            // Trường hợp không cắt được mặt bàn (nhìn lên trời/ra xa), mặc định là sàn
            targetY = 0;
            movePlane.set(new three.Vector3(0, 1, 0), -targetY);
            raycaster.ray.intersectPlane(movePlane, planeIntersectPoint);
        }

        draggedObject.position.x = planeIntersectPoint.x;
        draggedObject.position.z = planeIntersectPoint.z;

        // Luôn đảm bảo cao độ chuẩn xác
        draggedObject.position.y = targetY + (draggedObject.userData.offsetToFloor || 0);
        window.labAssemblyManager?.updateMagneticDetachState?.(draggedObject);

        if (isAutoAssemblySnapEnabled()) {
            window.labAssemblyManager?.applySoftSnapPreview?.(draggedObject, draggableObjects, {
                maxDistance: 0.9,
                strength: 0.32
            });
        }
    });

    window.addEventListener('pointerup', (e) => {
        if (draggedObject) {
            updateRaycaster(e);

            if (isMovableTableObject(draggedObject)) {
                if (!isMovableTablePlacementValid(draggedObject)) {
                    const fallbackPosition =
                        draggedObject.userData.lastValidFloorPosition ||
                        draggedObject.userData.dragStartFloorPosition;
                    if (fallbackPosition?.isVector3) {
                        draggedObject.position.copy(fallbackPosition);
                        draggedObject.updateMatrixWorld(true);
                    }
                    notifyLab?.('Kh\u00f4ng th\u1ec3 \u0111\u1eb7t b\u00e0n \u0111\u00e8 l\u00ean v\u1eadt kh\u00e1c trong ph\u00f2ng.');
                } else {
                    draggedObject.userData.lastValidFloorPosition = draggedObject.position.clone();
                }
                draggedObject.userData.placementInvalid = false;
                updateOffsetToFloor(draggedObject);
                orbit.enabled = true;
                draggedObject = null;
                return;
            }

            const originalVisible = draggedObject.visible;
            draggedObject.visible = false;
            const dropIntersects = raycaster.intersectObjects(scene.children, true);
            draggedObject.visible = originalVisible;

            const returnedToCabinet = shouldReturnChemicalBottleToCabinet(draggedObject, dropIntersects, {
                allowNearHome: true
            }) && returnChemicalBottleToCabinetHome(draggedObject);

            if (!returnedToCabinet) {
                completeAssemblyDrop(draggedObject);
                resolvePlacementOverlapAfterLegacyLogic(draggedObject);
            }
            orbit.enabled = true;
            draggedObject = null;
        }
    });

    // Xử lý nút Phóng to / Thu nhỏ trong Context Menu
    const zoomInBtn = document.getElementById('zoom-in-btn');
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    const deleteToolBtn = document.getElementById('delete-tool-btn');
    const toggleHeatBtn = document.getElementById('toggle-heat-btn');
    const removeChemicalBtn = document.getElementById('removeChemicalBtn');

    if (zoomInBtn) {
        zoomInBtn.onclick = () => {
            if (selectedObjectForMenu) {
                selectedObjectForMenu.scale.multiplyScalar(1.2);
                if (pouringEffect) pouringEffect.invalidateCavity(selectedObjectForMenu);
                // Giới hạn scale tối đa
                const maxScale = (selectedObjectForMenu.userData.originalScale || 1.0) * 5.0;
                if (selectedObjectForMenu.scale.x > maxScale) {
                    selectedObjectForMenu.scale.set(maxScale, maxScale, maxScale);
                }
                rememberCustomScale(selectedObjectForMenu);
                updateOffsetToFloor(selectedObjectForMenu);
                persistToolScale(selectedObjectForMenu);
            }
            contextmenu.classList.add('hidden');
        };
    }

    if (zoomOutBtn) {
        zoomOutBtn.onclick = () => {
            if (selectedObjectForMenu) {
                selectedObjectForMenu.scale.multiplyScalar(0.8);
                if (pouringEffect) pouringEffect.invalidateCavity(selectedObjectForMenu);
                // Giới hạn scale tối thiểu
                const minScale = (selectedObjectForMenu.userData.originalScale || 1.0) * 0.2;
                if (selectedObjectForMenu.scale.x < minScale) {
                    selectedObjectForMenu.scale.set(minScale, minScale, minScale);
                }
                rememberCustomScale(selectedObjectForMenu);
                updateOffsetToFloor(selectedObjectForMenu);
                persistToolScale(selectedObjectForMenu);
            }
            contextmenu.classList.add('hidden');
        };
    }

    if (removeChemicalBtn) {
        removeChemicalBtn.onclick = () => {
            const tool = selectedObjectForMenu;
            contextmenu.classList.add('hidden');

            if (!tool || !toolHasChemical(tool)) return;

            removeChemicalFromTool(tool, scene);
            removeChemicalBtn.classList.add('hidden');
            notifyLab?.('Đã xóa chất hóa học bên trong dụng cụ.');
        };
    }

    if (deleteToolBtn) {
        deleteToolBtn.onclick = async () => {
            const objectToDelete = selectedObjectForMenu;
            contextmenu.classList.add('hidden');

            if (!objectToDelete) return;
            if (isMovableTableObject(objectToDelete)) {
                removeToolFromCurrentLab(objectToDelete, scene);
                notifyLab?.('\u0110\u00e3 x\u00f3a b\u00e0n kh\u1ecfi ph\u00f2ng.');
                return;
            }

            deleteToolBtn.disabled = true;
            try {
                await persistToolSoftDelete(objectToDelete);
                removeToolFromCurrentLab(objectToDelete, scene);
                notifyLab?.('Đã xóa dụng cụ khỏi bàn thí nghiệm.');
            } catch (error) {
                console.error('[ToolDelete] soft delete failed:', error);
                notifyLab?.(error?.message || 'Không thể xóa dụng cụ.');
            } finally {
                deleteToolBtn.disabled = false;
            }
        };
    }

    if (toggleHeatBtn) {
        toggleHeatBtn.onclick = () => {
            if (selectedObjectForMenu) {
                toggleHeatingForObject(selectedObjectForMenu);
            }
            contextmenu.classList.add('hidden');
        };
    }

    // Ẩn menu khi click ra ngoài
    window.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) {
            contextmenu.classList.add('hidden');
            removeChemicalBtn?.classList.add('hidden');
        }
    });

    window.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (fps.isLocked) return;
        updateRaycaster(e);
        const candidates = getInteractionCandidates();
        const intersects = raycaster.intersectObjects(candidates, true);

        if (intersects.length > 0) {
            selectedObjectForMenu = findRootTool(intersects[0].object) || resolveDraggableRoot(intersects[0].object);
            if (!selectedObjectForMenu) {
                contextmenu.classList.add('hidden');
                removeChemicalBtn?.classList.add('hidden');
                return;
            }
            if (toggleHeatBtn) {
                toggleHeatBtn.classList.toggle('hidden', !canToggleHeatingSource(selectedObjectForMenu));
            }
            removeChemicalBtn?.classList.toggle('hidden', !toolHasChemical(selectedObjectForMenu));
            contextmenu.style.top = `${e.clientY}px`;
            contextmenu.style.left = `${e.clientX}px`;
            contextmenu.classList.remove('hidden');
        } else {
            contextmenu.classList.add('hidden');
            removeChemicalBtn?.classList.add('hidden');
        }
    });
}

// Cập nhật hoạt ảnh đung đưa của 2 tay (Walking bobbing) và Inspect
const lerpSpeed = 0.1; // Tốc độ chuyển đổi giữa các trạng thái
export function updateArmsAnimation(time, isMoving) {
    const speed = isMoving ? 10 : 1.5;
    const amplitude = isMoving ? 0.05 : 0.005;

    const bob = Math.sin(time * speed) * amplitude;
    const sway = Math.cos(time * speed * 0.5) * amplitude * 0.5;

    // --- LOGIC DI CHUYỂN TAY KHI ĐỔ (POURING ANIMATION) ---
    const isPouringHandToHand = isPouringAction && heldObjectRight && heldObjectLeft;

    // --- TAY TRÁI ---
    let targetPosLeft = new three.Vector3(-0.45 + sway, -0.5 + bob, -0.2);
    let targetRotLeft = new three.Euler(0, 0, sway * 0.5);

    if (isInspectingLeft && heldObjectLeft) {
        targetPosLeft.set(-0.15, -0.2, -0.45);
        targetRotLeft.set(0.2, 0.4, 0);
    } else if (isPouringHandToHand) {
        const isSource = heldObjectLeft === activePourSource;
        const isTarget = heldObjectLeft.userData.toolData && heldObjectLeft !== activePourSource;

        if (isSource) {
            // Tay trái cầm chai -> giữ bên trái
            targetPosLeft.set(-0.18, -0.32, -0.55);
            targetRotLeft.set(1.0, 0.35, 0.08);
        } else if (isTarget) {
            // Tay trái cầm cốc -> cũng giữ bên trái
            targetPosLeft.set(-0.08, -0.45, -0.72);
            targetRotLeft.set(0.05, 0.02, 0);
        }
    }

    leftArm.position.lerp(targetPosLeft, lerpSpeed);
    leftArm.rotation.x = three.MathUtils.lerp(leftArm.rotation.x, targetRotLeft.x, lerpSpeed);
    leftArm.rotation.y = three.MathUtils.lerp(leftArm.rotation.y, targetRotLeft.y, lerpSpeed);
    leftArm.rotation.z = three.MathUtils.lerp(leftArm.rotation.z, targetRotLeft.z, lerpSpeed);

    animateFingers(leftArm, !!heldObjectLeft);

    // --- TAY PHẢI ---
    let targetPosRight = new three.Vector3(0.45 - sway, -0.5 + bob, -0.2);
    let targetRotRight = new three.Euler(0, 0, -sway * 0.5);

    if (isInspectingRight && heldObjectRight) {
        targetPosRight.set(0.15, -0.2, -0.45);
        targetRotRight.set(0.2, -0.4, 0);
    } else if (isPouringHandToHand) {
        const isSource = heldObjectRight === activePourSource;
        const isTarget = heldObjectRight.userData.toolData && heldObjectRight !== activePourSource;

        if (isSource) {
            // Tay phải cầm chai -> giữ bên phải
            targetPosRight.set(0.18, -0.32, -0.55);
            targetRotRight.set(1.0, -0.35, -0.08);
        } else if (isTarget) {
            // Tay phải cầm cốc -> vẫn bên phải
            targetPosRight.set(0.08, -0.45, -0.72);
            targetRotRight.set(0.05, -0.02, 0);
        }
    }

    rightArm.position.lerp(targetPosRight, lerpSpeed);
    rightArm.rotation.x = three.MathUtils.lerp(rightArm.rotation.x, targetRotRight.x, lerpSpeed);
    rightArm.rotation.y = three.MathUtils.lerp(rightArm.rotation.y, targetRotRight.y, lerpSpeed);
    rightArm.rotation.z = three.MathUtils.lerp(rightArm.rotation.z, targetRotRight.z, lerpSpeed);

    // --- FORCE BOTTLE TILT DURING POURING ---
    const hands = [
        { held: heldObjectRight, isRight: true },
        { held: heldObjectLeft, isRight: false }
    ];

    hands.forEach(h => {
        if (h.held) {
            const isSource = h.held === activePourSource;

            if (isPouringAction && isSource) {
                // Chỉ bắt đầu nghiêng lọ khi tay đã đưa vào đủ gần vị trí trung tâm
                const distToTarget = h.isRight ? rightArm.position.distanceTo(targetPosRight) : leftArm.position.distanceTo(targetPosLeft);

                if (distToTarget < 0.12) {
                    // Nghiêng lọ vừa phải (~110 độ) để không quét quá mạnh
                    h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, Math.PI * 0.62, 0.12);
                    h.held.rotation.z = three.MathUtils.lerp(h.held.rotation.z, h.isRight ? -0.25 : 0.25, 0.1);
                }
                h.held.position.lerp(new three.Vector3(0, -0.02, -0.04), 0.1);
            } else if (isPouringAction && !isSource) {
                // ĐỐI VỚI DỤNG CỤ HỨNG: chỉ tự dựng thẳng nếu người dùng chưa xoay thủ công.
                if (!h.held.userData?.keepManualRotation) {
                    h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, 0, 0.25);
                    h.held.rotation.y = three.MathUtils.lerp(h.held.rotation.y, 0, 0.25);
                    h.held.rotation.z = three.MathUtils.lerp(h.held.rotation.z, 0, 0.25);
                }
                h.held.position.lerp(new three.Vector3(0, -0.02, -0.04), 0.1);
            } else {
                h.held.position.lerp(new three.Vector3(0, 0.1, 0), 0.1);
                if (!h.held.userData?.keepManualRotation) {
                    h.held.rotation.x = three.MathUtils.lerp(h.held.rotation.x, 0, 0.2);
                }
            }
        }
    });

    animateFingers(rightArm, !!heldObjectRight);
}

function animateFingers(arm, isGripping) {
    const targetGrip = isGripping ? 1 : 0;
    if (arm.userData.currentGrip === undefined) arm.userData.currentGrip = 0;
    arm.userData.currentGrip = three.MathUtils.lerp(arm.userData.currentGrip, targetGrip, 0.1);

    const grip = arm.userData.currentGrip;

    arm.traverse(node => {
        if (node.name === "seg1") {
            // Relaxed: -0.2, Gripped: -1.2
            node.rotation.x = three.MathUtils.lerp(-0.2, -1.2, grip);
        }
        if (node.name === "seg2") {
            // Relaxed: -0.1, Gripped: -1.0
            node.rotation.x = three.MathUtils.lerp(-0.1, -1.0, grip);
        }
        if (node.name === "finger_thumb") {
            // Ngón cái xoay đặc biệt hơn
            const seg1 = node.getObjectByName("seg1");
            if (seg1) seg1.rotation.x = three.MathUtils.lerp(-0.1, -0.8, grip);
        }
    });
}

export function setArmsVisibility(visible) {
    playerArmGroups.forEach(group => {
        group.visible = true;
        group.traverse(node => {
            if (node.userData?.isPlayerArmVisual) node.visible = visible;
        });
    });
}


function ensureLocalEffectGroup(container, name = 'local_reaction_effects') {
    if (!container) return null;
    let group = container.userData[name];
    if (!group) {
        group = new three.Group();
        group.name = name;
        container.add(group);
        container.userData[name] = group;
    }
    return group;
}

function getCavityLocalInfo(container) {
    const rawPoints = (container?.userData?.cavityPoints || []).filter(p =>
        Number.isFinite(p?.lx) &&
        Number.isFinite(p?.lz) &&
        Number.isFinite(p?.lyTop) &&
        Number.isFinite(p?.lyBottom) &&
        p.lyTop > p.lyBottom
    );
    const points = container?.userData?.cavitySource === 'csg_scaled_model' || container?.userData?.cavityCSG
        ? selectDominantCavityPoints(rawPoints)
        : rawPoints;
    const toolLocalBox = getToolLocalMeshBox(container);
    const toolCenter = toolLocalBox?.getCenter?.(new three.Vector3());

    if (points.length > 0) {
        const box = new three.Box3();
        let minY = Infinity;
        let maxY = -Infinity;
        points.forEach(p => {
            if (!isFinite(p.lx) || !isFinite(p.lz)) return;
            box.expandByPoint(new three.Vector3(p.lx, 0, p.lz));
            minY = Math.min(minY, p.lyBottom);
            maxY = Math.max(maxY, p.lyTop);
        });
        if (isFinite(minY) && isFinite(maxY) && !box.isEmpty()) {
            const center = box.getCenter(new three.Vector3());
            return {
                centerX: center.x,
                centerZ: center.z,
                radiusX: Math.max((box.max.x - box.min.x) * 0.28, 0.035),
                radiusZ: Math.max((box.max.z - box.min.z) * 0.28, 0.035),
                bottomY: minY + 0.015,
                surfaceY: three.MathUtils.lerp(minY, maxY, Math.min(container.userData.liquidLevel || 0.2, 0.85))
            };
        }
    }

    // Fallback an toàn cho model chưa detect được cavity.
    const localCenter = toolCenter || new three.Vector3();
    if (!toolCenter) {
        const localBox = new three.Box3().setFromObject(container);
        const inv = container.matrixWorld.clone().invert();
        localBox.getCenter(localCenter);
        localCenter.applyMatrix4(inv);
    }
    return {
        centerX: localCenter.x,
        centerZ: localCenter.z,
        radiusX: 0.08,
        radiusZ: 0.08,
        bottomY: localCenter.y - 0.08,
        surfaceY: localCenter.y
    };
}

function createPowderDeposit(container, color) {
    if (!container) return;

    const group = ensureLocalEffectGroup(container, 'powderDeposit');
    if (!group) return;

    const info = getCavityLocalInfo(container);
    const geo = new three.BufferGeometry();
    const points = [];
    const amount = 180;

    for (let i = 0; i < amount; i++) {
        const r = Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        points.push(
            (info.centerX || 0) + Math.cos(a) * r * info.radiusX,
            info.bottomY + Math.random() * 0.045,
            (info.centerZ || 0) + Math.sin(a) * r * info.radiusZ
        );
    }

    geo.setAttribute('position', new three.Float32BufferAttribute(points, 3));

    const mat = new three.PointsMaterial({
        color: color || '#dddddd',
        size: 0.012,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: true
    });

    const powder = new three.Points(geo, mat);
    powder.name = 'solid_powder_inside_container';
    powder.userData.ignoreInteraction = true;
    powder.userData.isInternalChemicalVisual = true;
    powder.userData.container = container;
    group.userData.ignoreInteraction = true;
    group.userData.isInternalChemicalVisual = true;
    group.add(powder);
}

function createPrecipitate(container, color) {
    if (!container) return;

    // Kết tủa phải nằm trong local-space của dụng cụ.
    // Lỗi cũ: material depthTest=false + renderOrder quá cao làm hạt bị vẽ đè lên thành cốc,
    // nhìn như kết tủa nằm ngoài dụng cụ. Ở đây dùng depthTest=true để thành dụng cụ che đúng.
    const group = ensureLocalEffectGroup(container, 'precipitateLayer');
    if (!group) return;
    markInternalEffect(group, container);

    const info = getCavityLocalInfo(container);
    const geo = new THREE.BufferGeometry();
    const points = [];
    const amount = 720;

    // Giữ hạt nằm gọn hơn trong lòng dụng cụ, tránh chạm/thò ra thành cốc.
    const safeRadiusX = Math.max(0.018, info.radiusX * 0.58);
    const safeRadiusZ = Math.max(0.018, info.radiusZ * 0.58);
    const bottomY = info.bottomY + 0.018;
    const topY = Math.max(bottomY + 0.035, Math.min(info.surfaceY - 0.012, info.bottomY + 0.16));

    for (let i = 0; i < amount; i++) {
        const r = Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;

        // Nhiều hạt lắng ở đáy, một phần lơ lửng trong dung dịch.
        const settleBias = Math.random() * Math.random();
        const yBand = three.MathUtils.lerp(topY, bottomY, settleBias);

        points.push(
            (info.centerX || 0) + Math.cos(a) * r * safeRadiusX,
            yBand,
            (info.centerZ || 0) + Math.sin(a) * r * safeRadiusZ
        );
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    const mat = new THREE.PointsMaterial({
        color: color || '#ffffff',
        size: 0.014,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.98,
        depthWrite: true,
        depthTest: true
    });

    const precipitate = new THREE.Points(geo, mat);
    precipitate.name = 'precipitate_inside_container';
    markInternalEffect(precipitate, container);

    // Không renderOrder cực cao nữa, để depth buffer giữ đúng vị trí trong lòng dụng cụ.
    precipitate.renderOrder = 12;
    group.renderOrder = 12;
    group.add(precipitate);
}
