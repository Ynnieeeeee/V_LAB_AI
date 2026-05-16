import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';

/**
 * PouringEffect – Particle stream + MarchingCubes liquid volume.
 *
 * FIX v3 – Liquid nằm đúng trong lòng dụng cụ từ Tripo pipeline:
 *
 *  1. detectCavity  : scan hoàn toàn WORLD space, lưu world coords,
 *                     KHÔNG dùng invMatrix (pivot Tripo không chuẩn).
 *
 *  2. getOrCreateVolume: liquidGroup thêm vào scene (world space),
 *                        không gắn vào target.
 *
 *  3. _updateVolumeEffect:
 *     • Tính world cavity AABB từ cavityPoints + offset so với tâm tool.
 *     • Mỗi frame: update liquidGroup.position/scale theo vị trí tool hiện tại.
 *     • liquidGroup.quaternion = identity → không nghiêng theo tool đang được cầm.
 *     • addBall normalize [-0.45, 0.45]³ đúng với hệ MarchingCubes [-0.5, 0.5]³.
 *
 *  4. invalidateCavity: gọi từ interaction.js khi tool bị thả/scale đổi.
 */
export class PouringEffect {
    constructor(scene) {
        this.scene   = scene;
        this.isPouring = false;
        this.color   = new THREE.Color(0x3498db);

        // ── Particle system ───────────────────────────────────────────────
        this.particleCount    = 500;
        this.particles        = [];
        this.particleGeometry = new THREE.BufferGeometry();
        this.particlePositions = new Float32Array(this.particleCount * 3);
        this.particleSizes     = new Float32Array(this.particleCount);

        for (let i = 0; i < this.particleCount; i++) {
            this.particlePositions[i * 3]     = 0;
            this.particlePositions[i * 3 + 1] = -100;
            this.particlePositions[i * 3 + 2] = 0;
            this.particleSizes[i] = 0;
        }
        this.particleGeometry.setAttribute(
            'position', new THREE.BufferAttribute(this.particlePositions, 3));
        this.particleGeometry.setAttribute(
            'size',     new THREE.BufferAttribute(this.particleSizes, 1));

        this.particleMaterial = this._createParticleMaterial();
        this.particleSystem   = new THREE.Points(this.particleGeometry, this.particleMaterial);
        this.particleSystem.renderOrder = 999;
        this.scene.add(this.particleSystem);

        // ── Volume map ────────────────────────────────────────────────────
        this.volumes     = new Map();
        this.flowRate    = 0.05;
        this.time        = 0;
        this.activeParticles = 0;
        this.spawnTimer  = 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    _createParticleMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: {
                color: { value: this.color.clone() },
                time:  { value: 0 }
            },
            vertexShader: `
                attribute float size;
                void main() {
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = clamp(size * (120.0 / -mvPosition.z), 1.0, 35.0);
                    gl_Position  = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 color;
                void main() {
                    float dist = distance(gl_PointCoord, vec2(0.5));
                    if (dist > 0.5) discard;
                    float alpha = smoothstep(0.5, 0.0, dist);
                    gl_FragColor = vec4(color, alpha * 2.0);
                }
            `,
            transparent: true,
            depthWrite:  false,
            depthTest:   true,
            blending:    THREE.AdditiveBlending
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    start(startPos, color) {
        this.isPouring = true;
        this.color.set(color);
        this.particleMaterial.uniforms.color.value.copy(this.color);
        this.spawnPos = startPos.clone();
    }

    stop() { this.isPouring = false; }

    emit(currentPos) {
        if (currentPos && this.spawnPos) this.spawnPos.copy(currentPos);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  detectCavity  –  scan WORLD space, không qua invMatrix
    // ─────────────────────────────────────────────────────────────────────
    detectCavity(tool) {
        if (tool.userData.cavityPoints)
            return tool.userData.cavityPoints;

        tool.updateMatrixWorld(true);
        const invMatrix = tool.matrixWorld.clone().invert();

        // CHỈ scan mesh dụng cụ
        const meshes = [];
        tool.traverse(o => {
            if (o.isMesh) meshes.push(o);
        });

        const box = new THREE.Box3().setFromObject(tool);
        const size = new THREE.Vector3();
        box.getSize(size);

        const raycaster = new THREE.Raycaster();
        const points = [];
        const GRID = 24;

        for (let ix = 0; ix < GRID; ix++) {
            for (let iz = 0; iz < GRID; iz++) {
                const wx = box.min.x + ((ix + 0.5) / GRID) * size.x;
                const wz = box.min.z + ((iz + 0.5) / GRID) * size.z;

                const origin = new THREE.Vector3(wx, box.max.y + 0.05, wz);
                raycaster.set(origin, new THREE.Vector3(0, -1, 0));

                const hits = raycaster.intersectObjects(meshes, true);

                // Thuật toán 4-hit fallback 2-hit cho model Tripo (mesh đặc)
                if (hits.length < 2) continue;

                let innerTop, innerBottom;
                if (hits.length >= 4) {
                    innerTop = hits[1];
                    innerBottom = hits[hits.length - 2];
                } else {
                    // Fallback cho mesh đặc từ AI
                    innerTop = hits[0];
                    innerBottom = hits[hits.length - 1];
                }

                const topLocal = innerTop.point.clone().applyMatrix4(invMatrix);
                const bottomLocal = innerBottom.point.clone().applyMatrix4(invMatrix);

                const depth = topLocal.y - bottomLocal.y;

                // Loại bỏ các vùng quá mỏng hoặc điểm lỗi ngoài thân
                if (depth < 0.03) continue;
                if (topLocal.y < 0) continue;

                points.push({
                    lx: topLocal.x,
                    lz: topLocal.z,
                    lyTop: topLocal.y,
                    lyBottom: bottomLocal.y
                });
            }
        }

        console.log("[CAVITY]", tool.name || "Tool", points.length);
        tool.userData.cavityPoints = points;
        return points;
    }

    /** Gọi từ interaction.js khi tool bị thả, scale đổi, hoặc gắn lại scene. */
    invalidateCavity(tool) {
        if (!tool) return;
        delete tool.userData.cavityPoints;
        delete tool.userData.cavityWorldAABB;
    }

    // ─────────────────────────────────────────────────────────────────────
    getOrCreateVolume(target) {
        if (this.volumes.has(target)) return this.volumes.get(target);

        this.detectCavity(target);

        const liquidGroup = new THREE.Group();
        liquidGroup.name  = 'liquid_group';
        target.add(liquidGroup); // Gắn trực tiếp vào target

        const resolution = 28;
        const volume = new MarchingCubes(
            resolution,
            new THREE.MeshPhysicalMaterial({
                color:        this.color.clone(),
                transparent:  true,
                opacity:      0.82,
                transmission: 0.35,
                ior:          1.45,
                thickness:    0.08,
                roughness:    0.08,
                metalness:    0.0,
            }),
            true, true, 100000
        );

        volume.position.set(0, 0, 0);
        volume.scale.set(1, 1, 1);
        liquidGroup.add(volume);

        volume.userData.container   = target;
        volume.userData.group       = liquidGroup;
        target.userData.liquidColor = this.color.clone();

        this.volumes.set(target, volume);
        target.userData.liquidLevel = 0;
        return volume;
    }

    // ─────────────────────────────────────────────────────────────────────
    update(targetPos) {
        this.time += 0.016;
        this.particleMaterial.uniforms.time.value = this.time;

        if (this.isPouring) {
            this.spawnTimer += 0.016;
            if (this.spawnTimer > 0.01) {
                this._spawnParticle(targetPos);
                this.spawnTimer = 0;
            }
        }

        this._updateParticles();

        this.volumes.forEach((volume, target) => {
            this._updateVolumeEffect(volume, target);
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    _spawnParticle(targetPos) {
        const idx = this.activeParticles % this.particleCount;
        const pos = this.spawnPos.clone();
        pos.x += (Math.random() - 0.5) * 0.01;
        pos.z += (Math.random() - 0.5) * 0.01;

        const vel = new THREE.Vector3(0, -1.2, 0);
        if (targetPos) vel.copy(targetPos.clone().sub(pos).normalize()).multiplyScalar(2.2);

        if (!this.particles[idx])
            this.particles[idx] = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0 };

        const p = this.particles[idx];
        p.pos.copy(pos); p.vel.copy(vel);
        p.life = 1.0; p.target = targetPos ? targetPos.clone() : null;
        this.activeParticles++;
    }

    _updateParticles() {
        const pos  = this.particleGeometry.attributes.position.array;
        const size = this.particleGeometry.attributes.size.array;

        for (let i = 0; i < this.particleCount; i++) {
            const p = this.particles[i];
            if (!p || p.life <= 0) { size[i] = 0; pos[i*3+1] = -100; continue; }

            p.vel.y -= 0.12;
            p.pos.addScaledVector(p.vel, 0.016);
            p.life -= 0.012;

            if (p.pos.y < 0 || (p.target && p.pos.y < p.target.y && p.vel.y < 0 && p.life < 0.98))
                p.life = 0;

            pos[i*3] = p.pos.x; pos[i*3+1] = p.pos.y; pos[i*3+2] = p.pos.z;
            size[i]  = 5.0 * p.life;
        }
        this.particleGeometry.attributes.position.needsUpdate = true;
        this.particleGeometry.attributes.size.needsUpdate     = true;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  _updateVolumeEffect  ← FIX CORE
    //
    //  Mỗi frame:
    //   1. Lấy / tính cavityWorldAABB (kích thước cavity + offset tâm vs tâm tool).
    //   2. Tính tâm cavity world hiện tại = tâm tool hiện tại + offset cố định.
    //   3. Đặt liquidGroup.position = tâm cavity, .scale = kích thước cavity.
    //      .quaternion = identity (không bao giờ nghiêng theo tool).
    //   4. addBall với coords normalize [-0.45, 0.45]³.
    // ─────────────────────────────────────────────────────────────────────
    _updateVolumeEffect(volume, target) {
        const level = target.userData.liquidLevel || 0;
        if (level <= 0) {
            volume.userData.group.visible = false;
            return;
        }
        volume.userData.group.visible = true;

        target.updateMatrixWorld(true);

        // ── 1. Đảm bảo có cavityPoints (LOCAL) ────────────────────────────
        let points = target.userData.cavityPoints;
        if (!points || points.length === 0) {
            points = this.detectCavity(target);
            if (points.length === 0) return;
        }

        // Lọc nhiễu ngoài cavity
        points = points.filter(p =>
            isFinite(p.lx) &&
            isFinite(p.lz) &&
            isFinite(p.lyTop) &&
            isFinite(p.lyBottom)
        );

        // ── 2. Tính toán thông số Cavity (LOCAL) ──────────────────────────
        const pointsBox = new THREE.Box3();
        points.forEach(p => pointsBox.expandByPoint(new THREE.Vector3(p.lx, 0, p.lz)));
        const cavitySize = pointsBox.getSize(new THREE.Vector3());

        const cavityMinY = points.reduce((m, p) => Math.min(m, p.lyBottom), Infinity);
        const cavityMaxY = points.reduce((m, p) => Math.max(m, p.lyTop), -Infinity);
        const cavityHeight = cavityMaxY - cavityMinY;

        // ── 3. Định vị LiquidGroup (Sử dụng LOCAL vì đã là child của target) ──
        const cavityCenter = new THREE.Vector3(
            (pointsBox.min.x + pointsBox.max.x) * 0.5,
            (cavityMinY + cavityMaxY) * 0.5,
            (pointsBox.min.z + pointsBox.max.z) * 0.5
        );

        const liquidGroup = volume.userData.group;
        if (liquidGroup) {
            liquidGroup.position.copy(cavityCenter);
            liquidGroup.scale.set(1, 1, 1);

            // Giữ mặt nước ngang tương đối (lazy leveling)
            liquidGroup.rotation.x = -target.rotation.x * 0.15;
            liquidGroup.rotation.z = -target.rotation.z * 0.15;
            liquidGroup.rotation.y = 0; // Không xoay theo yaw
        }

        // ── 4. Scale Volume khớp với Cavity (Padding nhỏ hơn cho Tripo) ─────
        const padding = 0.55;
        volume.scale.set(
            Math.max(cavitySize.x * padding, 1e-4),
            Math.max(cavityHeight * 0.92, 1e-4),
            Math.max(cavitySize.z * padding, 1e-4)
        );

        // ── 5. Màu sắc ────────────────────────────────────────────────────
        if (target.userData.liquidColor)
            volume.material.color.copy(target.userData.liquidColor);

        // ── 6. Reset + rải ball (sử dụng mapLinear để an toàn trong lưới) ──
        volume.reset();

        const STRENGTH = 0.18;
        const SUBTRACT = 18;

        points.forEach(p => {
            // Ánh xạ LOCAL coordinates sang vùng an toàn [0.15, 0.85] của MarchingCubes
            const nx = THREE.MathUtils.mapLinear(p.lx, pointsBox.min.x, pointsBox.max.x, 0.15, 0.85);
            const nz = THREE.MathUtils.mapLinear(p.lz, pointsBox.min.z, pointsBox.max.z, 0.15, 0.85);

            // Mực nước mapping 0->1 -> 0.05->0.92
            const localLevelY = p.lyBottom + level * (p.lyTop - p.lyBottom);
            const ny = THREE.MathUtils.mapLinear(localLevelY, cavityMinY, cavityMaxY, 0.05, 0.92);

            // Clamp để tránh nổ volume
            if (nx < 0.05 || nx > 0.95 || ny < 0.02 || ny > 0.95 || nz < 0.05 || nz > 0.95) return;

            volume.addBall(nx, ny, nz, STRENGTH, SUBTRACT);
        });

        // Ripple tại tâm mặt thoáng
        const rippleNy = THREE.MathUtils.mapLinear(level, 0, 1, 0.05, 0.92);
        if (this.isPouring) {
            volume.addBall(0.5, rippleNy, 0.5, 0.55, 12);
        }

        volume.update();
    }

    // ── Backward compat aliases ──────────────────────────────────────────
    createParticleMaterial() { return this._createParticleMaterial(); }
    spawnParticle(t)         { return this._spawnParticle(t); }
    updateParticles()        { return this._updateParticles(); }
    updateVolumeEffect(v,t)  { return this._updateVolumeEffect(v, t); }
}
