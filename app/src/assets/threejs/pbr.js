import * as three from 'three';

/**
 * Áp dụng vật liệu PBR nâng cao cho dụng cụ thí nghiệm
 */
export function applyAdvancedPBR(model, pbrData) {
    if (!model) return;

    model.traverse((node) => {
        if (node.isMesh) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            
            const newMaterials = materials.map((oldMat) => {
                // Tạo mới vật liệu vật lý
                const physicalMat = new three.MeshPhysicalMaterial();
                
                // CHỈ SAO CHÉP CÁC THUỘC TÍNH CƠ BẢN AN TOÀN
                if (oldMat.color) physicalMat.color.copy(oldMat.color);
                if (oldMat.map) physicalMat.map = oldMat.map;
                if (oldMat.normalMap) {
                    physicalMat.normalMap = oldMat.normalMap;
                    if (oldMat.normalScale) physicalMat.normalScale.copy(oldMat.normalScale);
                }
                if (oldMat.roughnessMap) physicalMat.roughnessMap = oldMat.roughnessMap;
                if (oldMat.metalnessMap) physicalMat.metalnessMap = oldMat.metalnessMap;
                if (oldMat.aoMap) physicalMat.aoMap = oldMat.aoMap;

                // 1. TỐI ƯU HÓA CÁC MAPS
                const maps = ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap'];
                maps.forEach(mapName => {
                    if (physicalMat[mapName]) {
                        physicalMat[mapName].anisotropy = 16;
                        if (mapName === 'map') {
                            physicalMat[mapName].colorSpace = three.SRGBColorSpace;
                        }
                    }
                });

                // 2. CÂN CHỈNH MÀU SẮC (Sử dụng màu chính xác từ Pixel Analysis)
                const aiColor = new three.Color(pbrData.material_color || "#ffffff");
                
                if (physicalMat.map) {
                    // Nếu có texture, ta dùng màu để nhuộm (tint) nhưng không làm mất texture hoàn toàn
                    if (pbrData.material_color && pbrData.material_color.toLowerCase() !== "#ffffff") {
                        // Nhuộm màu với tỉ lệ nhất định để giữ chi tiết texture
                        physicalMat.color.copy(aiColor).lerp(new three.Color("#ffffff"), 0.2);
                    } else {
                        physicalMat.color.set("#ffffff");
                    }
                } else {
                    physicalMat.color.copy(aiColor);
                }
                
                // 3. THÔNG SỐ PBR
                physicalMat.roughness = pbrData.roughness !== undefined ? parseFloat(pbrData.roughness) : (oldMat.roughness || 0.4);
                physicalMat.metalness = pbrData.metalness !== undefined ? parseFloat(pbrData.metalness) : (oldMat.metalness || 0.0);
                physicalMat.clearcoat = pbrData.clearcoat !== undefined ? parseFloat(pbrData.clearcoat) : 0.1; // Bớt bóng lóng lánh
                physicalMat.clearcoatRoughness = 0.4; // Làm nhòe bóng phản chiếu

                // 4. XỬ LÝ THEO LOẠI CHẤT LIỆU (GLASS, METAL, LIQUID, PLASTIC...)
                const materialType = pbrData.material_type || "OTHER";
                const isGlass = pbrData.is_glass === true || String(pbrData.is_glass).toLowerCase() === 'true';
                const transmission = parseFloat(pbrData.transmission) || 0.0;

                if (materialType === "GLASS" || materialType === "LIQUID" || isGlass || transmission > 0) {
                    // TRIỆT TIÊU HIỆU ỨNG "DÍNH NỀN" & MỜ ĐỤC:
                    physicalMat.map = null;
                    physicalMat.roughnessMap = null;
                    physicalMat.metalnessMap = null;
                    
                    physicalMat.transparent = true;
                    physicalMat.opacity = 1.0;
                    physicalMat.side = three.DoubleSide;
                    physicalMat.depthWrite = true;

                    // SỬ DỤNG ATTENUATION CHO TRONG SUỐT CÓ MÀU (REALISTIC)
                    // Nhuộm nhẹ bề mặt bằng màu hóa chất để màu sắc hiện rõ nét hơn, tránh phản xạ trắng xóa
                    physicalMat.color.copy(aiColor).lerp(new three.Color("#ffffff"), 0.5); 
                    physicalMat.attenuationColor.copy(aiColor); 

                    if (materialType === "LIQUID") {
                        physicalMat.transmission = 0.75; // Giảm truyền sáng một chút để màu cô đặc và đậm rõ
                        physicalMat.roughness = 0.25;     // Tăng nhám bề mặt chất lỏng để bớt bóng lóa
                        physicalMat.ior = 1.33;
                        physicalMat.thickness = 1.0;
                        physicalMat.attenuationDistance = 0.15; // Màu đậm đà hơn
                    } else {
                        // Mặc định là GLASS
                        physicalMat.transmission = 0.65; // Giảm bớt trong suốt để thấy rõ màu thủy tinh của chai lọ
                        physicalMat.roughness = 0.35;     // Tăng nhám thủy tinh (mờ satin) để loại bỏ độ lóng lánh chói lóa
                        physicalMat.ior = 1.45;
                        physicalMat.thickness = 0.25;
                        physicalMat.attenuationDistance = 0.4;
                    }
                } else if (materialType === "METAL") {
                    physicalMat.metalness = 1.0;
                    physicalMat.roughness = Math.min(physicalMat.roughness, 0.2);
                }

                return physicalMat;
            });

            node.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });
    model.userData.isInteractable = true;
}