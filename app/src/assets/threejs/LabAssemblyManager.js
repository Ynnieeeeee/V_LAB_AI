import * as THREE from 'three';

const PORT_COMPATIBILITY = {
    liquid_out: ['liquid_in', 'opening'],
    gas_out: ['gas_in'],
    support_top: ['support_target'],
    support_target: ['support_top'],
    clamp_point: ['clamp_target'],
    clamp_target: ['clamp_point'],
    heating_zone: ['heat_target'],
    heat_target: ['heating_zone']
};

const CONNECTION_TYPES = {
    liquid_out: 'liquid',
    liquid_in: 'liquid',
    opening: 'liquid',
    gas_out: 'gas',
    gas_in: 'gas',
    support_top: 'support',
    support_target: 'support',
    clamp_point: 'clamp',
    clamp_target: 'clamp',
    heating_zone: 'heat',
    heat_target: 'heat'
};

function toolName(tool) {
    return tool?.userData?.toolData?.name_tool_vi ||
        tool?.userData?.toolData?.name_tool_en ||
        tool?.name ||
        'tool';
}

function pointEntries(tool) {
    const ports = tool?.userData?.ports || {};
    const attachPoints = tool?.userData?.attachPoints || tool?.userData?.attach_points || {};
    return [
        ...Object.entries(ports).map(([name, data]) => ({ name, ...data, group: 'ports' })),
        ...Object.entries(attachPoints).map(([name, data]) => ({ name, ...data, group: 'attachPoints' }))
    ].filter(point => point?.type);
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

function compatible(a, b) {
    return PORT_COMPATIBILITY[a]?.includes(b) || PORT_COMPATIBILITY[b]?.includes(a);
}

function connectionTypeFor(a, b) {
    if ((a === 'gas_out' && b === 'gas_in') || (b === 'gas_out' && a === 'gas_in')) return 'gas';
    if (['liquid_out', 'liquid_in', 'opening'].includes(a) && ['liquid_out', 'liquid_in', 'opening'].includes(b)) return 'liquid';
    if (['support_top', 'support_target'].includes(a) && ['support_top', 'support_target'].includes(b)) return 'support';
    if (['clamp_point', 'clamp_target'].includes(a) && ['clamp_point', 'clamp_target'].includes(b)) return 'clamp';
    if (['heating_zone', 'heat_target'].includes(a) && ['heating_zone', 'heat_target'].includes(b)) return 'heat';
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

export class LabAssemblyManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.getObjects = options.getObjects || (() => []);
        this.connections = [];
        this.snapDistance = Number(options.snapDistance ?? 0.45);
    }

    setObjectsProvider(getObjects) {
        this.getObjects = getObjects || (() => []);
    }

    registerObject(tool) {
        if (!tool?.userData) return;
        tool.userData.capabilities ??= [];
        tool.userData.ports ??= {};
        tool.userData.attachPoints ??= tool.userData.attach_points ?? {};
        tool.userData.attach_points ??= tool.userData.attachPoints;
        tool.userData.assemblyConnections ??= [];
    }

    syncObjects() {
        this.getObjects().filter(Boolean).forEach(tool => this.registerObject(tool));
        this.connections = this.connections.filter(conn => conn.fromTool?.parent && conn.toTool?.parent);
    }

    hasCapability(tool, capability) {
        return Boolean(tool?.userData?.capabilities?.includes(capability));
    }

    findNearestCompatiblePort(toolA, toolB, maxDistance = this.snapDistance) {
        if (!toolA || !toolB || toolA === toolB) return null;
        const pointsA = pointEntries(toolA);
        const pointsB = pointEntries(toolB);
        let best = null;

        for (const pointA of pointsA) {
            for (const pointB of pointsB) {
                if (!compatible(pointA.type, pointB.type)) continue;
                const worldA = getPointWorldPosition(toolA, pointA);
                const worldB = getPointWorldPosition(toolB, pointB);
                const distance = worldA.distanceTo(worldB);
                if (distance <= maxDistance && (!best || distance < best.distance)) {
                    best = { toolA, pointA, worldA, toolB, pointB, worldB, distance };
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
            }
        });
        if (tool.userData) {
            tool.userData.isAssemblySnapped = false;
            tool.userData.assemblyAnchorTool = null;
            tool.userData.isClamped = false;
            tool.userData.clampTool = null;
            tool.userData.isOnSupportStand = false;
            tool.userData.isSnappedToSupport = false;
            tool.userData.supportStand = null;
            tool.userData.isOnHeatingSource = false;
            tool.userData.isSnappedToHeatingSource = false;
            tool.userData.heatingSource = null;
            tool.userData.isUnderSupportStand = false;
        }
    }

    applyConnectionState(connection) {
        if (!connection) return;
        const tools = [connection.fromTool, connection.toTool];
        const support = tools.find(tool => this.hasCapability(tool, 'support') || tool?.userData?.toolType === 'support_stand');
        const heatSource = tools.find(tool => this.hasCapability(tool, 'heat') || tool?.userData?.isHeatingSource === true);
        const container = tools.find(tool => tool?.userData?.toolType === 'container' || this.hasCapability(tool, 'react'));
        const clamp = tools.find(tool => this.hasCapability(tool, 'clamp') && tool !== support);
        const clampedTool = tools.find(tool => tool !== clamp && tool !== support);

        if (connection.connectionType === 'support' && support && container?.userData) {
            container.userData.isOnSupportStand = true;
            container.userData.supportStand = support;
            container.userData.isSnappedToSupport = true;
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
        }
    }

    snapAndConnect(movingTool, fixedTool, match) {
        if (!movingTool || !fixedTool || !match) return null;
        const currentWorld = getObjectWorldPosition(movingTool);
        const delta = match.worldB.clone().sub(match.worldA);
        setObjectWorldPosition(movingTool, currentWorld.add(delta));
        const connection = this.connectTools(
            movingTool,
            match.pointA,
            fixedTool,
            match.pointB,
            { connectionType: connectionTypeFor(match.pointA.type, match.pointB.type) }
        );
        movingTool.userData.isAssemblySnapped = true;
        movingTool.userData.assemblyAnchorTool = fixedTool;
        return connection;
    }

    tryAutoConnect(movingTool, objects = this.getObjects(), options = {}) {
        this.syncObjects();
        const maxDistance = Number(options.maxDistance ?? this.snapDistance);
        let best = null;
        for (const candidate of objects) {
            if (!candidate || candidate === movingTool) continue;
            const match = this.findNearestCompatiblePort(movingTool, candidate, maxDistance);
            if (match && (!best || match.distance < best.distance)) best = match;
        }
        if (!best) return null;
        return this.snapAndConnect(movingTool, best.toolB, best);
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

    hasHeatingPath(container) {
        if (container?.userData?.isHeating && container.userData.heatingSource?.userData?.isHeatingSource) return true;
        if (this.hasPath(container, 'heat', 'heat')) return true;

        const supports = this.getNeighbors(container, 'support').filter(tool => this.hasCapability(tool, 'support'));
        return supports.some(support => this.getNeighbors(support, 'heat').some(source => this.hasCapability(source, 'heat')));
    }

    findActiveHeatingSource(container) {
        const direct = this.getNeighbors(container, 'heat').find(isActiveHeatingSource);
        if (direct) return direct;

        const supports = this.getNeighbors(container, 'support').filter(tool => this.hasCapability(tool, 'support'));
        for (const support of supports) {
            const source = this.getNeighbors(support, 'heat').find(isActiveHeatingSource);
            if (source) return source;
        }
        return null;
    }

    validateReactionSetup(reaction = {}, container = null) {
        const required = reaction.requiredSetup || reaction.required_setup || {};
        const needsContainer = required.container === true;
        const needsHeating = required.heating === true || reactionRequiresHeating(reaction);
        const needsGasCollection = required.gasCollection === true || required.gas_collection === true;
        const needsSupport = required.support === true;
        const needsDroppingFunnel = required.droppingFunnel === true || required.dropping_funnel === true;
        const needsStirring = required.stirring === true;
        const needsClamp = required.clamp === true;

        if (needsContainer && !this.hasCapability(container, 'react') && !this.hasCapability(container, 'contain_liquid')) {
            return { ok: false, missing: 'container', message: 'Cần đặt hóa chất trong dụng cụ chứa phù hợp trước khi thực hiện.' };
        }
        if (needsHeating && !this.hasHeatingPath(container)) {
            return { ok: false, missing: 'heating', message: 'Phản ứng này cần lắp nguồn nhiệt với dụng cụ chứa trước khi thực hiện.' };
        }
        if (needsGasCollection && !this.hasGasCollectionPath(container)) {
            return { ok: false, missing: 'gas_collection', message: 'Cần lắp ống dẫn khí và dụng cụ thu khí trước khi thực hiện.' };
        }
        if (needsSupport && !this.hasPath(container, 'support', 'support')) {
            return { ok: false, missing: 'support', message: 'Cần đặt hoặc kẹp dụng cụ lên giá đỡ trước khi thực hiện.' };
        }
        if (needsClamp && !this.hasPath(container, 'clamp', 'clamp')) {
            return { ok: false, missing: 'clamp', message: 'Can kep giu dung cu truoc khi thuc hien thi nghiem nay.' };
        }
        if (needsDroppingFunnel && !this.hasPath(container, 'drop_liquid', 'liquid')) {
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
