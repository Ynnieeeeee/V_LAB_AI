import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { selectDominantCavityPoints } from './CavityCSG.js?v=20260527-liquid-soft-waves';

if (typeof window !== 'undefined' && window.DEBUG_LIQUID_FILL === undefined) {
    window.DEBUG_LIQUID_FILL = false;
}

function liquidFillDebugEnabled() {
    return typeof window !== 'undefined' && window.DEBUG_LIQUID_FILL === true;
}

function shouldIgnoreCavityMesh(object) {
    const data = object?.userData || {};
    return (
        !object?.isMesh ||
        object.name === 'fluid_volume' ||
        data.isLiquid ||
        data.isPowder ||
        data.isParticle ||
        data.isReactionEffect ||
        data.isInternalChemicalVisual ||
        data.isCavityDebug ||
        data.isCSGCavityShell ||
        data.isCavitySourceMesh ||
        data.ignoreRaycast
    );
}

function expandBoxByTransformedCorners(targetBox, sourceBox, matrix) {
    const min = sourceBox.min;
    const max = sourceBox.max;
    for (const x of [min.x, max.x]) {
        for (const y of [min.y, max.y]) {
            for (const z of [min.z, max.z]) {
                targetBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
            }
        }
    }
}

export function getToolLocalMeshBox(tool, meshes = null) {
    if (!tool) return null;
    tool.updateMatrixWorld(true);

    const invMatrix = tool.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    let hasBounds = false;
    const sourceMeshes = meshes || [];

    if (!meshes) {
        tool.traverse(object => {
            if (!shouldIgnoreCavityMesh(object)) sourceMeshes.push(object);
        });
    }

    sourceMeshes.forEach(mesh => {
        if (shouldIgnoreCavityMesh(mesh)) return;

        if (mesh.geometry?.computeBoundingBox && !mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox();
        }

        const geometryBox = mesh.geometry?.boundingBox;
        if (geometryBox && !geometryBox.isEmpty()) {
            const meshToTool = invMatrix.clone().multiply(mesh.matrixWorld);
            expandBoxByTransformedCorners(box, geometryBox, meshToTool);
            hasBounds = true;
        } else {
            const worldBox = new THREE.Box3().setFromObject(mesh);
            if (!worldBox.isEmpty()) {
                expandBoxByTransformedCorners(box, worldBox, invMatrix);
                hasBounds = true;
            }
        }
    });

    if (hasBounds && !box.isEmpty()) return box;

    const worldBox = new THREE.Box3().setFromObject(tool);
    if (worldBox.isEmpty()) return null;
    expandBoxByTransformedCorners(box, worldBox, invMatrix);
    return box.isEmpty() ? null : box;
}

function getFallbackCavityPoints(tool) {
    const box = getToolLocalMeshBox(tool);
    if (!box || box.isEmpty()) return [];

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const halfX = Math.max(size.x * 0.22, 0.035);
    const halfZ = Math.max(size.z * 0.22, 0.035);
    const bottomY = box.min.y + size.y * 0.14;
    const topY = box.min.y + size.y * 0.62;
    const points = [];
    const steps = [-1, -0.5, 0, 0.5, 1];

    steps.forEach(ix => {
        steps.forEach(iz => {
            points.push({
                lx: center.x + ix * halfX,
                lz: center.z + iz * halfZ,
                lyTop: topY,
                lyBottom: bottomY
            });
        });
    });

    return points;
}

function isFiniteCavityPoint(point) {
    return (
        point &&
        Number.isFinite(point.lx) &&
        Number.isFinite(point.lz) &&
        Number.isFinite(point.lyTop) &&
        Number.isFinite(point.lyBottom) &&
        point.lyTop > point.lyBottom
    );
}

function usesCSGScaledCavity(target) {
    return target?.userData?.cavitySource === 'csg_scaled_model' || !!target?.userData?.cavityCSG;
}

function normalizedInBox(value, min, max, inset = 0.06) {
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0.5;
    const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
    return THREE.MathUtils.lerp(inset, 1 - inset, t);
}

function quantileValue(values, ratio) {
    const finite = values.filter(value => Number.isFinite(value));
    if (!finite.length) return null;
    const sorted = finite.sort((a, b) => a - b);
    const index = THREE.MathUtils.clamp(
        Math.round((sorted.length - 1) * ratio),
        0,
        sorted.length - 1
    );
    return sorted[index];
}

function boxMinY(boxLike) {
    const y = Number(boxLike?.min?.y);
    return Number.isFinite(y) ? y : null;
}

function resolveLiquidFloorY(target, corePoints, cavityMinY, cavityHeight, isCSGCavity) {
    const candidates = [];
    const addCandidate = value => {
        const number = Number(value);
        if (Number.isFinite(number)) candidates.push(number);
    };

    addCandidate(cavityMinY);
    if (isCSGCavity) {
        addCandidate(target?.userData?.cavityLiquidFloorY);
        addCandidate(target?.userData?.cavityCSG?.liquidFloorY);
        addCandidate(boxMinY(target?.userData?.cavityBox));
        addCandidate(boxMinY(target?.userData?.cavityCSG?.innerBox));
    }

    const bottomQuantile = quantileValue(
        corePoints.map(point => Number(point?.lyBottom)),
        isCSGCavity ? 0.18 : 0.10
    );
    addCandidate(bottomQuantile);

    const rawFloor = candidates.length ? Math.max(...candidates) : cavityMinY;
    const clearance = Math.max(
        cavityHeight * (isCSGCavity ? 0.018 : 0.012),
        isCSGCavity ? 0.004 : 0.002
    );
    return rawFloor + clearance;
}

function analyzeMouthConstraint(corePoints, pointsBox, cavityMinY, cavityMaxY, isCSGCavity) {
    const cavityHeight = cavityMaxY - cavityMinY;
    if (!isCSGCavity || !Number.isFinite(cavityHeight) || cavityHeight <= 0) {
        return {
            isNecked: false,
            safeTopY: cavityMaxY,
            topClearanceRatio: isCSGCavity ? 0.075 : 0.14,
            topWave: isCSGCavity ? 0.008 : 0.012
        };
    }

    const tops = corePoints.map(point => Number(point?.lyTop)).filter(Number.isFinite);
    const highTop = quantileValue(tops, 0.86);
    if (!Number.isFinite(highTop)) {
        return { isNecked: false, safeTopY: cavityMaxY, topClearanceRatio: 0.075, topWave: 0.008 };
    }

    const topGate = Math.max(highTop, cavityMinY + cavityHeight * 0.72);
    const topPoints = corePoints.filter(point => point.lyTop >= topGate);
    if (topPoints.length < Math.max(6, corePoints.length * 0.035)) {
        return { isNecked: false, safeTopY: cavityMaxY, topClearanceRatio: 0.075, topWave: 0.008 };
    }

    const mouthBox = new THREE.Box3();
    topPoints.forEach(point => mouthBox.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz)));
    const mouthSize = mouthBox.getSize(new THREE.Vector3());
    const bodySize = pointsBox.getSize(new THREE.Vector3());
    const bodyArea = Math.max(bodySize.x * bodySize.z, 1e-8);
    const mouthArea = Math.max(mouthSize.x * mouthSize.z, 0);
    const widthRatio = Math.max(mouthSize.x, mouthSize.z) / Math.max(bodySize.x, bodySize.z, 1e-8);
    const areaRatio = mouthArea / bodyArea;
    const isNecked = areaRatio < 0.42 || widthRatio < 0.62;

    return {
        isNecked,
        safeTopY: isNecked ? cavityMinY + cavityHeight * 0.72 : cavityMaxY,
        topClearanceRatio: isNecked ? 0.18 : 0.075,
        topWave: isNecked ? 0.0045 : 0.008
    };
}

function liquidSurfaceWave(x, z, time, amplitude, phase = 0) {
    if (!Number.isFinite(amplitude) || amplitude <= 0) return 0;
    const primary = Math.sin(x * 0.78 + time * 1.65 + phase) * 0.58;
    const cross = Math.cos(z * 0.66 - time * 1.25 + phase * 0.7) * 0.34;
    const diagonal = Math.sin((x + z) * 0.34 + time * 0.95 + phase * 1.3) * 0.22;
    return THREE.MathUtils.clamp(primary + cross + diagonal, -1, 1) * amplitude;
}

function clampLiquidGeometryToBounds(volume, floorY, ceilingY) {
    const position = volume?.geometry?.getAttribute?.('position');
    const groupY = Number(volume?.userData?.group?.position?.y);
    const scaleY = Number(volume?.scale?.y);
    const floor = Number(floorY);
    const ceiling = Number(ceilingY);

    if (!position || !Number.isFinite(groupY) || !Number.isFinite(scaleY) || Math.abs(scaleY) < 1e-6 || !Number.isFinite(floor)) {
        return;
    }

    const localFloorY = THREE.MathUtils.clamp((floor - groupY) / scaleY, -0.5, 0.48);
    const localCeilingY = Number.isFinite(ceiling)
        ? THREE.MathUtils.clamp((ceiling - groupY) / scaleY, localFloorY + 0.002, 0.5)
        : 0.5;
    const array = position.array;
    let changed = false;

    for (let i = 1; i < array.length; i += 3) {
        if (array[i] < localFloorY) {
            array[i] = localFloorY;
            changed = true;
        } else if (array[i] > localCeilingY) {
            array[i] = localCeilingY;
            changed = true;
        }
    }

    volume.userData.localFloorY = localFloorY;
    volume.userData.localCeilingY = localCeilingY;
    if (changed) {
        position.needsUpdate = true;
        volume.geometry.computeBoundingBox?.();
        volume.geometry.computeBoundingSphere?.();
    }
}

function chooseLiquidColumns(points, maxColumns = 520) {
    if (points.length <= maxColumns) return points;
    const stride = Math.ceil(points.length / maxColumns);
    return points.filter((_, index) => index % stride === 0);
}

function gridPointKey(x, z) {
    return `${x},${z}`;
}

function nearestColumnSource(sources, gridX, gridZ) {
    let best = sources[0] || null;
    let bestDistance = Infinity;
    sources.forEach(point => {
        const distance = Math.abs(point.gridX - gridX) + Math.abs(point.gridZ - gridZ);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = point;
        }
    });
    return best;
}

function buildFilledLiquidColumns(points, maxColumns = 420) {
    const gridPoints = points.filter(point =>
        Number.isInteger(point.gridX) &&
        Number.isInteger(point.gridZ)
    );
    if (gridPoints.length < Math.max(14, points.length * 0.45)) {
        return chooseLiquidColumns(points, maxColumns);
    }

    const byKey = new Map();
    const byX = new Map();
    const pointBox = new THREE.Box3();

    gridPoints.forEach(point => {
        const key = gridPointKey(point.gridX, point.gridZ);
        byKey.set(key, point);
        if (!byX.has(point.gridX)) byX.set(point.gridX, []);
        byX.get(point.gridX).push(point);
        pointBox.expandByPoint(new THREE.Vector3(point.lx, 0, point.lz));
    });

    if (pointBox.isEmpty()) return chooseLiquidColumns(points, maxColumns);

    const minGridX = Math.min(...gridPoints.map(point => point.gridX));
    const maxGridX = Math.max(...gridPoints.map(point => point.gridX));
    const minGridZ = Math.min(...gridPoints.map(point => point.gridZ));
    const maxGridZ = Math.max(...gridPoints.map(point => point.gridZ));
    const spanX = Math.max(1, maxGridX - minGridX);
    const spanZ = Math.max(1, maxGridZ - minGridZ);
    const xStep = (pointBox.max.x - pointBox.min.x) / spanX || 0;
    const zStep = (pointBox.max.z - pointBox.min.z) / spanZ || 0;
    const filled = [];

    for (const [gridX, row] of byX.entries()) {
        const zValues = Array.from(new Set(row.map(point => point.gridZ))).sort((a, b) => a - b);
        if (zValues.length < 2) {
            filled.push(...row);
            continue;
        }

        const segments = [];
        let segmentStart = zValues[0];
        let previous = zValues[0];
        for (let index = 1; index < zValues.length; index++) {
            const current = zValues[index];
            if (current > previous + 1) {
                segments.push([segmentStart, previous]);
                segmentStart = current;
            }
            previous = current;
        }
        segments.push([segmentStart, previous]);

        const rowCenter = (minGridZ + maxGridZ) * 0.5;
        const bestSegment = segments.reduce((best, segment) => {
            const width = segment[1] - segment[0] + 1;
            const centerDistance = Math.abs((segment[0] + segment[1]) * 0.5 - rowCenter);
            const score = width - centerDistance * 0.18;
            return score > best.score ? { segment, score } : best;
        }, { segment: segments[0], score: -Infinity }).segment;

        const rowSources = row.filter(point => point.gridZ >= bestSegment[0] && point.gridZ <= bestSegment[1]);
        for (let gridZ = bestSegment[0]; gridZ <= bestSegment[1]; gridZ++) {
            const existing = byKey.get(gridPointKey(gridX, gridZ));
            if (existing) {
                filled.push(existing);
                continue;
            }

            const source = nearestColumnSource(rowSources.length ? rowSources : row, gridX, gridZ);
            if (!source) continue;
            filled.push({
                ...source,
                lx: pointBox.min.x + (gridX - minGridX) * xStep,
                lz: pointBox.min.z + (gridZ - minGridZ) * zStep,
                gridX,
                gridZ,
                source: `${source.source || 'cavity'}_filled`
            });
        }
    }

    return chooseLiquidColumns(filled, maxColumns);
}

function liquidAnchorSignature(anchor) {
    return [
        anchor.centerX,
        anchor.centerZ,
        anchor.baseY,
        anchor.maxFillHeight,
        anchor.scaleX,
        anchor.scaleZ
    ].map(value => Number(value || 0).toFixed(5)).join('|');
}

function disposeObject3D(object) {
    if (!object) return;
    object.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(material => material?.dispose?.());
        else child.material?.dispose?.();
    });
    object.parent?.remove(object);
}

function clearLiquidFillDebug(volume) {
    const group = volume?.userData?.group;
    const debug = group?.getObjectByName?.('liquid_fill_debug');
    if (debug) disposeObject3D(debug);
}

function updateLiquidFillDebug(volume) {
    const group = volume?.userData?.group;
    const data = volume?.userData;
    if (!group || !data) return;

    if (!liquidFillDebugEnabled()) {
        clearLiquidFillDebug(volume);
        return;
    }

    let debug = group.getObjectByName('liquid_fill_debug');
    if (!debug) {
        debug = new THREE.Group();
        debug.name = 'liquid_fill_debug';
        debug.userData.isLiquid = true;
        debug.userData.ignoreRaycast = true;
        debug.userData.notDraggable = true;
        group.add(debug);
    }

    debug.children.slice().forEach(child => disposeObject3D(child));
    debug.clear();

    const halfX = Math.max(data.scaleX * 0.5, 0.01);
    const halfZ = Math.max(data.scaleZ * 0.5, 0.01);
    const y = -data.maxFillHeight * 0.5 + data.currentFillHeight;
    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-halfX, y, -halfZ),
        new THREE.Vector3(halfX, y, -halfZ),
        new THREE.Vector3(halfX, y, halfZ),
        new THREE.Vector3(-halfX, y, halfZ),
        new THREE.Vector3(-halfX, y, -halfZ)
    ]);
    const material = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geometry, material);
    line.userData.isLiquid = true;
    line.userData.ignoreRaycast = true;
    debug.add(line);

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!data.lastFillDebugLog || now - data.lastFillDebugLog > 700) {
        console.log('[LIQUID_FILL]', {
            baseY: data.baseY,
            currentFillHeight: data.currentFillHeight,
            maxFillHeight: data.maxFillHeight,
            currentVolume: data.currentVolume,
            maxVolume: data.maxVolume,
            fillRatio: data.fillRatio
        });
        data.lastFillDebugLog = now;
    }
}

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
                    gl_PointSize = clamp(size * (120.0 / -mvPosition.z), 1.2, 42.0);
                    gl_Position  = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 color;
                void main() {
                    float edgeX = min(gl_PointCoord.x, 1.0 - gl_PointCoord.x);
                    float edgeY = min(gl_PointCoord.y, 1.0 - gl_PointCoord.y);
                    float edgeAlpha = smoothstep(0.0, 0.08, min(edgeX, edgeY));
                    gl_FragColor = vec4(color, edgeAlpha * 0.95);
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

        const meshes = [];
        tool.traverse(o => {
            if (!shouldIgnoreCavityMesh(o)) meshes.push(o);
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

        const usablePoints = points.length > 0 ? points : getFallbackCavityPoints(tool);
        console.log("[CAVITY]", tool.name || "Tool", usablePoints.length);
        tool.userData.cavityPoints = usablePoints;
        return usablePoints;
    }

    /** Gọi từ interaction.js khi tool bị thả, scale đổi, hoặc gắn lại scene. */
    invalidateCavity(tool) {
        if (!tool) return;
        if (usesCSGScaledCavity(tool)) {
            delete tool.userData.cavityWorldAABB;
            return;
        }
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
            roughness: 0.16, // Tăng nhám nhẹ để bớt chói lóa lóng lánh
            metalness: 0.0,
            ior: 1.333, // nước thật
            thickness: 0.35,
            clearcoat: 0.35, // Giảm bóng lóng lánh
            clearcoatRoughness: 0.22, // Làm nhòe vệt bóng
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
        volume.userData.baseY = 0;
        volume.userData.currentFillHeight = 0;
        volume.userData.maxFillHeight = 1;
        volume.userData.currentVolume = target.userData.liquidLevel || 0;
        volume.userData.maxVolume = 1;
        volume.userData.fillRatio = 0;
        volume.userData.containerCavity = null;
        target.userData.liquidColor = this.color.clone();

        this.volumes.set(target, volume);
        if (target.userData.liquidLevel === undefined) {
            target.userData.liquidLevel = 0;
        }
        if (target.userData.targetLiquidLevel === undefined) {
            target.userData.targetLiquidLevel = target.userData.liquidLevel;
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
            
            // Chỉ phản ứng có smoke/vapor rõ ràng mới phun khói liên tục.
            // Phản ứng chỉ sinh khí đã có gas cloud/bubble riêng, không dùng smoke.
            const shouldSpawnSmokeVisual = target
                ? volume.userData.hasSmokeEffect === true && target.userData?.hasSmokeEffect === true
                : volume.userData.hasSmokeEffect === true;
            if (shouldSpawnSmokeVisual) {
                const surfacePos = this._getContainerSurfaceWorldPosition(volume, target);
                this.spawnSmokeEffect(surfacePos, target);
            } else {
                this.clearSmokeEffectForTarget(target);
            }
        });

        // Cập nhật chuyển động vật lý cho toàn bộ hạt khói
        this.updateSmokeParticles();
    }

    // ─────────────────────────────────────────────────────────────────────
    _spawnParticle(targetPos) {
        const idx = this.activeParticles % this.particleCount;
        const pos = this.spawnPos.clone();
        pos.x += (Math.random() - 0.5) * 0.014;
        pos.z += (Math.random() - 0.5) * 0.014;

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
            size[i]  = 6.4 * p.life;
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
    _animateLiquidLevel(target) {
        if (!target?.userData) return 0;

        const current = Number(target.userData.liquidLevel || 0);
        const desired = Number(target.userData.targetLiquidLevel);
        if (!Number.isFinite(desired) || desired <= current) {
            target.userData.currentLiquidVolume = current;
            target.userData.maxLiquidVolume = 1;
            return current;
        }

        const speed = Math.max(0.001, Number(target.userData.liquidRiseSpeed ?? 0.0028) || 0.0028);
        const next = Math.min(desired, current + speed);
        target.userData.liquidLevel = next;
        target.userData.currentLiquidVolume = next;
        target.userData.maxLiquidVolume = 1;
        return next;
    }

    _ensureLiquidAnchor(volume, anchor) {
        const liquidGroup = volume.userData.group;
        if (!liquidGroup) return;

        const signature = liquidAnchorSignature(anchor);
        const anchorPosition = new THREE.Vector3(
            anchor.centerX,
            anchor.baseY + anchor.maxFillHeight * 0.5,
            anchor.centerZ
        );
        const hasAnchor = volume.userData.anchorSignature === signature &&
            volume.userData.anchorPosition?.isVector3;

        if (!hasAnchor) {
            liquidGroup.position.copy(anchorPosition);
            liquidGroup.scale.set(1, 1, 1);
            liquidGroup.rotation.set(0, 0, 0);
            volume.userData.anchorSignature = signature;
            volume.userData.anchorPosition = anchorPosition.clone();
        } else {
            const drift = liquidGroup.position.distanceTo(anchorPosition);
            if (drift > 1e-4) {
                if (liquidFillDebugEnabled()) {
                    console.warn('[LIQUID_FILL] liquid group anchor drift corrected', {
                        previous: liquidGroup.position.toArray(),
                        expected: anchorPosition.toArray(),
                        drift
                    });
                }
                liquidGroup.position.copy(anchorPosition);
            }
        }

        if (volume.position.lengthSq() > 1e-8) {
            if (liquidFillDebugEnabled()) {
                console.warn('[LIQUID_FILL] volume.position changed after anchoring; resetting to local origin', {
                    previous: volume.position.toArray()
                });
            }
            volume.position.set(0, 0, 0);
        }

        volume.scale.set(anchor.scaleX, anchor.maxFillHeight, anchor.scaleZ);
        volume.userData.baseY = anchor.baseY;
        volume.userData.liquidFloorY = anchor.liquidFloorY ?? anchor.baseY;
        volume.userData.maxFillHeight = anchor.maxFillHeight;
        volume.userData.scaleX = anchor.scaleX;
        volume.userData.scaleZ = anchor.scaleZ;
        volume.userData.containerCavity = {
            baseY: anchor.baseY,
            floorY: anchor.liquidFloorY ?? anchor.baseY,
            maxFillHeight: anchor.maxFillHeight,
            minY: anchor.cavityMinY,
            maxY: anchor.cavityMaxY,
            centerX: anchor.centerX,
            centerZ: anchor.centerZ,
            isCSGCavity: anchor.isCSGCavity
        };
    }

    _updateVolumeEffect(volume, target) {
        const level = this._animateLiquidLevel(target);
        if (level <= 0) {
            volume.userData.group.visible = false;
            clearLiquidFillDebug(volume);
            return;
        }
        volume.userData.group.visible = true;

        target.updateMatrixWorld(true);

        // ── 1. Đảm bảo có cavityPoints (LOCAL) ────────────────────────────
        let points = target.userData.cavityPoints;
        if (!points || points.length === 0) {
            points = this.detectCavity(target);
            if (points.length === 0) points = getFallbackCavityPoints(target);
            if (points.length === 0) return;
        }

        const isCSGCavity = usesCSGScaledCavity(target);

        // Lọc nhiễu ngoài cavity.
        points = points.filter(isFiniteCavityPoint);
        if (isCSGCavity) {
            points = selectDominantCavityPoints(points);
            if (points.length > 0) {
                target.userData.cavityPoints = points;
                if (target.userData.cavityCSG) target.userData.cavityCSG.pointCount = points.length;
            }
        }
        if (points.length === 0) points = getFallbackCavityPoints(target);
        if (points.length === 0) return;

        // ── 2. Tính toán thông số Cavity (LOCAL) ──────────────────────────
        const quantile = (values, ratio) => {
            if (!values.length) return 0;
            const sorted = values.slice().sort((a, b) => a - b);
            const index = THREE.MathUtils.clamp(
                Math.round((sorted.length - 1) * ratio),
                0,
                sorted.length - 1
            );
            return sorted[index];
        };

        const minCorePoints = Math.max(6, Math.floor(points.length * 0.35));
        const trim = isCSGCavity ? (points.length >= 24 ? 0.025 : 0) : (points.length >= 12 ? 0.08 : 0);
        const minX = quantile(points.map(p => p.lx), trim);
        const maxX = quantile(points.map(p => p.lx), 1 - trim);
        const minZ = quantile(points.map(p => p.lz), trim);
        const maxZ = quantile(points.map(p => p.lz), 1 - trim);

        let corePoints = points.filter(p =>
            p.lx >= minX && p.lx <= maxX &&
            p.lz >= minZ && p.lz <= maxZ
        );
        if (corePoints.length < minCorePoints) corePoints = points;

        const pointsBox = new THREE.Box3();
        corePoints.forEach(p => pointsBox.expandByPoint(new THREE.Vector3(p.lx, 0, p.lz)));
        const cavitySize = pointsBox.getSize(new THREE.Vector3());

        const cavityMinY = corePoints.reduce((m, p) => Math.min(m, p.lyBottom), Infinity);
        const cavityMaxY = corePoints.reduce((m, p) => Math.max(m, p.lyTop), -Infinity);
        const cavityHeight = cavityMaxY - cavityMinY;
        if (
            pointsBox.isEmpty() ||
            !Number.isFinite(cavityHeight) ||
            cavityHeight <= 0 ||
            cavitySize.x <= 0 ||
            cavitySize.z <= 0
        ) {
            return;
        }

        // ── 3. Định vị LiquidGroup (Sử dụng LOCAL vì đã là child của target) ──
        let centerX = (pointsBox.min.x + pointsBox.max.x) * 0.5;
        let centerZ = (pointsBox.min.z + pointsBox.max.z) * 0.5;
        const toolLocalBox = getToolLocalMeshBox(target);
        if (!isCSGCavity && toolLocalBox && !toolLocalBox.isEmpty()) {
            const toolCenter = toolLocalBox.getCenter(new THREE.Vector3());
            centerX = toolCenter.x;
            centerZ = toolCenter.z;
        }

        // ── 4. Scale Volume khớp với Cavity (CSG dùng đúng footprint inner mesh) ──
        const horizontalPadding = isCSGCavity ? 0.64 : 0.82;
        const scaleX = isCSGCavity
            ? Math.max(cavitySize.x * horizontalPadding, 1e-4)
            : Math.max(Math.min(cavitySize.x, cavitySize.z) * horizontalPadding, 1e-4);
        const scaleZ = isCSGCavity
            ? Math.max(cavitySize.z * horizontalPadding, 1e-4)
            : scaleX;
        const mouthConstraint = analyzeMouthConstraint(corePoints, pointsBox, cavityMinY, cavityMaxY, isCSGCavity);
        const baseClearance = Math.max(cavityHeight * 0.008, 0.0015);
        const topClearance = Math.max(cavityHeight * mouthConstraint.topClearanceRatio, mouthConstraint.isNecked ? 0.018 : 0.006);
        const requestedLiquidFloorY = resolveLiquidFloorY(target, corePoints, cavityMinY, cavityHeight, isCSGCavity);
        const safeTopY = Math.max(cavityMinY + cavityHeight * 0.2, Math.min(cavityMaxY - topClearance, mouthConstraint.safeTopY));
        const maxBaseY = safeTopY - 1e-4;
        const liquidFloorY = Math.min(requestedLiquidFloorY, maxBaseY);
        const baseY = Math.min(Math.max(cavityMinY + baseClearance, liquidFloorY), maxBaseY);
        const maxFillHeight = Math.max(safeTopY - baseY, 1e-4);
        const liquidFloorN = isCSGCavity ? 0.085 : 0.055;
        target.userData.liquidFloorY = liquidFloorY;
        target.userData.liquidSafeTopY = safeTopY;

        this._ensureLiquidAnchor(volume, {
            centerX,
            centerZ,
            baseY,
            liquidFloorY,
            maxFillHeight,
            scaleX,
            scaleZ,
            cavityMinY,
            cavityMaxY,
            isCSGCavity
        });

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
        volume.isolation = isCSGCavity ? 20 : 18;

        const fillRatio = THREE.MathUtils.clamp(level, 0.025, 0.92);
        const currentFillHeight = maxFillHeight * fillRatio;
        const surfaceY = Math.min(baseY + currentFillHeight, safeTopY);
        const waveFade = THREE.MathUtils.smoothstep(fillRatio, 0.04, 0.2);
        const pourWaveBoost = this.isPouring ? 1.18 : 0.78;
        const surfaceWaveN = mouthConstraint.topWave * waveFade * pourWaveBoost;
        const ceilingLift = Math.max(maxFillHeight * Math.max(surfaceWaveN * 1.45, 0.012), 0.0015);
        const meshCeilingY = Math.min(surfaceY + ceilingLift, safeTopY);

        volume.userData.currentVolume = level;
        volume.userData.maxVolume = 1;
        volume.userData.fillRatio = fillRatio;
        volume.userData.currentFillHeight = currentFillHeight;
        target.userData.currentLiquidVolume = level;
        target.userData.maxLiquidVolume = 1;

        if (isCSGCavity) {
            const columns = buildFilledLiquidColumns(corePoints, 320);
            const strength = columns.length > 260 ? 0.025 : 0.031;
            const subtract = columns.length > 260 ? 7.4 : 7.8;

            columns.forEach((point, index) => {
                const columnBottom = Math.max(point.lyBottom, baseY);
                const columnTop = Math.min(point.lyTop, surfaceY, baseY + maxFillHeight);
                if (columnTop <= columnBottom) return;

                const nx = normalizedInBox(point.lx, pointsBox.min.x, pointsBox.max.x, 0.16);
                const nz = normalizedInBox(point.lz, pointsBox.min.z, pointsBox.max.z, 0.16);
                const bottomN = Math.max(
                    normalizedInBox(columnBottom, baseY, baseY + maxFillHeight, liquidFloorN),
                    liquidFloorN
                );
                const topN = Math.max(
                    normalizedInBox(columnTop, baseY, baseY + maxFillHeight, 0.075),
                    bottomN + 0.012
                );
                const layers = THREE.MathUtils.clamp(Math.ceil((topN - bottomN) / 0.115) + 1, 2, 7);

                for (let layer = 0; layer < layers; layer++) {
                    const t = layers === 1 ? 1 : layer / (layers - 1);
                    const wave = layer === layers - 1
                        ? liquidSurfaceWave(
                            point.gridX ?? point.lx ?? index,
                            point.gridZ ?? point.lz ?? index,
                            this.time,
                            surfaceWaveN,
                            index * 0.013
                        )
                        : 0;
                    const ny = THREE.MathUtils.clamp(THREE.MathUtils.lerp(bottomN, topN, t) + wave, liquidFloorN, 0.92);
                    volume.addBall(nx, ny, nz, strength, subtract);
                }
            });
        } else {
            const gridX = 18;
            const gridZ = 18;
            const topN = Math.max(THREE.MathUtils.lerp(liquidFloorN + 0.025, 0.9, fillRatio), liquidFloorN + 0.02);
            const layers = THREE.MathUtils.clamp(Math.ceil(fillRatio * 7), 2, 7);

            for (let ix = 0; ix < gridX; ix++) {
                for (let iz = 0; iz < gridZ; iz++) {
                    const nx = THREE.MathUtils.mapLinear(ix, 0, gridX - 1, 0.18, 0.82);
                    const nz = THREE.MathUtils.mapLinear(iz, 0, gridZ - 1, 0.18, 0.82);

                    for (let layer = 0; layer < layers; layer++) {
                        const t = layers === 1 ? 1 : layer / (layers - 1);
                        const wave = layer === layers - 1
                            ? liquidSurfaceWave(ix, iz, this.time, surfaceWaveN, (ix + iz) * 0.037)
                            : 0;

                        volume.addBall(
                            nx,
                            THREE.MathUtils.clamp(THREE.MathUtils.lerp(liquidFloorN, topN, t) + wave, liquidFloorN, 0.92),
                            nz,
                            0.062,
                            8
                        );
                    }
                }
            }
        }

        // Ripple tại tâm mặt thoáng
        const rippleNy = Math.max(normalizedInBox(surfaceY, baseY, baseY + maxFillHeight, 0.075), liquidFloorN);
        if (surfaceWaveN > 0.0005) {
            const wobbleA = this.time * 1.15;
            const wobbleB = this.time * 0.9 + 2.1;
            volume.addBall(
                THREE.MathUtils.clamp(0.5 + Math.sin(wobbleA) * 0.075, 0.22, 0.78),
                THREE.MathUtils.clamp(rippleNy + surfaceWaveN * 0.35, liquidFloorN, 0.92),
                THREE.MathUtils.clamp(0.5 + Math.cos(wobbleA * 0.8) * 0.055, 0.22, 0.78),
                isCSGCavity ? 0.018 : 0.055,
                isCSGCavity ? 7.7 : 8
            );
            volume.addBall(
                THREE.MathUtils.clamp(0.5 + Math.sin(wobbleB) * 0.11, 0.2, 0.8),
                THREE.MathUtils.clamp(rippleNy - surfaceWaveN * 0.2, liquidFloorN, 0.92),
                THREE.MathUtils.clamp(0.5 + Math.cos(wobbleB * 0.7) * 0.08, 0.2, 0.8),
                isCSGCavity ? 0.012 : 0.035,
                isCSGCavity ? 7.8 : 8
            );
        }
        if (this.isPouring) {
            const ripple = Math.sin(this.time * 8.0) * 0.02;
            volume.addBall(
                THREE.MathUtils.clamp(0.5 + ripple, 0.18, 0.82),
                THREE.MathUtils.clamp(rippleNy, liquidFloorN, 0.92),
                0.5,
                isCSGCavity ? 0.04 : 0.22,
                isCSGCavity ? 7.5 : 8
            );
        }

        volume.update();
        if (volume.geometry) {
            clampLiquidGeometryToBounds(volume, liquidFloorY, meshCeilingY);
            volume.geometry.computeVertexNormals();
            volume.geometry.computeBoundingBox();
            volume.geometry.computeBoundingSphere();
        }
        updateLiquidFillDebug(volume);
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
        if (target && target.userData?.hasGasEffect !== true) return;
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
                target,
                velocity: new THREE.Vector3((Math.random() - 0.5) * 0.005, 0.015, (Math.random() - 0.5) * 0.005), // Bay ngược lên
                life: 1.0 // Tuổi thọ hạt
            });
        }
    }

    clearSmokeEffectForTarget(target = null) {
        for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
            const p = this.smokeParticles[i];
            if (target && p.target !== target) continue;
            this.scene.remove(p.mesh);
            p.mesh.geometry?.dispose?.();
            if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(material => material.dispose?.());
            else p.mesh.material?.dispose?.();
            this.smokeParticles.splice(i, 1);
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
