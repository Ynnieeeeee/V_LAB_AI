import * as three from 'three';

const ROOM_SIZE = 20;
const TABLE_TOP_HEIGHT = 1.5;
const TABLE_TOP_THICKNESS = 0.2;

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
    const roomSize = ROOM_SIZE;
    const roomGeometry = new three.BoxGeometry(roomSize, 10, roomSize);
    const roomMaterial = new three.MeshStandardMaterial({
        color: 0xCFECF3,
        side: three.BackSide,
        roughness: 0.8
    });
    const room = new three.Mesh(roomGeometry, roomMaterial);
    room.position.y = 4.9;
    room.receiveShadow = true;
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
    window.labRoomBounds = {
        minX: -roomSize / 2,
        maxX: roomSize / 2,
        minZ: -roomSize / 2,
        maxZ: roomSize / 2
    };

    const grid = new three.GridHelper(roomSize, roomSize, 0xCFECF3, 0x1e293b);
    grid.position.y = 0.01;
    scene.add(grid);

    return { room, tableGroup, grid };
}
