import * as THREE from 'three';

/**
 * PrecipitateSystem
 * - Tạo kết tủa trong LOCAL SPACE của dụng cụ, không spawn trực tiếp ra scene.
 * - Vì là child của container nên kết tủa luôn bám theo cốc/ống nghiệm khi cầm, thả, xoay.
 */
export class PrecipitateSystem {
    constructor(scene) {
        this.scene = scene;
        this.layers = new WeakMap();
        this.active = new Set();
    }

    ensureLayer(container, layerName = 'precipitateLayer') {
        if (!container) return null;
        let layer = container.getObjectByName(layerName);
        if (!layer) {
            layer = new THREE.Group();
            layer.name = layerName;
            layer.userData.isReactionEffect = true;
            layer.userData.notDraggable = true;
            layer.userData.ignoreRaycast = true;
            container.add(layer);
        }
        this.layers.set(container, layer);
        return layer;
    }

    getCavityInfo(container) {
        const box = new THREE.Box3();
        const inv = container.matrixWorld.clone().invert();
        container.updateMatrixWorld(true);

        let hasMesh = false;
        container.traverse(child => {
            if (!child.isMesh) return;
            if (child.name === 'fluid_volume') return;
            if (child.userData?.isReactionEffect) return;
            const childBox = new THREE.Box3().setFromObject(child);
            if (!childBox.isEmpty()) {
                box.union(childBox);
                hasMesh = true;
            }
        });

        if (!hasMesh || box.isEmpty()) {
            box.setFromObject(container);
        }

        const min = box.min.clone().applyMatrix4(inv);
        const max = box.max.clone().applyMatrix4(inv);
        const sizeX = Math.max(0.04, Math.abs(max.x - min.x));
        const sizeY = Math.max(0.08, Math.abs(max.y - min.y));
        const sizeZ = Math.max(0.04, Math.abs(max.z - min.z));

        const liquidLevel = THREE.MathUtils.clamp(container.userData?.liquidLevel ?? 0.35, 0.05, 0.9);
        const bottomY = Math.min(min.y, max.y) + sizeY * 0.10;
        const surfaceY = bottomY + sizeY * liquidLevel * 0.62;

        return {
            centerX: (min.x + max.x) * 0.5,
            centerZ: (min.z + max.z) * 0.5,
            bottomY,
            surfaceY,
            radiusX: sizeX * 0.28,
            radiusZ: sizeZ * 0.28,
            height: Math.max(0.04, surfaceY - bottomY)
        };
    }

    create(container, options = {}) {
        if (!container) return null;

        const color = options.color || options.precipitateColor || '#ffffff';
        const amount = Math.floor(options.amount ?? 620);
        const size = options.size ?? 0.011;
        const layer = this.ensureLayer(container);
        if (!layer) return null;

        const info = this.getCavityInfo(container);
        const positions = new Float32Array(amount * 3);
        const velocities = new Float32Array(amount * 3);

        for (let i = 0; i < amount; i++) {
            const r = Math.sqrt(Math.random());
            const a = Math.random() * Math.PI * 2;
            const y = THREE.MathUtils.lerp(info.surfaceY, info.bottomY, Math.random() * Math.random());

            positions[i * 3] = info.centerX + Math.cos(a) * r * info.radiusX;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = info.centerZ + Math.sin(a) * r * info.radiusZ;

            velocities[i * 3] = (Math.random() - 0.5) * 0.002;
            velocities[i * 3 + 1] = -0.003 - Math.random() * 0.006;
            velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.002;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.PointsMaterial({
            color,
            size,
            sizeAttenuation: true,
            transparent: true,
            opacity: options.opacity ?? 0.96,
            depthWrite: true
        });

        const points = new THREE.Points(geometry, material);
        points.name = options.name || 'precipitate_inside_container';
        points.userData.isReactionEffect = true;
        points.userData.notDraggable = true;
        points.userData.ignoreRaycast = true;
        points.userData.velocities = velocities;
        points.userData.cavityInfo = info;
        points.userData.settling = options.settling !== false;
        points.userData.life = 0;

        layer.add(points);
        this.active.add(points);
        return points;
    }

    update(dt = 1 / 60) {
        for (const points of Array.from(this.active)) {
            if (!points.parent) {
                this.active.delete(points);
                continue;
            }

            const attr = points.geometry.getAttribute('position');
            const pos = attr.array;
            const vel = points.userData.velocities;
            const info = points.userData.cavityInfo;
            points.userData.life += dt;

            if (!points.userData.settling) continue;

            for (let i = 0; i < attr.count; i++) {
                const iy = i * 3 + 1;
                if (pos[iy] > info.bottomY + 0.01) {
                    pos[i * 3] += vel[i * 3] * dt * 60;
                    pos[iy] += vel[iy] * dt * 60;
                    pos[i * 3 + 2] += vel[i * 3 + 2] * dt * 60;
                } else {
                    pos[iy] = info.bottomY + Math.random() * 0.018;
                }
            }
            attr.needsUpdate = true;
        }
    }

    clear(container) {
        const layer = container?.getObjectByName?.('precipitateLayer');
        if (!layer) return;
        for (const child of [...layer.children]) {
            this.active.delete(child);
            child.geometry?.dispose?.();
            child.material?.dispose?.();
            layer.remove(child);
        }
    }
}

export default PrecipitateSystem;
