import * as three from 'three';

/**
 * Khởi tạo môi trường phòng thí nghiệm (Phòng, Bàn, Lưới sàn)
 * @param {three.Scene} scene - Scene chính để thêm các đối tượng
 */
export function initEnvironment(scene) {
    // Tạo phòng
    const roomSize = 20;
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

    // 1. CẤU HÌNH ENVIRONMENT MAP (QUAN TRỌNG CHO PBR)
    // Tạo environment từ một CubeTexture đơn giản hoặc Environment sẵn có
    const loader = new three.CubeTextureLoader();
    // Sử dụng màu nền và phản chiếu môi trường để tạo độ bóng cho kim loại/thủy tinh
    scene.environment = loader.load([
        'https://threejs.org/examples/textures/cube/pisa/px.png',
        'https://threejs.org/examples/textures/cube/pisa/nx.png',
        'https://threejs.org/examples/textures/cube/pisa/py.png',
        'https://threejs.org/examples/textures/cube/pisa/ny.png',
        'https://threejs.org/examples/textures/cube/pisa/pz.png',
        'https://threejs.org/examples/textures/cube/pisa/nz.png'
    ]);

    // Tạo bàn
    const tableGroup = new three.Group();
    tableGroup.userData.isTable = true; // QUAN TRỌNG: Để nhận diện bàn

    // Mặt bàn
    const tableTopGeo = new three.BoxGeometry(8, 0.2, 4); 
    const tableTopMat = new three.MeshStandardMaterial({ 
        color: 0x1e293b, 
        roughness: 0.1,
        metalness: 0.3 
    });
    const tableTop = new three.Mesh(tableTopGeo, tableTopMat);
    tableTop.position.y = 1.5;
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;
    tableGroup.add(tableTop);

    // Chân bàn
    const legGeo = new three.CylinderGeometry(0.1, 0.1, 1.5);
    const legMat = new three.MeshStandardMaterial({ color: 0x0f172a });
    const legPositions = [
        [-3.8, 0.75, -1.8], [3.8, 0.75, -1.8],
        [-3.8, 0.75, 1.8], [3.8, 0.75, 1.8]
    ];

    legPositions.forEach(pos => {
        const leg = new three.Mesh(legGeo, legMat);
        leg.position.set(...pos);
        tableGroup.add(leg);
    });

    scene.add(tableGroup);

    // Sàn
    const grid = new three.GridHelper(20, 20, 0xCFECF3, 0x1e293b);
    grid.position.y = 0.01;
    scene.add(grid);

    return { room, tableGroup, grid };
}