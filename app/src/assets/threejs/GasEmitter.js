import * as THREE from 'three';

/**
 * GasEmitter
 * - Tạo bọt khí/hơi/khói từ miệng hoặc mặt dung dịch.
 * - Gas là world-space effect nên bay lên tự do, không bị kẹt trong local transform của dụng cụ.
 */
export class GasEmitter {
    constructor(scene) {
        this.scene = scene;
        this.emitters = new Set();
        this.group = new THREE.Group();
        this.group.name = 'gas_emitters_world';
        this.scene.add(this.group);
    }

    getMouthPosition(container, fallbackPosition = null) {
        if (fallbackPosition) return fallbackPosition.clone();
        if (!container) return new THREE.Vector3();
        container.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(container);
        const center = new THREE.Vector3();
        box.getCenter(center);
        center.y = box.max.y + 0.025;
        return center;
    }

    emit(container, options = {}) {
        const position = this.getMouthPosition(container, options.position);
        const color = new THREE.Color(options.color || options.gasColor || '#ffffff');
        const amount = Math.floor(options.amount ?? 90);
        const radius = options.radius ?? 0.20;
        const lifetime = options.lifetime ?? 2.0;
        const bubbleSize = options.size ?? 0.035;
        const mode = options.mode || 'gas';

        const positions = new Float32Array(amount * 3);
        const velocities = new Float32Array(amount * 3);
        const ages = new Float32Array(amount);
        const maxAges = new Float32Array(amount);

        for (let i = 0; i < amount; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius * 0.35;
            positions[i * 3] = position.x + Math.cos(a) * r;
            positions[i * 3 + 1] = position.y + Math.random() * 0.05;
            positions[i * 3 + 2] = position.z + Math.sin(a) * r;

            velocities[i * 3] = (Math.random() - 0.5) * 0.08;
            velocities[i * 3 + 1] = 0.16 + Math.random() * 0.28;
            velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.08;
            ages[i] = Math.random() * 0.25;
            maxAges[i] = lifetime * (0.65 + Math.random() * 0.7);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.PointsMaterial({
            color,
            size: bubbleSize,
            sizeAttenuation: true,
            transparent: true,
            opacity: mode === 'smoke' ? 0.32 : 0.48,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        const points = new THREE.Points(geometry, material);
        points.name = mode === 'smoke' ? 'smoke_from_reaction' : 'gas_from_reaction';
        points.userData.isReactionEffect = true;
        points.userData.notDraggable = true;
        points.userData.ignoreRaycast = true;
        points.userData.velocities = velocities;
        points.userData.ages = ages;
        points.userData.maxAges = maxAges;
        points.userData.origin = position.clone();
        points.userData.radius = radius;
        points.userData.mode = mode;

        this.group.add(points);
        this.emitters.add(points);
        return points;
    }

    bubbles(container, options = {}) {
        return this.emit(container, { ...options, mode: 'gas', size: options.size ?? 0.025, lifetime: options.lifetime ?? 1.5 });
    }

    smoke(container, options = {}) {
        return this.emit(container, { ...options, mode: 'smoke', size: options.size ?? 0.07, lifetime: options.lifetime ?? 2.8, color: options.color || '#d8d8d8' });
    }

    update(dt = 1 / 60) {
        for (const points of Array.from(this.emitters)) {
            if (!points.parent) {
                this.emitters.delete(points);
                continue;
            }

            const attr = points.geometry.getAttribute('position');
            const pos = attr.array;
            const vel = points.userData.velocities;
            const ages = points.userData.ages;
            const maxAges = points.userData.maxAges;
            const origin = points.userData.origin;
            const radius = points.userData.radius;

            let alive = 0;
            for (let i = 0; i < attr.count; i++) {
                ages[i] += dt;
                if (ages[i] > maxAges[i]) continue;
                alive++;

                const ix = i * 3;
                vel[ix] += (Math.random() - 0.5) * 0.015 * dt;
                vel[ix + 2] += (Math.random() - 0.5) * 0.015 * dt;
                pos[ix] += vel[ix] * dt;
                pos[ix + 1] += vel[ix + 1] * dt;
                pos[ix + 2] += vel[ix + 2] * dt;

                const spread = Math.min(1, ages[i] / maxAges[i]) * radius;
                if (Math.abs(pos[ix] - origin.x) > spread) vel[ix] *= -0.25;
                if (Math.abs(pos[ix + 2] - origin.z) > spread) vel[ix + 2] *= -0.25;
            }

            attr.needsUpdate = true;
            points.material.opacity = Math.max(0, alive / attr.count) * (points.userData.mode === 'smoke' ? 0.32 : 0.48);

            if (alive === 0) {
                points.parent.remove(points);
                points.geometry.dispose();
                points.material.dispose();
                this.emitters.delete(points);
            }
        }
    }
}

export default GasEmitter;
