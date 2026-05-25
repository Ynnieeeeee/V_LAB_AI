import * as THREE from 'three';
import { markContainerHeated } from './ExperimentSessionManager.js';

const ROOM_TEMPERATURE = 25;
const DEFAULT_TABLE_Y = 0;

function getTableSurfaceY() {
    const explicitTableY = Number(window.TABLE_Y ?? window.tableY);
    if (Number.isFinite(explicitTableY)) return explicitTableY;

    const tableObject = window.tableObject || window.labTable || window.tableMesh;
    if (tableObject?.isObject3D) {
        tableObject.updateMatrixWorld?.(true);
        const tableBox = new THREE.Box3().setFromObject(tableObject);
        if (Number.isFinite(tableBox.max.y)) return tableBox.max.y;
    }

    return DEFAULT_TABLE_Y;
}

function clampObjectAboveTable(object, tableY = DEFAULT_TABLE_Y) {
    if (!object?.isObject3D) return;
    object.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(object);
    const minY = box.min.y;

    if (Number.isFinite(minY) && minY < tableY) {
        object.position.y += tableY - minY;
        object.updateMatrixWorld?.(true);
    }
}


function getCenter(object) {
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    box.getCenter(center);
    return center;
}

function getBoxCenterAndSize(object) {
    object?.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    return { box, center, size };
}

function isToggleableHeatingSource(source) {
    return Boolean(source?.userData?.isHeatingSource === true && source.userData.isToggleable === true);
}

function isActiveHeatingSource(source) {
    return Boolean(isToggleableHeatingSource(source) && source.userData.isOn === true);
}

function isHeatTarget(target) {
    return target?.userData?.toolType === 'container';
}

function normalizedToolText(object) {
    return [
        object?.userData?.toolType,
        object?.userData?.toolData?.name_tool_vi,
        object?.userData?.toolData?.name_tool_en,
        object?.userData?.name_vi,
        object?.userData?.name_en,
        object?.name
    ].filter(Boolean).join(' ')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd');
}

function toolName(object) {
    return object?.name ||
        object?.userData?.toolData?.name_tool_vi ||
        object?.userData?.toolData?.name_tool_en ||
        object?.userData?.name_vi ||
        object?.userData?.name ||
        'tool';
}

function ensureContainerState(container) {
    if (!container?.userData) return;
    container.userData.currentTemperature ??= ROOM_TEMPERATURE;
    container.userData.temperature ??= container.userData.currentTemperature;
    container.userData.isHeating ??= false;
    container.userData.heatingSource ??= null;
    container.userData.isOnHeatingSource ??= false;
    container.userData.isSnappedToHeatingSource ??= false;
    container.userData.isOnSupportStand ??= false;
    container.userData.supportStand ??= null;
    container.userData.isSnappedToSupport ??= false;
    container.userData.pendingReaction ??= null;
    container.userData.pendingReason ??= null;
}

function ensureSourceState(source) {
    if (!source?.userData) return;
    source.userData.isOn = Boolean(source.userData.isOn);
    source.userData.heatingPower = Number(source.userData.heatingPower ?? 8) || 8;
    source.userData.maxTemperature = Number(source.userData.maxTemperature ?? 120) || 120;
}

function isSupportStand(support) {
    return Boolean(support?.userData?.toolType === 'support_stand' || support?.userData?.isSupportStand === true);
}

function canSupportTools(support) {
    return Boolean(isSupportStand(support) && support.userData.canSupportTools !== false);
}

function ensureSupportState(support) {
    if (!support?.userData) return;
    support.userData.toolType = 'support_stand';
    support.userData.isSupportStand = true;
    support.userData.canSupportTools = support.userData.canSupportTools !== false;
    support.userData.isHeatingSource = false;
    support.userData.heatingPower = 0;
    support.userData.maxTemperature = 25;
    support.userData.isToggleable = false;
    support.userData.isOn = false;
    support.userData.supportHeight = Number(support.userData.supportHeight ?? 0.8) || 0.8;
    support.userData.supportRadius = Number(support.userData.supportRadius ?? 1.0) || 1.0;
    support.userData.heatingSourceOffsetY = Number(support.userData.heatingSourceOffsetY ?? -0.4) || -0.4;
}

function getAnchorWorldOffset(source) {
    const text = normalizedToolText(source);
    if (/(hot plate|heating plate|heater|bep|bep dien|bep gia nhiet|bep dun)/.test(text)) return 0.15;
    if (/(alcohol lamp|spirit lamp|burner|bunsen|den con|den dot|mo dot)/.test(text)) return 0.5;
    return 0.4;
}

function ensureSupportAnchor(support) {
    if (!canSupportTools(support)) return null;
    ensureSupportState(support);
    let anchor = support.userData.supportAnchor;
    if (!anchor) {
        anchor = new THREE.Object3D();
        anchor.name = 'support_anchor';
        anchor.userData.ignoreInteraction = true;
        anchor.userData.notDraggable = true;
        support.add(anchor);
        support.userData.supportAnchor = anchor;
        console.log('[SupportStand] support detected:', toolName(support));
    }

    // FIX mạnh: không lấy pivot làm tâm. Anchor X/Z luôn lấy từ tâm world bounding box của giá đỡ.
    // Y ưu tiên metadata supportHeight để giữ đúng mặt đỡ ảo cho kiềng/ring stand.
    support.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(support);
    const centerWorld = new THREE.Vector3();
    box.getCenter(centerWorld);

    const supportWorldPos = new THREE.Vector3();
    support.getWorldPosition?.(supportWorldPos);
    const anchorWorld = new THREE.Vector3(
        centerWorld.x,
        supportWorldPos.y + Number(support.userData.supportHeight ?? 0.8),
        centerWorld.z
    );

    if (!Number.isFinite(anchorWorld.y)) {
        anchorWorld.y = box.max.y + Number(support.userData.supportYOffset ?? 0);
    }

    const anchorLocal = support.worldToLocal(anchorWorld.clone());
    anchor.position.copy(anchorLocal);

    console.log('[SupportAnchor] created from bbox center:', anchorWorld);
    return anchor;
}

function ensureHeatingAnchor(source) {
    if (!source?.userData?.isHeatingSource) return null;
    let anchor = source.userData.heatingAnchor;
    if (!anchor) {
        anchor = new THREE.Object3D();
        anchor.name = 'heating_anchor';
        anchor.userData.ignoreInteraction = true;
        anchor.userData.notDraggable = true;
        source.add(anchor);
        source.userData.heatingAnchor = anchor;
    }

    const worldScale = new THREE.Vector3(1, 1, 1);
    source.getWorldScale?.(worldScale);
    const scaleY = Math.abs(worldScale.y) || 1;
    anchor.position.set(0, getAnchorWorldOffset(source) / scaleY, 0);
    return anchor;
}

function ensureSourceVisual(source) {
    if (!source?.userData || source.userData.heatingVisualGroup) return source?.userData?.heatingVisualGroup || null;

    const group = new THREE.Group();
    group.name = 'heating_source_visual';
    group.visible = false;
    group.userData.ignoreInteraction = true;
    group.userData.notDraggable = true;
    group.userData.isReactionEffect = true;

    const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.06, 0.18, 18),
        new THREE.MeshBasicMaterial({
            color: 0xff9f1c,
            transparent: true,
            opacity: 0.82
        })
    );
    flame.name = 'heating_flame';
    flame.position.set(0, 0.16, 0);
    flame.userData.ignoreInteraction = true;
    group.add(flame);

    const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 20, 12),
        new THREE.MeshBasicMaterial({
            color: 0xff3b1f,
            transparent: true,
            opacity: 0.28
        })
    );
    glow.name = 'heating_glow';
    glow.position.set(0, 0.09, 0);
    glow.userData.ignoreInteraction = true;
    group.add(glow);

    const light = new THREE.PointLight(0xff8a2a, 0, 1.7, 2);
    light.name = 'heating_light';
    light.position.set(0, 0.22, 0);
    light.userData.ignoreInteraction = true;
    group.add(light);

    source.add(group);
    source.userData.heatingVisualGroup = group;
    source.userData.heatingLight = light;
    ensureHeatingAnchor(source);
    return group;
}

function getAnchorWorldPosition(source) {
    const anchor = ensureHeatingAnchor(source);
    if (!anchor) return null;
    const worldPos = new THREE.Vector3();
    anchor.getWorldPosition(worldPos);
    return worldPos;
}

function getSupportAnchorWorldPosition(support) {
    const anchor = ensureSupportAnchor(support);
    if (!anchor) return null;
    const worldPos = new THREE.Vector3();
    anchor.getWorldPosition(worldPos);
    return worldPos;
}

function getSavedScale(object) {
    if (!object?.scale) return new THREE.Vector3(1, 1, 1);
    return object.userData?.customScale?.clone?.() || object.scale.clone();
}

function rememberScale(object, scale = null) {
    if (!object?.userData || !object?.scale) return;
    const saved = scale?.clone?.() || object.scale.clone();
    object.userData.customScale = saved;
    object.userData.hasCustomScale = true;
    console.log('[Scale] saved customScale:', saved);
}

function restoreScale(object, scale = null) {
    if (!object?.scale) return;
    const saved = scale?.clone?.() || object.userData?.customScale?.clone?.();
    if (saved) object.scale.copy(saved);
}

function setObjectWorldPosition(object, worldPosition) {
    const savedScale = getSavedScale(object);
    console.log('[Scale] before move:', object.scale);
    const localPosition = worldPosition.clone();
    object.parent?.worldToLocal(localPosition);
    object.position.copy(localPosition);
    restoreScale(object, savedScale);
    rememberScale(object, savedScale);
    object.updateMatrixWorld(true);
    console.log('[Scale] after move:', object.scale);
}

function getWorldPosition(object) {
    const position = new THREE.Vector3();
    object?.getWorldPosition?.(position);
    return position;
}

function sourceDistance(container, source) {
    const anchorPos = getAnchorWorldPosition(source);
    if (!anchorPos) return Infinity;
    const rootPos = new THREE.Vector3();
    container.getWorldPosition(rootPos);
    const containerCenter = getCenter(container);
    return Math.min(rootPos.distanceTo(anchorPos), containerCenter.distanceTo(anchorPos));
}

function supportDistance(container, support) {
    if (!canSupportTools(support)) return Infinity;
    const supportPos = new THREE.Vector3();
    support.getWorldPosition(supportPos);
    const rootPos = new THREE.Vector3();
    container.getWorldPosition(rootPos);
    return rootPos.distanceTo(supportPos);
}

function objectDistanceToSupport(object, support) {
    if (!object || !canSupportTools(support)) return Infinity;
    return getWorldPosition(object).distanceTo(getWorldPosition(support));
}

function worldDistance(a, b) {
    if (!a || !b) return Infinity;
    const aPos = new THREE.Vector3();
    const bPos = new THREE.Vector3();
    a.getWorldPosition(aPos);
    b.getWorldPosition(bPos);
    return aPos.distanceTo(bPos);
}

function alignObjectBottomToY(object, targetY, clearance = 0) {
    if (!object?.isObject3D) return;
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const deltaY = targetY + clearance - box.min.y;
    object.position.y += deltaY;
    object.updateMatrixWorld(true);
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

function getActiveSupportedTools(support, currentContainer = null) {
    if (!support?.userData) return currentContainer ? [currentContainer] : [];

    support.userData.supportedTools ??= [];
    support.userData.supportedTools = support.userData.supportedTools.filter(tool =>
        tool?.parent &&
        tool.userData?.isOnSupportStand === true &&
        tool.userData?.supportStand === support
    );

    if (currentContainer?.isObject3D && !support.userData.supportedTools.includes(currentContainer)) {
        support.userData.supportedTools.push(currentContainer);
    }

    return support.userData.supportedTools;
}

function getSupportSlotPositionIfNeeded(container, support, anchorWorldPos) {
    if (!container?.isObject3D || !support?.userData || !anchorWorldPos) return anchorWorldPos?.clone?.() || null;

    const tools = getActiveSupportedTools(support, container);
    const count = tools.length;
    const index = tools.indexOf(container);

    // Chỉ có 1 dụng cụ thì tuyệt đối giữ đúng tâm support anchor, không slot, không offset.
    if (count <= 1 || index < 0) {
        console.log('[SupportSnap] supported count:', count);
        return anchorWorldPos.clone();
    }

    const spacing = Number(support.userData.supportSlotSpacing ?? 0.28) || 0.28;
    console.log('[SupportSlot] support:', toolName(support), 'tool index:', index);
    console.log('[SupportSnap] supported count:', count);

    return anchorWorldPos.clone().add(new THREE.Vector3(
        (index - (count - 1) / 2) * spacing,
        0,
        0
    ));
}

function setContainerBottomNearAnchor(container, anchorWorldPos, clearance = null, support = null) {
    const savedScale = container.userData?.customScale?.clone?.() || container.scale.clone();
    const slotWorldPos = support
        ? getSupportSlotPositionIfNeeded(container, support, anchorWorldPos)
        : anchorWorldPos.clone();

    // Logic cũ vẫn đặt pivot trước, sau đó FIX mạnh bằng bbox center X/Z.
    setObjectWorldPosition(container, slotWorldPos);
    centerObjectXZToWorldPoint(container, slotWorldPos);
    alignObjectBottomToY(container, slotWorldPos.y, clearance ?? 0.01);
    centerObjectXZToWorldPoint(container, slotWorldPos);

    container.scale.copy(savedScale);
    container.updateMatrixWorld(true);
}

export function releaseContainerFromHeatingSource(container) {
    if (!container?.userData) return;
    container.userData.isOnHeatingSource = false;
    container.userData.isSnappedToHeatingSource = false;
    container.userData.isHeating = false;
    container.userData.heatingSource = null;
}

export function releaseContainerFromSupportStand(container) {
    if (!container?.userData) return;
    const support = container.userData.supportStand;
    if (support?.userData?.supportedTools) {
        support.userData.supportedTools = support.userData.supportedTools.filter(tool => tool && tool !== container && tool.parent);
    }
    container.userData.isOnSupportStand = false;
    container.userData.isSnappedToSupport = false;
    container.userData.supportStand = null;
}

export function releaseHeatingSourceFromSupportStand(source) {
    if (!source?.userData) return;
    source.userData.isUnderSupportStand = false;
    source.userData.supportStand = null;
}

export function snapContainerToHeatingSource(container, source) {
    // NEW HEATING RULE:
    // Không tự snap/căn vị trí container vào nguồn nhiệt nữa.
    // Nguồn nhiệt chỉ được xét theo vị trí thực tế bên dưới container trong HeatingManager.update().
    if (container?.userData) releaseContainerFromHeatingSource(container);
    console.log('[HeatingSnap] disabled auto snap container to heating source:', toolName(container), 'source:', toolName(source));
    return false;
}

export function snapContainerToSupportStand(container, support) {
    if (!isHeatTarget(container) || !canSupportTools(support)) return false;
    const anchorWorldPos = getSupportAnchorWorldPosition(support);
    if (!anchorWorldPos) return false;

    releaseContainerFromHeatingSource(container);

    // Gắn trạng thái support TRƯỚC khi tính slot để danh sách supportedTools lọc đúng.
    container.userData.isOnSupportStand = true;
    container.userData.supportStand = support;
    container.userData.isSnappedToSupport = true;
    container.userData.isHeating = false;
    container.userData.lockRotation = true;

    setContainerBottomNearAnchor(container, anchorWorldPos, 0.01, support);

    if (container.userData.originalQuaternion) {
        container.quaternion.copy(container.userData.originalQuaternion);
        container.updateMatrixWorld(true);

        // Rotation reset có thể làm bbox center lệch lại nếu pivot/model không chuẩn.
        // Vì vậy bắt buộc căn tâm bbox X/Z thêm một lần SAU khi restore quaternion.
        setContainerBottomNearAnchor(container, anchorWorldPos, 0.01, support);
    }

    // Ép lần cuối sau toàn bộ logic snap cũ để không còn đoạn nào ghi đè vị trí tâm.
    setContainerBottomNearAnchor(container, anchorWorldPos, 0.01, support);

    console.log('[SupportSnap] support:', toolName(support));
    console.log('[SupportSnap] anchor world:', anchorWorldPos);
    console.log('[SupportSnap] final container position:', container.position);
    console.log('[SupportSnap] bottom aligned:', toolName(container));
    console.log('[SupportStand] snapped container:', toolName(container), 'to support:', toolName(support));
    console.log('[SupportStand] container snapped:', toolName(container));
    return true;
}

export function findNearestSupportStand(container, objects = [], maxDistance = 1.0) {
    if (!isHeatTarget(container)) return null;
    return findNearestSupportStandForObject(container, objects, maxDistance);
}

export function findNearestSupportStandForObject(object, objects = [], maxDistance = 1.0) {
    if (!object) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const candidate of objects) {
        if (!candidate || candidate === object || !canSupportTools(candidate)) continue;
        ensureSupportAnchor(candidate);
        const radius = Math.min(maxDistance, Number(candidate.userData.supportRadius ?? 1.0) || 1.0);
        const distance = objectDistanceToSupport(object, candidate);
        if (distance <= radius && distance < nearestDistance) {
            nearest = candidate;
            nearestDistance = distance;
        }
    }
    return nearest;
}

export function autoSnapContainerToNearestSupportStand(container, objects = [], options = {}) {
    const maxDistance = Number(options.maxDistance ?? 1.0);
    const support = findNearestSupportStand(container, objects, maxDistance);
    if (!support) {
        releaseContainerFromSupportStand(container);
        return false;
    }
    return snapContainerToSupportStand(container, support);
}

export function placeHeatingSourceUnderSupport(source, support) {
    // NEW HEATING RULE:
    // Không tự động di chuyển/snap nguồn nhiệt xuống dưới giá đỡ.
    // Người dùng đặt nguồn nhiệt ở đâu thì giữ nguyên ở đó.
    if (source?.userData) releaseHeatingSourceFromSupportStand(source);
    console.log('[SupportStand] disabled auto place heating source under support:', toolName(source), 'support:', toolName(support));
    return false;
}

export function tryPlaceHeatingSourceUnderSupport(source, objects = [], options = {}) {
    // NEW HEATING RULE: không tự snap nguồn nhiệt vào giá đỡ.
    if (source?.userData) releaseHeatingSourceFromSupportStand(source);
    return false;
}

export function findNearestHeatingSource(container, objects = [], maxDistance = 1.0) {
    if (!isHeatTarget(container)) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const object of objects) {
        if (!object || object === container || object.userData?.isHeatingSource !== true) continue;
        ensureHeatingAnchor(object);
        const distance = sourceDistance(container, object);
        if (distance < maxDistance && distance < nearestDistance) {
            nearest = object;
            nearestDistance = distance;
        }
    }
    return nearest;
}

export function autoSnapContainerToNearestHeatingSource(container, objects = [], options = {}) {
    // NEW HEATING RULE: không tự snap/căn container lên nguồn nhiệt.
    // HeatingManager chỉ kiểm tra nguồn nhiệt thật sự đang bật và nằm bên dưới container.
    if (container?.userData) releaseContainerFromHeatingSource(container);
    return false;
}

function notifyPendingReaction(container) {
    const manager = window.ReactionManager || window.reactionManager;
    if (manager?.tryTriggerPendingReaction) {
        manager.tryTriggerPendingReaction(container);
        return;
    }
    window.tryTriggerPendingReaction?.(container);
}

export class HeatingManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.getObjects = options.getObjects || (() => []);
        this.heatingSources = [];
        this.containers = [];
        this.supportStands = [];
        this.heatingRadius = Number(options.heatingRadius || 1.2);
        this.minTemperature = Number(options.minTemperature || ROOM_TEMPERATURE);
        this.coolingPower = Number(options.coolingPower || 1);
        this.lastDebugAt = 0;
        this.lastSupportDebugAt = 0;
    }

    setObjectsProvider(getObjects) {
        this.getObjects = getObjects || (() => []);
    }

    registerObject(object) {
        if (!object?.userData) return;
        if (canSupportTools(object)) {
            ensureSupportState(object);
            ensureSupportAnchor(object);
            if (!this.supportStands.includes(object)) this.supportStands.push(object);
            this.heatingSources = this.heatingSources.filter(source => source !== object);
            return;
        }
        if (object.userData.isHeatingSource) {
            ensureSourceState(object);
            ensureHeatingAnchor(object);
            ensureSourceVisual(object);
            if (!this.heatingSources.includes(object)) this.heatingSources.push(object);
        }
        if (object.userData.toolType === 'container') {
            ensureContainerState(object);
            if (!this.containers.includes(object)) this.containers.push(object);
        }
    }

    syncRegisteredObjects() {
        for (const object of this.getObjects().filter(Boolean)) {
            this.registerObject(object);
        }
        this.heatingSources = this.heatingSources.filter(source => source?.parent);
        this.containers = this.containers.filter(container => container?.parent);
        this.supportStands = this.supportStands.filter(support => support?.parent);
    }

    static setSourceVisual(source, isOn) {
        const visual = ensureSourceVisual(source);
        if (!visual) return;
        visual.visible = Boolean(isOn);
        if (source.userData.heatingLight) source.userData.heatingLight.intensity = isOn ? 1.35 : 0;
        source.traverse?.(child => {
            const material = child.material;
            if (!material || child.userData?.isReactionEffect) return;
            if (material.emissive) {
                if (!child.userData.originalEmissive) child.userData.originalEmissive = material.emissive.clone();
                if (child.userData.originalEmissiveIntensity === undefined) {
                    child.userData.originalEmissiveIntensity = material.emissiveIntensity || 0;
                }
                material.emissive.set(isOn ? 0x4f1208 : child.userData.originalEmissive);
                material.emissiveIntensity = isOn
                    ? Math.max(material.emissiveIntensity || 0, 0.45)
                    : child.userData.originalEmissiveIntensity;
            }
        });
    }

    setSourceVisual(source, isOn) {
        HeatingManager.setSourceVisual(source, isOn);
    }

    update(deltaTime = 1 / 60) {
        this.syncRegisteredObjects();
        for (const container of this.containers) {
            this.updateContainerTemperature(container, deltaTime);
        }
    }

    updateContainerTemperature(container, deltaTime) {
        ensureContainerState(container);
        const current = Number(container.userData.currentTemperature ?? this.minTemperature);

        let supportStand = container.userData.isOnSupportStand ? container.userData.supportStand : null;
        if (supportStand && (!supportStand.parent || !canSupportTools(supportStand))) {
            releaseContainerFromSupportStand(container);
            supportStand = null;
        }

        // NEW HEATING RULE:
        // Không dùng trạng thái snap/assembly để coi là có nhiệt.
        // Chỉ nguồn nhiệt thật sự, đang bật, nằm đúng bên dưới container mới được tính.
        const activeSource = this.findActiveHeatingSourceBelowContainer(container);

        const nearestDistance = activeSource ? sourceDistance(container, activeSource) : Infinity;
        let nextTemperature = current;
        if (activeSource) {
            const power = Math.max(0, Number(activeSource.userData.heatingPower ?? 8));
            const maxTemperature = Math.max(this.minTemperature, Number(activeSource.userData.maxTemperature ?? 120));
            nextTemperature = Math.min(maxTemperature, current + power * deltaTime);
            container.userData.isHeating = true;
            container.userData.heatingSource = activeSource;
            markContainerHeated(container, Number(nextTemperature.toFixed(2)));
            this.debugHeatingCheck(container, activeSource);
            this.debugHeating(activeSource, container, nearestDistance, supportStand);
        } else {
            nextTemperature = Math.max(this.minTemperature, current - this.coolingPower * deltaTime);
            container.userData.isHeating = false;
            container.userData.heatingSource = null;
            this.debugHeatingCheck(container, null);
            if (Math.abs(nextTemperature - current) > 0.001) {
                const rounded = Number(nextTemperature.toFixed(2));
                container.userData.currentTemperature = rounded;
                container.userData.temperature = rounded;
            }
        }

        if (activeSource && Math.abs(nextTemperature - current) > 0.001) {
            notifyPendingReaction(container);
        }
    }

    findActiveHeatingSourceBelowContainer(container) {
        if (!isHeatTarget(container)) return null;
        const containerInfo = getBoxCenterAndSize(container);
        const tableY = getTableSurfaceY();
        return this.heatingSources.find(source => {
            if (!source?.parent) return false;
            if (source.userData?.isHeatingSource !== true) return false;
            if (source.userData?.isOn !== true) return false;

            const sourceInfo = getBoxCenterAndSize(source);
            const dx = sourceInfo.center.x - containerInfo.center.x;
            const dz = sourceInfo.center.z - containerInfo.center.z;
            const horizontalDist = Math.sqrt(dx * dx + dz * dz);
            const sourceBelow = sourceInfo.center.y < containerInfo.center.y && sourceInfo.box.min.y >= tableY - 0.08;

            return horizontalDist < 0.8 && sourceBelow;
        }) || null;
    }

    findActiveHeatingSourceUnderSupport(support) {
        if (!canSupportTools(support)) return null;
        const supportInfo = getBoxCenterAndSize(support);
        return this.heatingSources.find(source => {
            if (!source?.parent) return false;
            if (source.userData?.isHeatingSource !== true) return false;
            if (source.userData?.isOn !== true) return false;
            const sourceInfo = getBoxCenterAndSize(source);
            const dx = sourceInfo.center.x - supportInfo.center.x;
            const dz = sourceInfo.center.z - supportInfo.center.z;
            const horizontalDist = Math.sqrt(dx * dx + dz * dz);
            const sourceBelow = sourceInfo.center.y < supportInfo.center.y + 0.2;
            return horizontalDist < 0.8 && sourceBelow;
        }) || null;
    }

    findActiveHeatingSourceThroughAssembly(container) {
        const manager = window.labAssemblyManager;
        if (!manager?.findActiveHeatingSource) return null;
        const source = manager.findActiveHeatingSource(container);
        if (!source?.parent) return null;
        if (source.userData?.isHeatingSource !== true) return null;
        if (source.userData?.isOn !== true) return null;
        return source;
    }

    debugHeatingCheck(container, source) {
        const now = performance.now();
        if (now - this.lastDebugAt < 1000) return;
        console.log('[HeatingCheck] container:', toolName(container));
        console.log('[HeatingCheck] source below:', source ? toolName(source) : 'none');
        console.log('[HeatingCheck] source isOn:', source?.userData?.isOn);
        console.log('[HeatingCheck] heating allowed:', !!source);
        this.lastDebugAt = now;
    }

    debugSupportHeatingState(container, support, source) {
        const now = performance.now();
        if (now - this.lastSupportDebugAt < 1000) return;
        console.log('[HeatingManager] container on support:', toolName(container));
        console.log('[HeatingManager] active source under support:', source ? toolName(source) : 'none');
        console.log('[HeatingManager] isHeating:', container.userData.isHeating);
        console.log('[HeatingManager] temp:', container.userData.currentTemperature);
        this.lastSupportDebugAt = now;
    }

    debugHeating(source, container, distance, support = null) {
        const now = performance.now();
        if (now - this.lastDebugAt < 1000) return;
        if (support) console.log('[HeatingManager] heating through support stand:', toolName(support));
        console.log('[HeatingManager] source:', toolName(source), 'isOn:', source.userData.isOn);
        console.log('[HeatingManager] container:', toolName(container), 'temp:', container.userData.currentTemperature);
        console.debug('[HeatingManager] distance:', Number(distance.toFixed(3)), 'power:', source.userData.heatingPower);
        this.lastDebugAt = now;
    }
}

export function createHeatingManager(scene, options = {}) {
    return new HeatingManager(scene, options);
}

export function canToggleHeatingSource(object) {
    return isToggleableHeatingSource(object);
}

export function toggleHeatingSource(object) {
    if (!canToggleHeatingSource(object)) {
        console.warn('[HeatingManager] Object is not a toggleable heating source:', object?.userData?.toolData);
        return false;
    }
    ensureSourceState(object);
    object.userData.isOn = !object.userData.isOn;
    HeatingManager.setSourceVisual(object, object.userData.isOn);
    console.log('[HeatingManager] source:', toolName(object), 'isOn:', object.userData.isOn);
    return object.userData.isOn;
}

export function setSourceVisual(object, isOn) {
    HeatingManager.setSourceVisual(object, isOn);
}
