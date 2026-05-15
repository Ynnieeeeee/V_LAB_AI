import * as THREE from 'three';

export class PouringEffect {
    constructor(scene) {
        this.scene = scene;
        this.particles = [];
        this.isPouring = false;
        this.color = 0xffffff;
        
        // Tạo buffer geometry cho hiệu ứng hạt (Tăng kích thước lên 0.02)
        this.geometry = new THREE.SphereGeometry(0.02, 4, 4);
        this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 });
    }

    start(position, color) {
        this.isPouring = true;
        this.color = color;
        this.material.color.set(color);
        this.spawnPos = position;
    }

    stop() {
        this.isPouring = false;
    }

    update() {
        if (this.isPouring) {
            // Sinh ra 5 hạt mỗi khung hình (Tăng từ 2 lên 5)
            for(let i=0; i<5; i++) {
                const p = new THREE.Mesh(this.geometry, this.material.clone());
                p.position.copy(this.spawnPos);
                // Thêm một chút độ lệch ngẫu nhiên
                p.position.x += (Math.random() - 0.5) * 0.02;
                this.scene.add(p);
                this.particles.push({ mesh: p, velocity: new THREE.Vector3(0, -0.05, 0) });
            }
        }

        // Cập nhật vị trí các hạt đang rơi
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.velocity.y -= 0.002; // Trọng lực
            p.mesh.position.add(p.velocity);
            
            // Xóa hạt nếu rơi quá thấp hoặc sau một khoảng thời gian
            if (p.mesh.position.y < 0 || p.mesh.scale.x < 0.1) {
                this.scene.remove(p.mesh);
                this.particles.splice(i, 1);
            }
        }
    }
}