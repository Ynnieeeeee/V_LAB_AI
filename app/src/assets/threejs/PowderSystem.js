import * as THREE from 'three';
import { getToolLocalMeshBox } from './pouringEffect.js?v=20260525-bottle-display-scale';

/**
 * PowderSystem
 * - Dùng cho chemical physical_state/state = Rắn/Solid/Bột.
 * - Rót dạng hạt/bột, không dùng MarchingCubes liquid volume.
 */
export class PowderSystem {
    constructor(scene, maxParticles = 900) {
        this.scene = scene;
        this.maxParticles = maxParticles;
        this.particles = [];
        this.active = false;
        this.color = new THREE.Color('#dddddd');
        this.spawnPosition = new THREE.Vector3();

        this.positions = new Float32Array(maxParticles * 3);
        this.sizes = new Float32Array(maxParticles);
        for (let i = 0; i < maxParticles; i++) {
            this.positions[i * 3] = 0;
            this.positions[i * 3 + 1] = -100;
            this.positions[i * 3 + 2] = 0;
            this.sizes[i] = 0;
        }

        this.geometry = new THREE.BufferGeometry();
        this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

        this.material = new THREE.ShaderMaterial({
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

        this.points = new THREE.Points(this.geometry, this.material);
        this.points.name = 'powder_pouring_stream';
        this.points.userData.isPowder = true;
        this.points.userData.isParticle = true;
        this.points.userData.notDraggable = true;
        this.points.userData.ignoreRaycast = true;
        this.points.raycast = () => null;
        this.scene.add(this.points);
    }

    static isSolidState(state) {
        const s = String(state || '').toLowerCase();
        return s.includes('rắn') || s.includes('ran') || s.includes('solid') || s.includes('powder') || s.includes('bột');
    }

    start(position, color = '#dddddd') {
        this.active = true;
        this.spawnPosition.copy(position || new THREE.Vector3());
        this.color.set(color);
        this.material.uniforms.color.value.copy(this.color);
    }

    emit(position) {
        if (position) this.spawnPosition.copy(position);
    }

    stop() {
        this.active = false;
    }

    spawnOne() {
        if (this.particles.length >= this.maxParticles) return;
        const p = {
            position: this.spawnPosition.clone().add(new THREE.Vector3(
                (Math.random() - 0.5) * 0.035,
                (Math.random() - 0.5) * 0.015,
                (Math.random() - 0.5) * 0.035
            )),
            velocity: new THREE.Vector3(
                (Math.random() - 0.5) * 0.05,
                -0.45 - Math.random() * 0.35,
                (Math.random() - 0.5) * 0.05
            ),
            size: 0.014 + Math.random() * 0.016,
            life: 0,
            maxLife: 2.5 + Math.random() * 1.2
        };
        this.particles.push(p);
    }

    update(dt = 1 / 60) {
        if (this.active) {
            for (let i = 0; i < 18; i++) this.spawnOne();
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life += dt;
            p.velocity.y -= 1.6 * dt;
            p.position.addScaledVector(p.velocity, dt);
            if (p.life > p.maxLife || p.position.y < -2) {
                this.particles.splice(i, 1);
            }
        }

        for (let i = 0; i < this.maxParticles; i++) {
            if (i < this.particles.length) {
                const p = this.particles[i];
                this.positions[i * 3] = p.position.x;
                this.positions[i * 3 + 1] = p.position.y;
                this.positions[i * 3 + 2] = p.position.z;
                this.sizes[i] = p.size;
            } else {
                this.positions[i * 3] = 0;
                this.positions[i * 3 + 1] = -100;
                this.positions[i * 3 + 2] = 0;
                this.sizes[i] = 0;
            }
        }

        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.attributes.size.needsUpdate = true;
    }

    ensureDepositLayer(container) {
        if (!container) return null;
        let layer = container.getObjectByName('powderDepositLayer');
        if (!layer) {
            layer = new THREE.Group();
            layer.name = 'powderDepositLayer';
            layer.userData.isReactionEffect = true;
            layer.userData.notDraggable = true;
            layer.userData.ignoreRaycast = true;
            container.add(layer);
        }
        return layer;
    }

    getLocalCavityInfo(container) {
        container.updateMatrixWorld(true);
        const points = (container.userData?.cavityPoints || []).filter(p =>
            Number.isFinite(p.lx) &&
            Number.isFinite(p.lz) &&
            Number.isFinite(p.lyBottom)
        );
        const localBox = getToolLocalMeshBox(container);
        const toolCenter = localBox?.getCenter?.(new THREE.Vector3());

        if (points.length > 0) {
            const pointBox = new THREE.Box3();
            let bottomY = Infinity;
            points.forEach(p => {
                pointBox.expandByPoint(new THREE.Vector3(p.lx, 0, p.lz));
                bottomY = Math.min(bottomY, p.lyBottom);
            });
            const pointSize = pointBox.getSize(new THREE.Vector3());
            if (!pointBox.isEmpty() && Number.isFinite(bottomY)) {
                return {
                    centerX: toolCenter?.x ?? (pointBox.min.x + pointBox.max.x) * 0.5,
                    centerZ: toolCenter?.z ?? (pointBox.min.z + pointBox.max.z) * 0.5,
                    bottomY: bottomY + 0.018,
                    radiusX: Math.max(pointSize.x * 0.18, 0.018),
                    radiusZ: Math.max(pointSize.z * 0.18, 0.018)
                };
            }
        }

        const min = localBox?.min || new THREE.Vector3(-0.08, -0.08, -0.08);
        const max = localBox?.max || new THREE.Vector3(0.08, 0.08, 0.08);
        const sizeX = Math.max(0.04, Math.abs(max.x - min.x));
        const sizeZ = Math.max(0.04, Math.abs(max.z - min.z));
        const sizeY = Math.max(0.08, Math.abs(max.y - min.y));
        return {
            centerX: toolCenter?.x ?? (min.x + max.x) * 0.5,
            centerZ: toolCenter?.z ?? (min.z + max.z) * 0.5,
            bottomY: Math.min(min.y, max.y) + sizeY * 0.12,
            radiusX: sizeX * 0.27,
            radiusZ: sizeZ * 0.27
        };
    }

    createDeposit(container, options = {}) {
        const layer = this.ensureDepositLayer(container);
        if (!layer) return null;

        const info = this.getLocalCavityInfo(container);
        const amount = Math.floor(options.amount ?? 360);
        const positions = new Float32Array(amount * 3);
        for (let i = 0; i < amount; i++) {
            const r = Math.sqrt(Math.random());
            const a = Math.random() * Math.PI * 2;
            positions[i * 3] = info.centerX + Math.cos(a) * r * info.radiusX;
            positions[i * 3 + 1] = info.bottomY + Math.random() * 0.04;
            positions[i * 3 + 2] = info.centerZ + Math.sin(a) * r * info.radiusZ;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({
            color: options.color || '#dddddd',
            size: options.size ?? 0.012,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.95,
            depthWrite: true
        });
        const deposit = new THREE.Points(geometry, material);
        deposit.name = 'solid_powder_inside_container';
        deposit.userData.isReactionEffect = true;
        deposit.userData.isPowder = true;
        deposit.userData.isParticle = true;
        deposit.userData.notDraggable = true;
        deposit.userData.ignoreRaycast = true;
        deposit.raycast = () => null;
        layer.userData.notDraggable = true;
        layer.userData.ignoreRaycast = true;
        layer.traverse?.(child => {
            child.userData.notDraggable = true;
            child.userData.ignoreRaycast = true;
            child.raycast = () => null;
        });
        layer.add(deposit);
        return deposit;
    }
}

export default PowderSystem;
