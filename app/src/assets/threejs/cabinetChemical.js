import * as THREE from 'three';
import { registerDraggableObject } from './interaction.js?v=20260628-smooth-save-v1';
import { drawFittedTextBlock } from './canvasTextLayout.js?v=20260622-label-fit-v1';

export async function setupChemicalCabinet(scene, bottleModel, bookcaseModel) {
    try {
        const token = localStorage.getItem('access_token');
        if (!token) {
            console.warn('Missing access token, skip loading chemical cabinet.');
            return;
        }

        const response = await fetch('/api/cabinet/chemicals', {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        if (!response.ok) {
            let detail = `Backend returned ${response.status} while loading chemicals`;
            try {
                const payload = await response.json();
                detail = payload?.detail || detail;
            } catch (_) {}
            console.warn(detail);
            return;
        }

        const chemicals = await response.json();
        if (!Array.isArray(chemicals)) {
            console.warn('Chemical cabinet response is not a list:', chemicals);
            return;
        }
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
            const bottleScale = new THREE.Vector3(0.2, 0.2, 0.2);
            const displayBottleScale = bottleScale.clone().multiplyScalar(bookcaseModel?.scale?.x || 1);
            bottle.scale.copy(bottleScale);

            const yOffset = 0.89;
            const yPos_local = (shelfPositionsY[shelf] !== undefined ? shelfPositionsY[shelf] : (shelfHeights[0] || 0.42)) + yOffset;

            const zPos_local = (shelfCount[shelf] * 0.2) - 1.8;
            const xPos_local = 0.4;

            bottle.position.set(xPos_local, yPos_local, zPos_local);

            bottle.userData = {
                id_chemical: chem.id_chemical,

                chemicalName: chem.name_vi,

                chemical_type: chem.chemical_type,
                chemicalType: chem.chemical_type,

                name_vi: chem.name_vi,
                formula: chem.formula,
                safety: chem.safery_info,

                // Trạng thái vật lý từ CSDL: "Rắn", "Lỏng", "Khí"...
                // Frontend dùng trường này để quyết định rót dạng bột/hạt hay dòng lỏng.
                physical_state: chem.physical_state,
                physicalState: chem.physical_state,
                state: chem.physical_state,

                isInteractable: true,

                color: chem.material_color,

                customScale: bottleScale.clone(),
                customWorldScale: displayBottleScale.clone(),
                originalWorldScale: displayBottleScale.clone(),
                hasCustomScale: true,
            };

            // 1. GIỮ NGUYÊN VẬT LIỆU GỐC VÀ TÔ MÀU THEO CSDL
            bottle.traverse((child) => {
                if (child.isMesh) {
                    child.material.transparent = true;
                    child.material.opacity = 0.95;
                    child.material.roughness = 0.45; // Tăng nhám để bớt lóng lánh, màu rõ hơn
                    child.material.metalness = 0.05; // Giảm kim loại hóa

                    // Tô màu đặc trưng từ CSDL để dễ phân biệt
                    if (chem.material_color) {
                        child.material.color.set(new THREE.Color(chem.material_color));
                    }
                }
            });

            // 2. TẠO NHÃN TÊN NỔI (TEXT SPRITE) TRÊN ĐẦU LỌ
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 512;
            canvas.height = 128;
            context.fillStyle = 'rgba(0, 0, 0, 0.75)'; // Nền đen đậm rõ nét hơn
            context.beginPath();
            if (context.roundRect) {
                context.roundRect(0, 0, 512, 128, 20);
                context.fill();
            } else {
                context.fillRect(0, 0, 512, 128);
            }
            context.fillStyle = 'white';
            drawFittedTextBlock(context, chem.name_vi || 'Hóa chất', {
                x: 256,
                y: 10,
                maxWidth: 472,
                maxHeight: 108,
                maxFontSize: 60,
            });

            const labelTexture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(0.9, 0.22, 1); // Phóng to nhãn nổi
            sprite.position.set(0, 0.75, 0); // Bay cao hơn một chút để tránh chạm nắp lọ
            bottle.add(sprite);

            // 3. TẠO NHÃN DÁN TRỰC TIẾP LÊN THÂN LỌ (DECAL LABEL)
            const decalCanvas = document.createElement('canvas');
            const decalCtx = decalCanvas.getContext('2d');
            decalCanvas.width = 256;
            decalCanvas.height = 256;

            // Vẽ nền nhãn trắng
            decalCtx.fillStyle = 'white';
            decalCtx.fillRect(0, 0, 256, 256);
            decalCtx.strokeStyle = '#000'; // Viền đen đậm tương phản cao
            decalCtx.lineWidth = 16; // Viền dày hơn để nổi bật nhãn
            decalCtx.strokeRect(8, 8, 240, 240);

            // Ghi tên và công thức
            decalCtx.fillStyle = 'black';
            drawFittedTextBlock(decalCtx, chem.formula || '', {
                x: 128,
                y: 28,
                maxWidth: 208,
                maxHeight: 76,
                maxFontSize: 55,
            });
            drawFittedTextBlock(decalCtx, chem.name_vi || 'Hóa chất', {
                x: 128,
                y: 116,
                maxWidth: 208,
                maxHeight: 112,
                maxFontSize: 28,
            });

            const decalTex = new THREE.CanvasTexture(decalCanvas);
            const decalMat = new THREE.MeshStandardMaterial({ map: decalTex, side: THREE.DoubleSide });
            const decalGeo = new THREE.PlaneGeometry(0.48, 0.48); // Tăng kích thước nhãn dán trên thân
            const decalMesh = new THREE.Mesh(decalGeo, decalMat);

            // Đặt nhãn ở mặt trước của lọ (Local X là mặt trước do xoay -90 độ)
            decalMesh.position.set(0.26, 0, 0); // Đẩy nhẹ ra ngoài để tránh trùng mesh thân lọ
            decalMesh.rotation.y = Math.PI / 2; // Xoay nhãn để hướng ra ngoài
            bottle.add(decalMesh);

            // Thêm vào tủ
            bookcaseModel.add(bottle);
            bottle.updateMatrixWorld(true);

            const cabinetWorldPosition = new THREE.Vector3();
            const cabinetWorldQuaternion = new THREE.Quaternion();
            const cabinetWorldScale = new THREE.Vector3();
            bottle.getWorldPosition(cabinetWorldPosition);
            bottle.getWorldQuaternion(cabinetWorldQuaternion);
            bottle.getWorldScale(cabinetWorldScale);

            bottle.userData.cabinetParent = bookcaseModel;
            bottle.userData.cabinetShelfNumber = shelf;
            bottle.userData.cabinetSlotIndex = shelfCount[shelf];
            bottle.userData.cabinetLocalPosition = bottle.position.clone();
            bottle.userData.cabinetLocalQuaternion = bottle.quaternion.clone();
            bottle.userData.cabinetLocalScale = bottle.scale.clone();
            bottle.userData.cabinetWorldPosition = cabinetWorldPosition.clone();
            bottle.userData.cabinetWorldQuaternion = cabinetWorldQuaternion.clone();
            bottle.userData.cabinetWorldScale = cabinetWorldScale.clone();
            bottle.userData.isInCabinet = true;

            shelfCount[shelf]++;
            registerDraggableObject(bottle);
        });

        console.log("Tủ hóa chất đã sẵn sàng!");
    } catch (error) {
        console.error("Lỗi thiết lập tủ:", error);
    }
}
