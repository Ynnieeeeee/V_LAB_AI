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
        this.particleSystem.name = 'liquid_pouring_particles';
        this.particleSystem.userData.isParticle = true;
        this.particleSystem.userData.notDraggable = true;
        this.particleSystem.userData.ignoreRaycast = true;
        this.particleSystem.raycast = () => null;
        this.particleSystem.renderOrder = 999;
        this.scene.add(this.particleSystem);

        // ── Volume map ────────────────────────────────────────────────────
        this.volumes     = new Map();

        // --- THÊM KHỞI TẠO HỆ THỐNG HẠT KHÓI/BỌT KHÍ ---
        this.smokeParticles = [];
        this.smokeGeometry = new THREE.SphereGeometry(0.03, 8, 8);
        this.smokeMaterial = new THREE.MeshBasicMaterial({
            color: 0xf5f5f5,
            transparent: true,
            opacity: 0.85
        });

        this.flowRate    = 0.05;
        this.time        = 0;
        this.activeParticles = 0;
        this.spawnTimer  = 0;

        // Hạt rắn/bột: dùng riêng với chất có physical_state = Rắn.
        this.powderParticles = [];
        this.powderCount = 700;
        this.powderGeometry = new THREE.BufferGeometry();
        this.powderPositions = new Float32Array(this.powderCount * 3);
        this.powderSizes = new Float32Array(this.powderCount);
        for (let i = 0; i < this.powderCount; i++) {
            this.powderPositions[i * 3] = 0;
            this.powderPositions[i * 3 + 1] = -100;
            this.powderPositions[i * 3 + 2] = 0;
            this.powderSizes[i] = 0;
        }
        this.powderGeometry.setAttribute('position', new THREE.BufferAttribute(this.powderPositions, 3));
        this.powderGeometry.setAttribute('size', new THREE.BufferAttribute(this.powderSizes, 1));
        this.powderMaterial = this._createPowderMaterial();
        this.powderSystem = new THREE.Points(this.powderGeometry, this.powderMaterial);
        this.powderSystem.name = 'powder_pouring_particles';
        this.powderSystem.userData.isPowder = true;
        this.powderSystem.userData.isParticle = true;
        this.powderSystem.userData.notDraggable = true;
        this.powderSystem.userData.ignoreRaycast = true;
        this.powderSystem.raycast = () => null;
        this.powderSystem.renderOrder = 1000;
        this.scene.add(this.powderSystem);
        this.activePowderParticles = 0;
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
            blending:    THREE.NormalBlending
        });
    }

    _createPowderMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: { color: { value: this.color.clone() } },
            vertexShader: `
                attribute float size;
                void main() {
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = clamp(size * (120.0 / -mvPosition.z), 1.5, 18.0);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 color;
                void main() {
                    float d = distance(gl_PointCoord, vec2(0.5));
                    if (d > 0.5) discard;
                    float grain = 0.75 + fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453) * 0.25;
                    gl_FragColor = vec4(color * grain, 1.0);
                }
            `,
            transparent: true,
            depthWrite: true,
            depthTest: true
        });
    }

    _isSolidState(state) {
        const s = String(state || '').toLowerCase();
        return s.includes('rắn') || s.includes('ran') || s.includes('solid') || s.includes('powder') || s.includes('bột');
    }

    // ─────────────────────────────────────────────────────────────────────
    startPouring(position, color, chemicalName, chemicalType, physicalState = 'Lỏng') {
        this.isPouring = true;
        this.chemicalName = chemicalName;
        this.chemicalType = chemicalType;
        this.physicalState = physicalState;
        this.isPouringSolid = this._isSolidState(physicalState);
        this.color.set(color || '#ffffff');
        this.particleMaterial.uniforms.color.value.copy(this.color);
        this.powderMaterial.uniforms.color.value.copy(this.color);
        this.spawnPos = position.clone();
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
            if (!o.isMesh) return;
            if (o.name === 'fluid_volume') return;
            if (o.userData?.isLiquid || o.userData?.isPowder || o.userData?.isParticle || o.userData?.isReactionEffect || o.userData?.ignoreRaycast) return;
            meshes.push(o);
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
        liquidGroup.userData.isLiquid = true;
        liquidGroup.userData.notDraggable = true;
        liquidGroup.userData.ignoreRaycast = true;
        target.add(liquidGroup); // Gắn trực tiếp vào target

        const resolution = 48;
        const material = new THREE.MeshPhysicalMaterial({
            color: this.color.clone(),
            transmission: 0.8, // Giảm trong suốt để dung dịch có màu đậm đà, rõ nét hơn
            transparent: true,
            opacity: 0.9,
            roughness: 0.2, // Tăng nhám nhẹ để bớt chói lóa lóng lánh
            metalness: 0.0,
            ior: 1.333, // nước thật
            thickness: 0.35,
            clearcoat: 0.2, // Giảm bóng lóng lánh
            clearcoatRoughness: 0.3, // Làm nhòe vệt bóng
            envMapIntensity: 1.0,
            depthWrite: false, // Cho phép nhìn thấy kết tủa/hạt rắn bên trong dung dịch trong suốt.
        });

        material.onBeforeCompile = (shader) => {
            if (shader.fragmentShader.indexOf('#include <tonemapping_fragment>') !== -1) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <tonemapping_fragment>',
                    `
                    vec3 viewDir = normalize( vViewPosition );
                    vec3 fNormal = normalize( vNormal );
                    #ifdef DOUBLE_SIDED
                        fNormal = fNormal * ( float( gl_FrontFacing ) * 2.0 - 1.0 );
                    #endif
                    float fresnel = pow( 1.0 - max( dot( fNormal, viewDir ), 0.0 ), 3.0 );
                    outgoingLight = mix( outgoingLight, vec3( 1.0 ), fresnel * 0.45 * opacity );
                    #include <tonemapping_fragment>
                    `
                );
            } else {
                shader.fragmentShader = shader.fragmentShader.replace(
                    'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
                    `
                    vec3 viewDir = normalize( vViewPosition );
                    vec3 fNormal = normalize( vNormal );
                    float fresnel = pow( 1.0 - max( dot( fNormal, viewDir ), 0.0 ), 3.0 );
                    outgoingLight = mix( outgoingLight, vec3( 1.0 ), fresnel * 0.45 * opacity );
                    gl_FragColor = vec4( outgoingLight, diffuseColor.a );
                    `
                );
            }
        };

        const volume = new MarchingCubes(
            resolution,
            material,
            false, false, 100000
        );
        volume.name = "fluid_volume";
        volume.renderOrder = 10;
        volume.userData.isLiquid = true;
        volume.userData.notDraggable = true;
        volume.userData.ignoreRaycast = true;
        volume.raycast = () => null;

        volume.position.set(0, 0, 0);
        volume.scale.set(1, 1, 1);
        liquidGroup.add(volume);

        volume.userData.container   = target;
        volume.userData.group       = liquidGroup;
        target.userData.liquidColor = this.color.clone();

        this.volumes.set(target, volume);
        if (target.userData.liquidLevel === undefined) {
            target.userData.liquidLevel = 0;
        }
        return volume;
    }

    // ─────────────────────────────────────────────────────────────────────
    update(targetPos) {
        this.time += 0.016;
        this.particleMaterial.uniforms.time.value = this.time;

        if (this.isPouring) {
            this.spawnTimer += 0.016;
            if (this.spawnTimer > 0.01) {
                if (this.isPouringSolid) {
                    this._spawnPowderParticle(targetPos);
                    this._spawnPowderParticle(targetPos);
                } else {
                    this._spawnParticle(targetPos);
                }
                this.spawnTimer = 0;
            }
        }

        this._updateParticles();
        this._updatePowderParticles();

        this.volumes.forEach((volume, target) => {
            this._updateVolumeEffect(volume, target);
            
            // --- NẾU CÓ HIỆU ỨNG KHÍ, sinh bọt/khói từ MIỆNG DỤNG CỤ theo world-space ---
            if (volume.userData.hasGasEffect) {
                const surfacePos = this._getContainerSurfaceWorldPosition(volume, target);
                this.spawnSmokeEffect(surfacePos, target);
            }
        });

        // Cập nhật chuyển động vật lý cho toàn bộ hạt khói
        this.updateSmokeParticles();
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
            this.particles[idx] = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, userData: {} };

        const p = this.particles[idx];
        p.pos.copy(pos); p.vel.copy(vel);
        p.life = 1.0; p.target = targetPos ? targetPos.clone() : null;
        p.userData = {
            color: this.color.clone(),
            chemicalName: this.chemicalName,
            chemicalType: this.chemicalType
        };
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


    _spawnPowderParticle(targetPos) {
        if (!this.spawnPos) return;
        const idx = this.activePowderParticles % this.powderCount;
        const pos = this.spawnPos.clone();
        pos.x += (Math.random() - 0.5) * 0.035;
        pos.z += (Math.random() - 0.5) * 0.035;

        const vel = new THREE.Vector3(
            (Math.random() - 0.5) * 0.09,
            -0.55 - Math.random() * 0.45,
            (Math.random() - 0.5) * 0.09
        );
        if (targetPos) {
            const toTarget = targetPos.clone().sub(pos).normalize().multiplyScalar(1.2);
            vel.lerp(toTarget, 0.45);
        }

        if (!this.powderParticles[idx]) {
            this.powderParticles[idx] = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, settled: false };
        }

        const p = this.powderParticles[idx];
        p.pos.copy(pos);
        p.vel.copy(vel);
        p.life = 1.0;
        p.target = targetPos ? targetPos.clone() : null;
        p.settled = false;
        this.activePowderParticles++;
    }

    _updatePowderParticles() {
        const pos = this.powderGeometry.attributes.position.array;
        const size = this.powderGeometry.attributes.size.array;

        for (let i = 0; i < this.powderCount; i++) {
            const p = this.powderParticles[i];
            if (!p || p.life <= 0) {
                size[i] = 0;
                pos[i * 3 + 1] = -100;
                continue;
            }

            if (!p.settled) {
                p.vel.y -= 0.035;
                p.pos.addScaledVector(p.vel, 0.016);
                if (p.target && p.pos.distanceTo(p.target) < 0.08) {
                    p.settled = true;
                    p.vel.set(0, 0, 0);
                }
                if (p.pos.y < 0) p.life = 0;
            }

            p.life -= p.settled ? 0.018 : 0.006;
            pos[i * 3] = p.pos.x;
            pos[i * 3 + 1] = p.pos.y;
            pos[i * 3 + 2] = p.pos.z;
            size[i] = (p.settled ? 4.0 : 3.0) * Math.max(p.life, 0);
        }

        this.powderGeometry.attributes.position.needsUpdate = true;
        this.powderGeometry.attributes.size.needsUpdate = true;
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
            Math.max(cavityHeight * 0.55, 1e-4),
            Math.max(cavitySize.z * padding, 1e-4)
        );

        // ── 5. UPDATE MÀU DUNG DỊCH ─────────────────────────────
        if (volume.userData.isColorLerping && volume.userData.targetColor) {
            // Lerp sang màu phản ứng
            volume.material.color.lerp(
                volume.userData.targetColor,
                0.08
            );

            volume.material.emissive =
                volume.material.color.clone()
                    .multiplyScalar(0.08);

            // Đồng bộ màu hiện tại
            target.userData.liquidColor =
                volume.material.color.clone();

            // ÉP THREEJS UPDATE MATERIAL
            volume.material.needsUpdate = true;

            // Hoàn tất đổi màu (so sánh chênh lệch màu RGB)
            const colorDiff = Math.sqrt(
                Math.pow(volume.material.color.r - volume.userData.targetColor.r, 2) +
                Math.pow(volume.material.color.g - volume.userData.targetColor.g, 2) +
                Math.pow(volume.material.color.b - volume.userData.targetColor.b, 2)
            );

            if (colorDiff < 0.01) {
                volume.material.color.copy(
                    volume.userData.targetColor
                );

                target.userData.liquidColor =
                    volume.userData.targetColor.clone();

                volume.userData.isColorLerping = false;

                volume.material.needsUpdate = true;

                target.userData.isReacting = false;
            }
        }
        else {
            // Giữ màu hiện tại của dung dịch
            if (target.userData.liquidColor) {
                volume.material.color.copy(
                    target.userData.liquidColor
                );

                volume.material.needsUpdate = true;
            }
        }

        // ── 6. Reset + rải ball (sử dụng mapLinear để an toàn trong lưới) ──
        volume.reset();
        volume.isolation = 18;

        const gridX = 18;
        const gridZ = 18;

        const fillHeight = THREE.MathUtils.mapLinear(
            level,
            0,
            1,
            0.08,
            0.88
        );

        for (let ix = 0; ix < gridX; ix++) {
            for (let iz = 0; iz < gridZ; iz++) {

                const nx = THREE.MathUtils.mapLinear(
                    ix,
                    0,
                    gridX - 1,
                    0.18,
                    0.82
                );

                const nz = THREE.MathUtils.mapLinear(
                    iz,
                    0,
                    gridZ - 1,
                    0.18,
                    0.82
                );

                // noise cực nhỏ để tránh mặt phẳng robot
                const wave =
                    Math.sin(ix * 0.7 + this.time * 2.0) *
                    Math.cos(iz * 0.6 + this.time * 1.5) *
                    0.01;

                const ny = fillHeight + wave;

                volume.addBall(
                    nx,
                    ny,
                    nz,
                    0.085,
                    8
                );
            }
        }

        // Ripple tại tâm mặt thoáng
        const rippleNy = THREE.MathUtils.mapLinear(level, 0, 1, 0.05, 0.92);
        if (this.isPouring) {
            const ripple = Math.sin(this.time * 8.0) * 0.02;
            volume.addBall(
                0.5 + ripple,
                rippleNy,
                0.5,
                0.35,
                8
            );
        }

        volume.update();
        if (volume.geometry) {
            volume.geometry.computeVertexNormals();
        }
    }

    _getContainerSurfaceWorldPosition(volume, target) {
        const p = new THREE.Vector3();
        try {
            const box = new THREE.Box3().setFromObject(target);
            box.getCenter(p);
            p.y = box.max.y + 0.025;
        } catch (e) {
            volume.userData.group?.getWorldPosition(p);
        }
        return p;
    }

    // Thêm hàm sinh hạt khí/bọt lơ lửng phía trên mặt cốc
    spawnSmokeEffect(pos, target = null) {
        for (let i = 0; i < 2; i++) { // Mỗi khung hình sinh ra 2 hạt ngẫu nhiên
            const p = new THREE.Mesh(this.smokeGeometry, this.smokeMaterial.clone());
            p.name = 'smoke_particle_effect';
            p.userData.isReactionEffect = true;
            p.userData.notDraggable = true;
            p.userData.ignoreRaycast = true;
            p.raycast = () => null;
            const spread = target ? Math.max(0.08, Math.min(0.22, new THREE.Box3().setFromObject(target).getSize(new THREE.Vector3()).x * 0.18)) : 0.15;
            p.position.set(
                pos.x + (Math.random() - 0.5) * spread,
                pos.y + 0.04,
                pos.z + (Math.random() - 0.5) * spread
            );
            this.scene.add(p);
            this.smokeParticles.push({
                mesh: p,
                velocity: new THREE.Vector3((Math.random() - 0.5) * 0.005, 0.015, (Math.random() - 0.5) * 0.005), // Bay ngược lên
                life: 1.0 // Tuổi thọ hạt
            });
        }
    }

    // Thêm hàm cập nhật chuyển động bay lên và tan biến của khói
    updateSmokeParticles() {
        for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
            const p = this.smokeParticles[i];
            p.mesh.position.add(p.velocity);
            p.life -= 0.02; // Hạt già đi theo thời gian
            p.mesh.material.opacity = p.life * 0.5; // Mờ dần
            p.mesh.scale.addScalar(0.015); // Khói nở rộng dần ra ngoài không khí

            if (p.life <= 0) {
                this.scene.remove(p.mesh);
                if (p.mesh.material) {
                    p.mesh.material.dispose();
                }
                this.smokeParticles.splice(i, 1);
            }
        }
    }

    // Backward compat aliases for smoke methods
    spawnSmoke(pos) { this.spawnSmokeEffect(pos); }
    updateSmoke()     { this.updateSmokeParticles(); }

    // ── Backward compat aliases ──────────────────────────────────────────
    createParticleMaterial() { return this._createParticleMaterial(); }
    spawnParticle(t)         { return this._spawnParticle(t); }
    updateParticles()        { return this._updateParticles(); }
    updateVolumeEffect(v,t)  { return this._updateVolumeEffect(v, t); }
}
