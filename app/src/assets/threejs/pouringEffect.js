import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';

/**
 * Lớp hiệu ứng chất lỏng đổ cao cấp sử dụng Dynamic Morphing Mesh và Marching Cubes.
 */
export class PouringEffect {
    constructor(scene) {
        this.scene = scene;
        this.isPouring = false;
        this.color = new THREE.Color(0xffffff);
        
        // 1. Dòng chảy (Stream) - Sử dụng TubeGeometry + Custom Shader
        this.streamGeometry = null;
        this.streamMaterial = this.createStreamMaterial();
        this.streamMesh = null;
        
        // 2. Khối nước trong cốc (Volume) - Sử dụng Marching Cubes
        this.volumes = new Map(); // Lưu trữ MarchingCubes cho mỗi dụng cụ
        
        // Cấu hình vật lý ảo
        this.flowRate = 0.05;
        this.gravity = 9.8;
        this.time = 0;
    }

    createStreamMaterial() {
        // Sử dụng MeshPhysicalMaterial để có phản chiếu và ánh sáng chân thực nhất
        const material = new THREE.MeshPhysicalMaterial({
            color: this.color,
            transparent: true,
            opacity: 0.95,
            transmission: 0.1, // Hơi trong nhẹ nhưng vẫn giữ được khối màu
            roughness: 0.1,
            metalness: 0,
            ior: 1.45,
            thickness: 0.5,
            specularIntensity: 1.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05
        });

        // Tạo texture gợn sóng chạy dọc để tạo cảm giác chảy
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, 'rgba(255,255,255,0.1)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
        grad.addColorStop(1, 'rgba(255,255,255,0.1)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 256);
        
        const flowTexture = new THREE.CanvasTexture(canvas);
        flowTexture.wrapS = flowTexture.wrapT = THREE.RepeatWrapping;
        material.alphaMap = flowTexture;
        material.alphaTest = 0.01;
        
        this.flowTexture = flowTexture;
        return material;
    }

    start(startPos, color) {
        this.isPouring = true;
        this.color.set(color);
        if (this.streamMaterial.color) {
            this.streamMaterial.color.set(color);
        }
        this.spawnPos = startPos.clone();
    }

    stop() {
        this.isPouring = false;
        if (this.streamMesh) {
            this.scene.remove(this.streamMesh);
            this.streamMesh = null;
        }
    }

    /**
     * Tạo hoặc cập nhật Marching Cubes cho một dụng cụ (cốc/ống nghiệm)
     */
    getOrCreateVolume(target) {
        if (this.volumes.has(target)) return this.volumes.get(target);

        // Tạo Marching Cubes container
        const resolution = 28; // Tăng độ phân giải cho mượt
        const size = 0.4;
        const volume = new MarchingCubes(resolution, new THREE.MeshPhysicalMaterial({
            color: this.color.clone(),
            transparent: true,
            opacity: 0.9,
            transmission: 0.9,
            ior: 1.33,
            thickness: 0.5,
            roughness: 0.05,
            metalness: 0,
            envMapIntensity: 1.5
        }), true, true, 100000);

        volume.scale.set(size, size, size);
        volume.name = "fluid_volume";
        
        // Căn chỉnh vị trí trong dụng cụ
        const box = new THREE.Box3().setFromObject(target);
        const center = new THREE.Vector3();
        box.getCenter(center);
        volume.position.copy(center);
        volume.position.y = box.min.y + 0.05;

        this.scene.add(volume);
        this.volumes.set(target, volume);
        
        target.userData.liquidLevel = 0;
        return volume;
    }

    update(targetPos) {
        this.time += 0.016;
        
        // Cập nhật hoạt ảnh chảy bằng texture offset
        if (this.flowTexture) {
            this.flowTexture.offset.y -= 0.05;
        }

        if (this.isPouring) {
            const end = targetPos ? targetPos.clone() : this.spawnPos.clone().add(new THREE.Vector3(0, -1.5, 0));
            this.updateStream(this.spawnPos, end);
        } else if (this.streamMesh) {
            this.scene.remove(this.streamMesh);
            this.streamMesh = null;
        }

        // Cập nhật gợn sóng cho các khối nước hiện có
        this.volumes.forEach((volume, target) => {
            this.updateVolumeEffect(volume, target);
        });
    }

    updateStream(start, end) {
        const distance = start.distanceTo(end);
        const mid = start.clone().lerp(end, 0.5);
        mid.y += distance * 0.05; 

        const curve = new THREE.CatmullRomCurve3([start, mid, end]);
        
        if (this.streamMesh) this.scene.remove(this.streamMesh);
        
        const geometry = new THREE.TubeGeometry(curve, 16, 0.03, 8, false); // Tăng độ mịn và bán kính
        this.streamMesh = new THREE.Mesh(geometry, this.streamMaterial);
        
        // Đảm bảo dòng chảy nhận đúng màu từ thuộc tính material
        this.streamMesh.material.color.copy(this.color);
        
        this.scene.add(this.streamMesh);
    }



    updateVolumeEffect(volume, target) {
        volume.reset();
        
        const level = target.userData.liquidLevel || 0;
        if (level <= 0) return;

        // Cập nhật màu sắc nếu có thay đổi
        volume.material.color.copy(this.color);

        // Marching Cubes hoạt động bằng cách thêm các "Balls"
        // Ta tạo một lớp bề mặt phẳng bằng cách rải nhiều ball nhỏ ở cùng độ cao
        const count = 5;
        const strength = 0.4;
        const subtract = 12;

        for (let i = 0; i < count; i++) {
            for (let j = 0; j < count; j++) {
                const x = (i / (count - 1)); // 0 to 1
                const z = (j / (count - 1)); // 0 to 1
                
                // Thêm nhiễu để mặt nước gợn sóng
                const noise = Math.sin(this.time * 5 + i * 0.5 + j * 0.5) * 0.01;
                const y = level + noise; // 0 to 1

                volume.addBall(x, y, z, strength, subtract);
            }
        }
        
        // Thêm một ball lớn hơn tại điểm đổ để tạo hiệu ứng gợn mạnh
        if (this.isPouring) {
            volume.addBall(0.5, level + 0.05, 0.5, 0.6, subtract);
        }
    }

    emit(currentPos) {
        // Cập nhật điểm bắt đầu dòng chảy
        if (currentPos) this.spawnPos.copy(currentPos);
    }
}