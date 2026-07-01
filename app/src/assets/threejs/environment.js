import * as three from 'three';

export const DEFAULT_ROOM_SIZE = 20;
export const MIN_ROOM_SIZE = 20;
export const MAX_ROOM_SIZE = 60;
const ROOM_HEIGHT = 10;
const ROOM_CENTER_Y = 4.9;
const TABLE_TOP_HEIGHT = 1.5;
const TABLE_TOP_THICKNESS = 0.2;

const environmentState = {
    scene: null,
    room: null,
    grid: null,
    tableGroup: null,
    roomSize: DEFAULT_ROOM_SIZE
};

export function normalizeRoomSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_ROOM_SIZE;
    const clamped = Math.min(MAX_ROOM_SIZE, Math.max(MIN_ROOM_SIZE, numeric));
    return Math.round(clamped * 10) / 10;
}

function disposeMaterial(material) {
    if (Array.isArray(material)) {
        material.forEach(item => item?.dispose?.());
        return;
    }
    material?.dispose?.();
}

function disposeMesh(mesh) {
    mesh?.geometry?.dispose?.();
    disposeMaterial(mesh?.material);
}

function applyRoomGlobals(roomSize) {
    const halfSize = roomSize / 2;
    window.labRoomSize = roomSize;
    window.labRoomBounds = {
        minX: -halfSize,
        maxX: halfSize,
        minZ: -halfSize,
        maxZ: halfSize,
        size: roomSize
    };
}

function createRoomMesh(roomSize) {
    const roomGeometry = new three.BoxGeometry(roomSize, ROOM_HEIGHT, roomSize);
    const roomMaterial = new three.MeshStandardMaterial({
        color: 0xCFECF3,
        side: three.BackSide,
        roughness: 0.8
    });
    const room = new three.Mesh(roomGeometry, roomMaterial);
    room.position.y = ROOM_CENTER_Y;
    room.receiveShadow = true;
    // The inside of this box is also the visible floor/walls/ceiling. Mark it
    // explicitly so XR gaze selection treats it as scenery, never as a tool.
    room.userData.isRoomSurface = true;
    return room;
}

function createRoomGrid(roomSize) {
    const divisions = Math.max(1, Math.round(roomSize));
    const grid = new three.GridHelper(roomSize, divisions, 0xCFECF3, 0x1e293b);
    grid.position.y = 0.01;
    return grid;
}

export function getLabRoomSize() {
    return environmentState.roomSize;
}

export function setLabRoomSize(value, options = {}) {
    const previousSize = environmentState.roomSize;
    const roomSize = normalizeRoomSize(value);
    environmentState.roomSize = roomSize;
    applyRoomGlobals(roomSize);

    if (environmentState.room) {
        environmentState.room.geometry?.dispose?.();
        environmentState.room.geometry = new three.BoxGeometry(roomSize, ROOM_HEIGHT, roomSize);
        environmentState.room.position.y = ROOM_CENTER_Y;
        environmentState.room.updateMatrixWorld(true);
    }

    if (environmentState.scene) {
        if (environmentState.grid) {
            environmentState.scene.remove(environmentState.grid);
            disposeMesh(environmentState.grid);
        }
        environmentState.grid = createRoomGrid(roomSize);
        environmentState.scene.add(environmentState.grid);
    }

    if (options.silent !== true && previousSize !== roomSize) {
        window.dispatchEvent(new CustomEvent('lab:room-size-changed', {
            detail: {
                roomSize,
                previousSize,
                bounds: window.labRoomBounds
            }
        }));
    }

    return roomSize;
}

export function createLabTable(options = {}) {
    const {
        width = 8,
        depth = 4,
        legHeight = TABLE_TOP_HEIGHT,
        topThickness = TABLE_TOP_THICKNESS,
        topColor = 0x1e293b,
        legColor = 0x0f172a,
        metalness = 0.3,
        roughness = 0.1,
        isMovable = false,
        name = isMovable ? 'Movable lab table' : 'Main lab table'
    } = options;

    const tableGroup = new three.Group();
    tableGroup.name = name;
    tableGroup.userData.isTable = true;
    tableGroup.userData.isRoomBlocker = true;
    tableGroup.userData.tableWidth = width;
    tableGroup.userData.tableDepth = depth;
    tableGroup.userData.tableSurfaceY = legHeight + (topThickness / 2);

    if (isMovable) {
        tableGroup.userData.isMovableTable = true;
        tableGroup.userData.isFurniture = true;
        tableGroup.userData.name_vi = 'B\u00e0n th\u00ed nghi\u1ec7m';
        tableGroup.userData.name_tool_vi = 'B\u00e0n th\u00ed nghi\u1ec7m';
        tableGroup.userData.canRestOnFloor = true;
    }

    const tableTopGeo = new three.BoxGeometry(width, topThickness, depth);
    const tableTopMat = new three.MeshStandardMaterial({
        color: topColor,
        roughness,
        metalness
    });
    const tableTop = new three.Mesh(tableTopGeo, tableTopMat);
    tableTop.name = 'table_top';
    tableTop.position.y = legHeight;
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;
    tableGroup.add(tableTop);

    const legRadius = Math.max(0.07, Math.min(width, depth) * 0.025);
    const legGeo = new three.CylinderGeometry(legRadius, legRadius, legHeight);
    const legMat = new three.MeshStandardMaterial({ color: legColor });
    const insetX = Math.max(0.2, legRadius * 2);
    const insetZ = Math.max(0.2, legRadius * 2);
    const legPositions = [
        [-(width / 2 - insetX), legHeight / 2, -(depth / 2 - insetZ)],
        [width / 2 - insetX, legHeight / 2, -(depth / 2 - insetZ)],
        [-(width / 2 - insetX), legHeight / 2, depth / 2 - insetZ],
        [width / 2 - insetX, legHeight / 2, depth / 2 - insetZ]
    ];

    legPositions.forEach(pos => {
        const leg = new three.Mesh(legGeo, legMat);
        leg.name = 'table_leg';
        leg.position.set(...pos);
        leg.castShadow = true;
        leg.receiveShadow = true;
        tableGroup.add(leg);
    });

    return tableGroup;
}

export function initEnvironment(scene) {
    const pendingLayout = window.pendingLabRoomLayout || {};
    const roomSize = normalizeRoomSize(window.pendingLabRoomSize || pendingLayout.room_size || pendingLayout.roomSize || DEFAULT_ROOM_SIZE);
    const room = createRoomMesh(roomSize);
    scene.add(room);

    const loader = new three.CubeTextureLoader();
    scene.environment = loader.load([
        'https://threejs.org/examples/textures/cube/pisa/px.png',
        'https://threejs.org/examples/textures/cube/pisa/nx.png',
        'https://threejs.org/examples/textures/cube/pisa/py.png',
        'https://threejs.org/examples/textures/cube/pisa/ny.png',
        'https://threejs.org/examples/textures/cube/pisa/pz.png',
        'https://threejs.org/examples/textures/cube/pisa/nz.png'
    ]);

    const tableGroup = createLabTable({ width: 8, depth: 4, name: 'Main lab table' });
    scene.add(tableGroup);

    window.labTables = [tableGroup];
    window.tableObject = tableGroup;
    window.labTable = tableGroup;
    window.TABLE_Y = tableGroup.userData.tableSurfaceY;
    applyRoomGlobals(roomSize);

    const grid = createRoomGrid(roomSize);
    scene.add(grid);

    environmentState.scene = scene;
    environmentState.room = room;
    environmentState.grid = grid;
    environmentState.tableGroup = tableGroup;
    environmentState.roomSize = roomSize;

    return { room, tableGroup, grid };
}
