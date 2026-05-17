import * as THREE from 'three';
import { registerDraggableObject } from './interaction.js';

export async function setupChemicalCabinet(scene, bottleModel, bookcaseModel) {
    try {
        const response = await fetch('/api/cabinet/chemicals');
        const chemicals = await response.json();
        const textureLoader = new THREE.TextureLoader();

        // --- TỰ ĐỘNG DÒ TÌM TỌA ĐỘ Y CỦA CÁC TẦNG KỆ ---
        let shelfHeights = [];
        bookcaseModel.updateMatrixWorld(true);

        bookcaseModel.traverse((child) => {
            if (child.isMesh) {
                // Tính toán bounding box của từng bộ phận trong tủ
                const box = new THREE.Box3().setFromObject(child);
                const size = box.getSize(new THREE.Vector3());

                // Điều kiện nới lỏng hơn để nhận diện kệ
                if (size.y < 0.2 && (size.x > 0.3 || size.z > 0.3)) {
                    const worldY = box.max.y;
                    const localPos = bookcaseModel.worldToLocal(new THREE.Vector3(0, worldY, 0));

                    // Tránh lấy trùng các mặt phẳng ở cùng một độ cao (sai số 0.05)
                    if (!shelfHeights.some(h => Math.abs(h - localPos.y) < 0.05)) {
                        shelfHeights.push(localPos.y);
                    }
                }
            }
        });

        shelfHeights.sort((a, b) => a - b);

        // CHỈ LẤY 4 NGĂN (Giữ nguyên logic của bạn nhưng giới hạn 4 tầng)
        if (shelfHeights.length > 4) {
            shelfHeights = shelfHeights.slice(0, 4);
        }

        shelfHeights = [0.3, 0.74, 1.13, 1.55];
        console.log("Đã thiết lập 4 tầng kệ với khoảng cách 0.38:", shelfHeights);

        // Tạo map tọa độ
        const shelfPositionsY = {};
        shelfHeights.forEach((h, index) => {
            shelfPositionsY[index + 1] = h;
        });

        const shelfCount = {};

        chemicals.forEach((chem) => {
            const bottle = bottleModel.clone();
            
            // ÉP VỀ 4 DÃY LỌ
            let shelf = chem.shelf_number || 1;
            if (shelf > 4) shelf = ((shelf - 1) % 4) + 1;

            if (!shelfCount[shelf]) shelfCount[shelf] = 0;

            // GIỮ NGUYÊN CÁC THÔNG SỐ CỦA BẠN
            bottle.scale.set(0.2, 0.2, 0.2);

            const yOffset = 0.89; 
            const yPos_local = (shelfPositionsY[shelf] !== undefined ? shelfPositionsY[shelf] : (shelfHeights[0] || 0.42)) + yOffset;

            const zPos_local = (shelfCount[shelf] * 0.2) - 1.8;
            const xPos_local = 0.4; 

            bottle.position.set(xPos_local, yPos_local, zPos_local);

            // Tối ưu hóa màu sắc hóa chất: Tăng độ bão hòa (Saturation) để màu sắc rực rỡ và rõ ràng hơn
            const chemColor = new THREE.Color(0xffffff);
            if (chem.material_color) {
                chemColor.set(new THREE.Color(chem.material_color));
                const hsl = {};
                chemColor.getHSL(hsl);
                hsl.s = Math.min(1.0, hsl.s * 1.6); // Tăng 60% độ bão hòa màu để màu rực rỡ hơn
                hsl.l = Math.max(0.35, Math.min(0.7, hsl.l * 1.05)); // Đảm bảo độ sáng nằm trong dải trung tính hiển thị đẹp
                chemColor.setHSL(hsl.h, hsl.s, hsl.l);
            }

            // LƯU DỮ LIỆU VÀO USERDATA để Mascot tra cứu khi Click và truyền màu chuẩn khi đổ nước
            bottle.userData = {
                id_chemical: chem.id_chemical,
                name_vi: chem.name_vi,
                formula: chem.formula,
                safety: chem.safery_info,
                isInteractable: true,
                color: chemColor.getHex(), // Sử dụng màu đã được tối ưu rực rỡ
            };

            // 1. TÔ MÀU CHAI VÀ TỐI ƯU HÓA CHẤT LIỆU (THỦY TINH TRONG SUỐT + NẮP CHAI RIÊNG)
            bottle.traverse((child) => {
                if (child.isMesh) {
                    const nameLower = child.name.toLowerCase();
                    const isCap = nameLower.includes('cap') || nameLower.includes('lid') || nameLower.includes('cork') || nameLower.includes('nap') || nameLower.includes('stopper');

                    if (isCap) {
                        // Thiết lập nắp chai có chất liệu nhám mờ màu xám tối thực tế
                        child.material.color.set(0x2d3748);
                        child.material.transparent = false;
                        child.material.opacity = 1.0;
                        child.material.roughness = 0.6;
                        child.material.metalness = 0.1;
                    } else {
                        // Thủy tinh đựng hóa chất trong suốt, bóng bẩy và hiển thị màu sắc rực rỡ
                        child.material.transparent = true;
                        child.material.opacity = 0.8; // Độ trong suốt hợp lý giúp thủy tinh sâu và thật hơn
                        child.material.roughness = 0.05; // Độ nhám cực thấp tạo cảm giác trơn bóng, phản xạ ánh sáng mạnh
                        child.material.metalness = 0.1;
                        child.material.color.copy(chemColor);
                    }
                }
            });

            // 2. TẠO NHÃN TÊN NỔI (TEXT SPRITE) TRÊN ĐẦU LỌ
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 512;
            canvas.height = 128;
            context.fillStyle = 'rgba(0, 0, 0, 0.5)'; // Nền đen mờ
            context.roundRect ? context.roundRect(0, 0, 512, 128, 20) : context.fillRect(0, 0, 512, 128);
            context.fill();
            context.font = 'bold 50px Arial';
            context.fillStyle = 'white';
            context.textAlign = 'center';
            context.fillText(chem.name_vi || 'Hóa chất', 256, 80);

            const labelTexture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(0.5, 0.12, 1);
            sprite.position.set(0, 0.65, 0); // Bay phía trên lọ
            bottle.add(sprite);

            // 3. TẠO NHÃN DÁN TRỰC TIẾP LÊN THÂN LỌ (DECAL LABEL)
            const decalCanvas = document.createElement('canvas');
            const decalCtx = decalCanvas.getContext('2d');
            decalCanvas.width = 256;
            decalCanvas.height = 256;

            // Vẽ nền nhãn trắng
            decalCtx.fillStyle = 'white';
            decalCtx.fillRect(0, 0, 256, 256);
            decalCtx.strokeStyle = '#333';
            decalCtx.lineWidth = 10;
            decalCtx.strokeRect(5, 5, 246, 246);

            // Ghi tên và công thức
            decalCtx.fillStyle = 'black';
            decalCtx.textAlign = 'center';
            decalCtx.font = 'bold 45px Arial';
            decalCtx.fillText(chem.formula || '', 128, 90);
            decalCtx.font = '24px Arial';
            const wrappedName = (chem.name_vi || '').length > 15 ? (chem.name_vi || '').substring(0, 15) + '...' : (chem.name_vi || '');
            decalCtx.fillText(wrappedName, 128, 160);

            const decalTex = new THREE.CanvasTexture(decalCanvas);
            const decalMat = new THREE.MeshStandardMaterial({ map: decalTex, side: THREE.DoubleSide });
            const decalGeo = new THREE.PlaneGeometry(0.35, 0.35);
            const decalMesh = new THREE.Mesh(decalGeo, decalMat);
            
            // Đặt nhãn ở mặt trước của lọ (Local X là mặt trước do xoay -90 độ)
            decalMesh.position.set(0.25, 0, 0); 
            decalMesh.rotation.y = Math.PI / 2; // Xoay nhãn để hướng ra ngoài
            bottle.add(decalMesh);

            // Thêm vào tủ
            bookcaseModel.add(bottle);
            shelfCount[shelf]++;
            registerDraggableObject(bottle);
        });

        console.log("Tủ hóa chất đã sẵn sàng!");
    } catch (error) {
        console.error("Lỗi thiết lập tủ:", error);
    }
}