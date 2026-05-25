import * as THREE from 'three';
import {
    applyPlacementDelta,
    getConnectionDistanceScore,
    getPlacementDeltaForAnchors,
    getToolAnchorPoints,
    getToolBoxInfo,
    getToolLabel,
    getTableSurfaceY,
    isContainerTool,
    isHeatingSourceTool,
    isSupportStandTool,
    keepObjectAboveTable
} from './toolAnchors.js';

export const PORT_COMPATIBILITY = {
    liquid_out: ['liquid_in', 'opening'],
    liquid_in: ['liquid_out', 'gas_out', 'gas_in', 'support_target', 'bottom_slot'],
    opening: ['liquid_out', 'gas_out', 'gas_in', 'support_target', 'bottom_slot'],
    gas_out: ['gas_in', 'opening', 'liquid_in'],
    gas_in: ['gas_out', 'opening', 'liquid_in'],
    support: ['support_top', 'support_target'],
    support_top: ['support_target', 'bottom_slot'],
    support_target: ['support_top', 'top_slot', 'container_slot', 'opening', 'liquid_in'],
    top_slot: ['bottom_slot', 'support_target'],
    bottom_slot: ['top_slot', 'support_top', 'container_slot', 'opening', 'liquid_in'],
    center_slot: ['center_slot'],
    container_slot: ['bottom_slot', 'support_target'],
    holder_slot: ['clamp_target', 'bottom_slot', 'support_target'],
    clamp: ['clamp_point', 'clamp_target'],
    clamp_point: ['clamp_target'],
    clamp_target: ['clamp_point', 'holder_slot'],
    heating_zone: ['heat_target', 'heat_slot'],
    heat_target: ['heating_zone', 'heat_slot'],
    heat_slot: ['heating_zone', 'heat_target']
};

const CONNECTION_TYPES = {
    liquid_out: 'liquid',
    liquid_in: 'liquid',
    opening: 'liquid',
    gas_out: 'gas',
    gas_in: 'gas',
    support: 'support',
    support_top: 'support',
    support_target: 'support',
    top_slot: 'support',
    bottom_slot: 'support',
    container_slot: 'support',
    center_slot: 'generic',
    holder_slot: 'clamp',
    clamp: 'clamp',
    clamp_point: 'clamp',
    clamp_target: 'clamp',
    heating_zone: 'heat',
    heat_target: 'heat',
    heat_slot: 'heat'
};

const POINT_TYPE_ALIASES = {
    opening: ['liquid_in'],
    liquid_in: ['opening'],
    support: ['support_top', 'support_target'],
    support_top: ['support', 'container_slot', 'top_slot'],
    support_target: ['support', 'bottom_slot'],
    top_slot: ['support_top'],
    bottom_slot: ['support_target'],
    container_slot: ['support_top'],
    center_slot: ['center'],
    holder_slot: ['clamp_point'],
    clamp: ['clamp_point', 'clamp_target'],
    clamp_point: ['clamp', 'holder_slot'],
    clamp_target: ['clamp'],
    heat: ['heating_zone', 'heat_target', 'heat_slot'],
    heating_zone: ['heat', 'heat_slot'],
    heat_target: ['heat', 'heat_slot'],
    heat_slot: ['heat', 'heating_zone', 'heat_target']
};

function normalizeArray(value) {
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

function normalizeObject(value) {
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

function toolName(tool) {
    return getToolLabel(tool);
}

function pointEntries(tool) {
    return getToolAnchorPoints(tool);
}

function offsetToVector(offset = [0, 0, 0]) {
    if (Array.isArray(offset)) return new THREE.Vector3(Number(offset[0]) || 0, Number(offset[1]) || 0, Number(offset[2]) || 0);
    return new THREE.Vector3(Number(offset.x) || 0, Number(offset.y) || 0, Number(offset.z) || 0);
}

function getPointWorldPosition(tool, point) {
    const local = offsetToVector(point.offset);
    tool?.updateMatrixWorld?.(true);
    return tool.localToWorld(local.clone());
}

function getObjectWorldPosition(object) {
    const position = new THREE.Vector3();
    object?.getWorldPosition?.(position);
    return position;
}

function setObjectWorldPosition(object, worldPosition) {
    const savedScale = object.userData?.customScale?.clone?.() || object.scale.clone();
    const local = worldPosition.clone();
    object.parent?.worldToLocal(local);
    object.position.copy(local);
    object.scale.copy(savedScale);
    object.userData.customScale = savedScale;
    object.userData.hasCustomScale = true;
    object.updateMatrixWorld(true);
}

function expandedTypes(type) {
    return new Set([type, ...(POINT_TYPE_ALIASES[type] || [])].filter(Boolean));
}

function compatible(a, b) {
    const typesA = expandedTypes(a);
    const typesB = expandedTypes(b);
    for (const typeA of typesA) {
        for (const typeB of typesB) {
            if (PORT_COMPATIBILITY[typeA]?.includes(typeB) || PORT_COMPATIBILITY[typeB]?.includes(typeA)) return true;
        }
    }
    return false;
}

function connectionTypeFor(a, b) {
    const typesA = expandedTypes(a);
    const typesB = expandedTypes(b);
    const hasOpening = typesA.has('opening') || typesA.has('liquid_in') || typesB.has('opening') || typesB.has('liquid_in');
    const hasInsertEnd = [...typesA, ...typesB].some(type => ['support_target', 'bottom_slot', 'gas_in', 'gas_out'].includes(type));
    if (hasOpening && hasInsertEnd) return (typesA.has('gas_in') || typesA.has('gas_out') || typesB.has('gas_in') || typesB.has('gas_out')) ? 'gas' : 'insert';
    if (typesA.has('gas_out') && typesB.has('gas_in') || typesB.has('gas_out') && typesA.has('gas_in')) return 'gas';
    if ([...typesA].some(type => ['liquid_out', 'liquid_in', 'opening'].includes(type)) &&
        [...typesB].some(type => ['liquid_out', 'liquid_in', 'opening'].includes(type))) return 'liquid';
    if ([...typesA].some(type => ['support', 'support_top', 'support_target', 'top_slot', 'bottom_slot', 'container_slot'].includes(type)) &&
        [...typesB].some(type => ['support', 'support_top', 'support_target', 'top_slot', 'bottom_slot', 'container_slot'].includes(type))) return 'support';
    if ([...typesA].some(type => ['clamp', 'clamp_point', 'clamp_target', 'holder_slot'].includes(type)) &&
        [...typesB].some(type => ['clamp', 'clamp_point', 'clamp_target', 'holder_slot'].includes(type))) return 'clamp';
    if ([...typesA].some(type => ['heat', 'heating_zone', 'heat_target', 'heat_slot'].includes(type)) &&
        [...typesB].some(type => ['heat', 'heating_zone', 'heat_target', 'heat_slot'].includes(type))) return 'heat';
    return CONNECTION_TYPES[a] || CONNECTION_TYPES[b] || 'generic';
}

function isActiveHeatingSource(tool) {
    return Boolean(tool?.userData?.isHeatingSource === true && tool.userData.isOn === true);
}

function hasGasProduct(reaction = {}) {
    const raw = reaction.raw || {};
    const text = [
        reaction.equation,
        raw.equation,
        raw.reaction_data?.equation,
        ...(reaction.products || []),
        ...(raw.products || []),
        ...(raw.reaction_data?.products || [])
    ].filter(Boolean).join(' ').toLowerCase();
    return /(h2|co2|o2|cl2|nh3|so2|no2|n2|hcl\(g\)|↑|\bgas\b|khí|khi)/i.test(text);
}

function reactionRequiresHeating(reaction = {}) {
    const raw = reaction.raw || {};
    const conditions = reaction.conditions || raw.conditions || raw.reaction_data?.conditions || {};
    return Boolean(
        reaction.heating_required ||
        reaction.heatingRequired ||
        reaction.target_temperature ||
        reaction.targetTemperature ||
        reaction.requiredTemperature ||
        conditions.minTemperature
    );
}

function reactionRequiredSetup(reaction = {}) {
    const raw = reaction.raw || {};
    return normalizeObject(reaction.requiredSetup ||
        reaction.required_setup ||
        raw.requiredSetup ||
        raw.required_setup ||
        raw.reaction_data?.requiredSetup ||
        raw.reaction_data?.required_setup ||
        {});
}

function boolRequired(required, ...keys) {
    return keys.some(key => required?.[key] === true);
}

const SETUP_MESSAGES = {
    container: 'Cần đặt hóa chất trong dụng cụ chứa phù hợp trước khi thực hiện.',
    heating: 'Phản ứng này cần lắp nguồn nhiệt với dụng cụ chứa trước khi thực hiện.',
    gas_collection: 'Cần lắp ống dẫn khí và dụng cụ thu khí trước khi thực hiện.',
    support: 'Cần đặt hoặc kẹp dụng cụ lên giá đỡ trước khi thực hiện.',
    clamp: 'Cần kẹp giữ dụng cụ trước khi thực hiện thí nghiệm này.',
    dropping_funnel: 'Cần nối phễu nhỏ giọt với bình phản ứng trước khi thực hiện.',
    stirring: 'Cần có dụng cụ khuấy cho thí nghiệm này.'
};

export class LabAssemblyManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.getObjects = options.getObjects || (() => []);
        this.connections = [];
        this.snapDistance = Number(options.snapDistance ?? 0.65);
        this.tableY = Number.isFinite(options.tableY) ? options.tableY : getTableSurfaceY();
    }

    setObjectsProvider(getObjects) {
        this.getObjects = getObjects || (() => []);
    }

    registerObject(tool) {
        if (!tool?.userData) return;
        const toolData = tool.userData.toolData || {};
        tool.userData.toolType ??= tool.userData.tool_type ?? toolData.toolType ?? toolData.tool_type ?? 'unknown';
        tool.userData.tool_type ??= tool.userData.toolType;
        const capabilities = normalizeArray(tool.userData.capabilities);
        const ports = normalizeObject(tool.userData.ports);
        const attachPoints = normalizeObject(tool.userData.attachPoints || tool.userData.attach_points);
        tool.userData.capabilities = capabilities.length ? capabilities : normalizeArray(toolData.capabilities);
        tool.userData.ports = Object.keys(ports).length ? ports : normalizeObject(toolData.ports);
        tool.userData.attachPoints = Object.keys(attachPoints).length ? attachPoints : normalizeObject(toolData.attach_points);
        tool.userData.attach_points ??= tool.userData.attachPoints;
        tool.userData.assemblyRole ??= tool.userData.assembly_role ?? toolData.assemblyRole ?? toolData.assembly_role ?? 'none';
        tool.userData.assembly_role ??= tool.userData.assemblyRole;
        tool.userData.assemblyConnections ??= [];
    }

    syncObjects() {
        this.getObjects().filter(Boolean).forEach(tool => this.registerObject(tool));
        this.connections = this.connections.filter(conn => conn.fromTool?.parent && conn.toTool?.parent);
    }

    unregisterObject(tool) {
        if (!tool) return;
        this.disconnectTool(tool);
        this.connections = this.connections.filter(conn => conn.fromTool !== tool && conn.toTool !== tool);
    }

    hasCapability(tool, capability) {
        return normalizeArray(tool?.userData?.capabilities).includes(capability);
    }

    isAllowedMatch(movingTool, fixedTool, pointA, pointB, connectionType) {
        if (!movingTool || !fixedTool || movingTool === fixedTool) return false;

        if (connectionType === 'heat') {
            return isHeatingSourceTool(movingTool) && !isHeatingSourceTool(fixedTool);
        }

        if (connectionType === 'insert') {
            return isContainerTool(fixedTool) && !isHeatingSourceTool(movingTool);
        }

        if (connectionType === 'gas') {
            if (['opening', 'liquid_in'].includes(pointB.type)) return isContainerTool(fixedTool);
            return true;
        }

        if (connectionType === 'support') {
            if (!isSupportStandTool(fixedTool)) return false;
            if (isHeatingSourceTool(movingTool)) return false;
            return isContainerTool(movingTool) || ['support_target', 'bottom_slot', 'clamp_target', 'holder_slot'].includes(pointA.type);
        }

        if (connectionType === 'clamp') {
            return isSupportStandTool(fixedTool) || this.hasCapability(fixedTool, 'clamp');
        }

        return true;
    }

    isSlotOccupied(fixedTool, fixedPoint, movingTool, connectionType) {
        if (!fixedTool || !fixedPoint?.name) return false;
        const fixedInfo = getToolBoxInfo(fixedTool);
        const spacing = Math.max(0.22, Number(fixedTool?.userData?.supportSlotSpacing ?? 0.34) || 0.34);
        return this.connections.some(conn => {
            if (conn.fromTool === movingTool || conn.toTool === movingTool) return false;
            if (conn.fixedTool !== fixedTool && conn.toTool !== fixedTool) return false;
            if (connectionType && conn.connectionType !== connectionType) return false;

            const connFixedPort = conn.fixedPort || conn.toPort;
            if (connFixedPort === fixedPoint.name) return true;

            if (connectionType === 'support' && isSupportStandTool(fixedTool)) {
                const existingPoint = conn.fixedWorldPosition || getToolAnchorPoints(fixedTool).find(point => point.name === connFixedPort)?.worldPosition;
                if (!existingPoint || !fixedPoint.worldPosition) return false;
                const dx = existingPoint.x - fixedPoint.worldPosition.x;
                const dz = existingPoint.z - fixedPoint.worldPosition.z;
                const horizontal = Math.sqrt(dx * dx + dz * dz);
                return horizontal < spacing * 0.45 && Math.abs(existingPoint.y - fixedPoint.worldPosition.y) < Math.max(0.18, fixedInfo.size.y * 0.25);
            }

            return false;
        });
    }

    findNearestCompatiblePort(toolA, toolB, maxDistance = this.snapDistance) {
        if (!toolA || !toolB || toolA === toolB) return null;
        const pointsA = pointEntries(toolA);
        const pointsB = pointEntries(toolB);
        let best = null;

        for (const pointA of pointsA) {
            for (const pointB of pointsB) {
                if (!compatible(pointA.type, pointB.type)) continue;
                const connectionType = connectionTypeFor(pointA.type, pointB.type);
                if (!this.isAllowedMatch(toolA, toolB, pointA, pointB, connectionType)) continue;
                if (this.isSlotOccupied(toolB, pointB, toolA, connectionType)) continue;

                const placement = getPlacementDeltaForAnchors(toolA, pointA, toolB, pointB, connectionType, { tableY: this.tableY });
                if (!placement.valid) continue;

                const distance = getConnectionDistanceScore(pointA, pointB, connectionType);
                const priority = Number(pointB.priority ?? 0) * 0.02;
                const score = distance + priority;
                if (distance <= maxDistance && (!best || score < best.score)) {
                    best = {
                        toolA,
                        pointA,
                        worldA: pointA.worldPosition.clone(),
                        toolB,
                        pointB,
                        worldB: pointB.worldPosition.clone(),
                        distance,
                        score,
                        connectionType,
                        placement
                    };
                }
            }
        }
        return best;
    }

    connectTools(fromTool, fromPort, toTool, toPort, options = {}) {
        if (!fromTool || !toTool || !fromPort || !toPort) return null;
        this.disconnectTools(fromTool, toTool, fromPort.name, toPort.name);

        const connection = {
            fromTool,
            fromPort: fromPort.name,
            fromPortType: fromPort.type,
            toTool,
            toPort: toPort.name,
            toPortType: toPort.type,
            movingTool: options.movingTool || fromTool,
            movingPort: options.movingPort || fromPort.name,
            fixedTool: options.fixedTool || toTool,
            fixedPort: options.fixedPort || toPort.name,
            movingWorldPosition: fromPort.worldPosition?.clone?.() || null,
            fixedWorldPosition: toPort.worldPosition?.clone?.() || null,
            connectionType: options.connectionType || connectionTypeFor(fromPort.type, toPort.type),
            createdAt: Date.now()
        };
        this.connections.push(connection);
        fromTool.userData.assemblyConnections ??= [];
        toTool.userData.assemblyConnections ??= [];
        fromTool.userData.assemblyConnections.push(connection);
        toTool.userData.assemblyConnections.push(connection);
        this.applyConnectionState(connection);
        console.log('[LabAssembly] connected:', toolName(fromTool), fromPort.name, '->', toolName(toTool), toPort.name, connection.connectionType);
        return connection;
    }

    disconnectTools(toolA, toolB, portA = null, portB = null) {
        this.connections = this.connections.filter(conn => {
            const samePair = (conn.fromTool === toolA && conn.toTool === toolB) || (conn.fromTool === toolB && conn.toTool === toolA);
            const samePorts = !portA || !portB || (
                [conn.fromPort, conn.toPort].includes(portA) &&
                [conn.fromPort, conn.toPort].includes(portB)
            );
            return !(samePair && samePorts);
        });
        [toolA, toolB].filter(Boolean).forEach(tool => {
            tool.userData.assemblyConnections = (tool.userData.assemblyConnections || []).filter(conn => this.connections.includes(conn));
        });
    }

    disconnectTool(tool) {
        if (!tool) return;
        const connectedTools = new Set();
        this.connections
            .filter(conn => conn.fromTool === tool || conn.toTool === tool)
            .forEach(conn => connectedTools.add(conn.fromTool === tool ? conn.toTool : conn.fromTool));
        this.connections = this.connections.filter(conn => conn.fromTool !== tool && conn.toTool !== tool);
        tool.userData.assemblyConnections = [];
        connectedTools.forEach(other => {
            if (other?.userData) {
                other.userData.assemblyConnections = (other.userData.assemblyConnections || []).filter(conn => this.connections.includes(conn));
                if (other.userData.supportStand === tool) {
                    other.userData.isOnSupportStand = false;
                    other.userData.isSnappedToSupport = false;
                    other.userData.supportStand = null;
                }
                if (tool.userData?.supportedTools) {
                    tool.userData.supportedTools = tool.userData.supportedTools.filter(item => item !== other && item?.parent);
                }
                if (other.userData.heatingSource === tool) {
                    other.userData.isOnHeatingSource = false;
                    other.userData.isSnappedToHeatingSource = false;
                    other.userData.heatingSource = null;
                    other.userData.isHeating = false;
                }
                if (other.userData.clampTool === tool) {
                    other.userData.isClamped = false;
                    other.userData.clampTool = null;
                }
                if (other.userData.heatTargetContainer === tool) {
                    other.userData.isUnderContainer = false;
                    other.userData.heatTargetContainer = null;
                }
                if (other.userData.supportedTools) {
                    other.userData.supportedTools = other.userData.supportedTools.filter(item => item !== tool && item?.parent);
                }
                if (other.userData.insertedTools) {
                    other.userData.insertedTools = other.userData.insertedTools.filter(item => item !== tool && item?.parent);
                }
                if (other.userData.insertedInto === tool) {
                    other.userData.insertedInto = null;
                    other.userData.isInsertedIntoContainer = false;
                }
            }
        });
        if (tool.userData) {
            tool.userData.isAssemblySnapped = false;
            tool.userData.assemblyAnchorTool = null;
            tool.userData.assemblySlotName = null;
            tool.userData.assemblyConnectionType = null;
            tool.userData.isClamped = false;
            tool.userData.clampTool = null;
            tool.userData.isOnSupportStand = false;
            tool.userData.isSnappedToSupport = false;
            tool.userData.supportStand = null;
            tool.userData.isOnHeatingSource = false;
            tool.userData.isSnappedToHeatingSource = false;
            tool.userData.heatingSource = null;
            tool.userData.isUnderSupportStand = false;
            tool.userData.isUnderContainer = false;
            tool.userData.heatTargetContainer = null;
            tool.userData.insertedInto = null;
            tool.userData.isInsertedIntoContainer = false;
            tool.userData.insertedTools = (tool.userData.insertedTools || []).filter(item => item?.parent);
        }
    }

    applyConnectionState(connection) {
        if (!connection) return;
        const tools = [connection.fromTool, connection.toTool];
        const support = tools.find(tool => isSupportStandTool(tool));
        const heatSource = tools.find(tool => isHeatingSourceTool(tool));
        const container = tools.find(tool => isContainerTool(tool) && !isHeatingSourceTool(tool));
        const clamp = tools.find(tool => this.hasCapability(tool, 'clamp') && tool !== support);
        const clampedTool = tools.find(tool => tool !== clamp && tool !== support);

        if (connection.connectionType === 'support' && support && container?.userData) {
            container.userData.isOnSupportStand = true;
            container.userData.supportStand = support;
            container.userData.isSnappedToSupport = true;
            support.userData.supportedTools ??= [];
            if (!support.userData.supportedTools.includes(container)) support.userData.supportedTools.push(container);
        }

        if (connection.connectionType === 'clamp' && clampedTool?.userData) {
            clampedTool.userData.isClamped = true;
            clampedTool.userData.clampTool = clamp || support || null;
        }

        if (connection.connectionType === 'heat') {
            if (container?.userData && heatSource) {
                container.userData.isOnHeatingSource = true;
                container.userData.heatingSource = heatSource;
                container.userData.isSnappedToHeatingSource = true;
            }
            if (support?.userData && heatSource?.userData && support !== heatSource) {
                heatSource.userData.isUnderSupportStand = true;
                heatSource.userData.supportStand = support;
            }
            if (container?.userData && heatSource?.userData && connection.fixedTool === container) {
                heatSource.userData.isUnderContainer = true;
                heatSource.userData.heatTargetContainer = container;
            }
        }

        if (connection.connectionType === 'insert' && connection.fixedTool?.userData && connection.movingTool?.userData) {
            connection.movingTool.userData.insertedInto = connection.fixedTool;
            connection.movingTool.userData.isInsertedIntoContainer = true;
            connection.fixedTool.userData.insertedTools ??= [];
            if (!connection.fixedTool.userData.insertedTools.includes(connection.movingTool)) {
                connection.fixedTool.userData.insertedTools.push(connection.movingTool);
            }
        }
    }

    snapAndConnect(movingTool, fixedTool, match) {
        if (!movingTool || !fixedTool || !match) return null;
        const connectionType = match.connectionType || connectionTypeFor(match.pointA.type, match.pointB.type);
        const placement = match.placement || getPlacementDeltaForAnchors(
            movingTool,
            match.pointA,
            fixedTool,
            match.pointB,
            connectionType,
            { tableY: this.tableY }
        );
        if (!placement.valid) return null;
        applyPlacementDelta(movingTool, placement, { tableY: this.tableY });
        keepObjectAboveTable(movingTool, this.tableY);

        const connection = this.connectTools(
            movingTool,
            match.pointA,
            fixedTool,
            match.pointB,
            {
                connectionType,
                movingTool,
                movingPort: match.pointA.name,
                fixedTool,
                fixedPort: match.pointB.name
            }
        );
        movingTool.userData.isAssemblySnapped = true;
        movingTool.userData.assemblyAnchorTool = fixedTool;
        movingTool.userData.assemblySlotName = match.pointB.name;
        movingTool.userData.assemblyConnectionType = connectionType;
        movingTool.updateMatrixWorld?.(true);
        return connection;
    }

    findBestSnapMatch(movingTool, objects = this.getObjects(), options = {}) {
        this.syncObjects();
        const maxDistance = Number(options.maxDistance ?? this.snapDistance);
        let best = null;
        for (const candidate of objects) {
            if (!candidate || candidate === movingTool) continue;
            const match = this.findNearestCompatiblePort(movingTool, candidate, maxDistance);
            if (match && (!best || match.score < best.score)) best = match;
        }
        return best;
    }

    getSnapPreview(movingTool, objects = this.getObjects(), options = {}) {
        const match = this.findBestSnapMatch(movingTool, objects, options);
        if (!match) return null;
        return {
            match,
            connectionType: match.connectionType,
            targetTool: match.toolB,
            targetSlot: match.pointB,
            placement: match.placement
        };
    }

    applySoftSnapPreview(movingTool, objects = this.getObjects(), options = {}) {
        const preview = this.getSnapPreview(movingTool, objects, options);
        if (!preview?.placement?.valid) return null;
        const strength = Math.max(0, Math.min(1, Number(options.strength ?? 0.35)));
        applyPlacementDelta(movingTool, {
            valid: true,
            delta: preview.placement.delta.clone().multiplyScalar(strength)
        }, {
            tableY: this.tableY,
            keepAboveTable: true
        });
        return preview;
    }

    tryAutoConnect(movingTool, objects = this.getObjects(), options = {}) {
        const best = this.findBestSnapMatch(movingTool, objects, options);
        if (!best) return null;
        return this.snapAndConnect(movingTool, best.toolB, best);
    }

    enforceConnectionPlacement(tool) {
        const connection = this.connections.find(conn => conn.movingTool === tool || conn.fromTool === tool);
        if (!connection?.fixedTool?.parent) return false;

        const movingPoint = getToolAnchorPoints(tool).find(point => point.name === (connection.movingPort || connection.fromPort));
        const fixedPoint = getToolAnchorPoints(connection.fixedTool).find(point => point.name === (connection.fixedPort || connection.toPort));
        if (!movingPoint || !fixedPoint) return false;

        const placement = getPlacementDeltaForAnchors(
            tool,
            movingPoint,
            connection.fixedTool,
            fixedPoint,
            connection.connectionType,
            { tableY: this.tableY }
        );
        if (!placement.valid) return false;
        applyPlacementDelta(tool, placement, { tableY: this.tableY });
        return true;
    }

    getNeighbors(tool, connectionType = null) {
        return this.connections
            .filter(conn => (conn.fromTool === tool || conn.toTool === tool) && (!connectionType || conn.connectionType === connectionType))
            .map(conn => conn.fromTool === tool ? conn.toTool : conn.fromTool);
    }

    getConnectionsFor(tool, connectionType = null) {
        return this.connections.filter(conn =>
            (conn.fromTool === tool || conn.toTool === tool) &&
            (!connectionType || conn.connectionType === connectionType)
        );
    }

    hasPath(startTool, endCapability, connectionType = null) {
        if (!startTool) return false;
        const visited = new Set();
        const queue = [startTool];
        while (queue.length) {
            const tool = queue.shift();
            if (!tool || visited.has(tool)) continue;
            visited.add(tool);
            if (tool !== startTool && this.hasCapability(tool, endCapability)) return true;
            this.getNeighbors(tool, connectionType).forEach(next => {
                if (!visited.has(next)) queue.push(next);
            });
        }
        return false;
    }

    hasGasCollectionPath(container) {
        return this.hasPath(container, 'collect_gas', 'gas');
    }

    hasSupportPath(container) {
        return this.hasPath(container, 'support', 'support') ||
            this.hasPath(container, 'support', 'clamp') ||
            this.hasPath(container, 'clamp', 'clamp');
    }

    hasDroppingFunnelPath(container) {
        return this.hasPath(container, 'drop_liquid', 'liquid');
    }

    hasHeatingPath(container) {
        if (container?.userData?.isHeating && container.userData.heatingSource?.userData?.isHeatingSource) return true;
        if (this.hasPath(container, 'heat', 'heat')) return true;

        const supports = [
            ...this.getNeighbors(container, 'support'),
            ...this.getNeighbors(container, 'clamp')
        ].filter(tool => this.hasCapability(tool, 'support'));
        return supports.some(support => this.getNeighbors(support, 'heat').some(source => this.hasCapability(source, 'heat')));
    }

    findActiveHeatingSource(container) {
        const direct = this.getNeighbors(container, 'heat').find(isActiveHeatingSource);
        if (direct) return direct;

        const supports = [
            ...this.getNeighbors(container, 'support'),
            ...this.getNeighbors(container, 'clamp')
        ].filter(tool => this.hasCapability(tool, 'support'));
        for (const support of supports) {
            const source = this.getNeighbors(support, 'heat').find(isActiveHeatingSource);
            if (source) return source;
        }
        return null;
    }

    validateReactionSetup(reaction = {}, container = null) {
        const required = reactionRequiredSetup(reaction);
        const needsContainer = boolRequired(required, 'container');
        const needsHeating = boolRequired(required, 'heating', 'heat') || reactionRequiresHeating(reaction);
        const needsGasCollection = boolRequired(required, 'gasCollection', 'gas_collection');
        const needsSupport = boolRequired(required, 'support');
        const needsDroppingFunnel = boolRequired(required, 'droppingFunnel', 'dropping_funnel');
        const needsStirring = boolRequired(required, 'stirring', 'stir');
        const needsClamp = boolRequired(required, 'clamp');

        const missing =
            (needsContainer && !this.hasCapability(container, 'react') && !this.hasCapability(container, 'contain_liquid') && 'container') ||
            (needsHeating && !this.hasHeatingPath(container) && 'heating') ||
            (needsGasCollection && !this.hasGasCollectionPath(container) && 'gas_collection') ||
            (needsSupport && !this.hasSupportPath(container) && 'support') ||
            (needsClamp && !this.hasPath(container, 'clamp', 'clamp') && 'clamp') ||
            (needsDroppingFunnel && !this.hasDroppingFunnelPath(container) && 'dropping_funnel') ||
            (needsStirring && !this.hasPath(container, 'stir') && 'stirring') ||
            null;

        if (missing) {
            return { ok: false, missing, message: SETUP_MESSAGES[missing] || 'Thiếu setup dụng cụ cho phản ứng này.' };
        }

        if (needsContainer && !this.hasCapability(container, 'react') && !this.hasCapability(container, 'contain_liquid')) {
            return { ok: false, missing: 'container', message: 'Cần đặt hóa chất trong dụng cụ chứa phù hợp trước khi thực hiện.' };
        }
        if (needsHeating && !this.hasHeatingPath(container)) {
            return { ok: false, missing: 'heating', message: 'Phản ứng này cần lắp nguồn nhiệt với dụng cụ chứa trước khi thực hiện.' };
        }
        if (needsGasCollection && !this.hasGasCollectionPath(container)) {
            return { ok: false, missing: 'gas_collection', message: 'Cần lắp ống dẫn khí và dụng cụ thu khí trước khi thực hiện.' };
        }
        if (needsSupport && !this.hasSupportPath(container)) {
            return { ok: false, missing: 'support', message: 'Cần đặt hoặc kẹp dụng cụ lên giá đỡ trước khi thực hiện.' };
        }
        if (needsClamp && !this.hasPath(container, 'clamp', 'clamp')) {
            return { ok: false, missing: 'clamp', message: 'Can kep giu dung cu truoc khi thuc hien thi nghiem nay.' };
        }
        if (needsDroppingFunnel && !this.hasDroppingFunnelPath(container)) {
            return { ok: false, missing: 'dropping_funnel', message: 'Cần nối phễu nhỏ giọt với bình phản ứng trước khi thực hiện.' };
        }
        if (needsStirring && !this.hasPath(container, 'stir')) {
            return { ok: false, missing: 'stirring', message: 'Cần có dụng cụ khuấy cho thí nghiệm này.' };
        }

        if (hasGasProduct(reaction) && needsGasCollection && !this.hasGasCollectionPath(container)) {
            return { ok: false, missing: 'gas_collection', message: 'Phản ứng sinh khí cần có đường dẫn và dụng cụ thu khí.' };
        }

        return { ok: true, missing: null, message: '' };
    }
}

export function createLabAssemblyManager(scene, options = {}) {
    return new LabAssemblyManager(scene, options);
}

export default LabAssemblyManager;
