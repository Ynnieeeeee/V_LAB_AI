import * as THREE from 'three';
import { PrecipitateSystem } from './PrecipitateSystem.js';
import { GasEmitter } from './GasEmitter.js';
import { PowderSystem } from './PowderSystem.js';
import {
    spawnFireParticles,
    spawnSmoke,
    spawnGasCloud,
    createShockwave,
    heatDistortion,
    spawnFoam,
    dissolvePrecipitate,
    mirrorSilver,
    phaseSeparation,
    decolorizeLiquid
} from './reactionEffects.js';
import {
    hasGasProduct,
    hasExplicitSmoke,
    shouldEmitSmokeOrGas,
    reactionGasDebug
} from './reactionGasUtils.js';

const DEFAULT_REACTION_HEAT_TEMPERATURE = 45;

/**
 * ReactionManager
 * Trung tâm render phản ứng:
 * - Kết tủa: gắn vào container local-space.
 * - Bột/rắn: dùng PowderSystem, không dùng liquid MarchingCubes.
 * - Khí/khói/cháy/nổ/nhiệt: world-space từ miệng dụng cụ.
 */
export class ReactionManager {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.precipitateSystem = options.precipitateSystem || new PrecipitateSystem(scene);
        this.gasEmitter = options.gasEmitter || new GasEmitter(scene);
        this.powderSystem = options.powderSystem || new PowderSystem(scene);
        this.clock = new THREE.Clock();
    }

    normalizeIntensity(value, fallback = 1) {
        if (value === true) return fallback;
        if (typeof value === 'number') return value;
        if (typeof value === 'object' && value !== null) {
            return value.intensity ?? value.power ?? value.strength ?? value.density ?? fallback;
        }
        return 0;
    }

    normalizeReaction(reaction = {}) {
        const visual = reaction.visual || {};
        const effects = reaction.effects || {};
        const gasAllowed = shouldEmitSmokeOrGas(reaction);
        return {
            hasReaction: Boolean(reaction.has_reaction ?? reaction.hasReaction ?? reaction.has_reaction === undefined),
            color: reaction.color || visual.result_color || visual.color,
            precipitate: Boolean(reaction.precipitate ?? visual.precipitate ?? effects.precipitate),
            precipitateColor: reaction.precipitateColor || reaction.precipitate_color || visual.precipitate_color || effects.precipitateColor || '#ffffff',
            gas: gasAllowed ? (reaction.gas ?? visual.gas_effect ?? effects.gas ?? hasGasProduct(reaction)) : false,
            smoke: gasAllowed ? (reaction.smoke ?? visual.smoke_effect ?? effects.smoke ?? false) : false,
            vapor: gasAllowed ? (reaction.vapor ?? visual.vapor_effect ?? effects.vapor ?? false) : false,
            fire: reaction.fire ?? visual.fire_effect ?? effects.fire ?? false,
            explosion: reaction.explosion ?? visual.explosion_effect ?? effects.explosion ?? false,
            heat: reaction.heat ?? visual.heat_effect ?? effects.heat ?? false,
            foam: gasAllowed && (reaction.foam ?? visual.foam ?? effects.foam ?? false),
            dissolvePrecipitate: Boolean(reaction.dissolvePrecipitate || reaction.dissolve_precipitate),
            mirrorCoating: Boolean(reaction.mirrorCoating || reaction.mirrorSilver),
            twoLayerLiquid: Boolean(reaction.twoLayerLiquid || reaction.phaseSeparation),
            decolorize: Boolean(reaction.decolorize),
            raw: reaction
        };
    }

    reactionTemperatureTarget(reaction = {}) {
        const raw = reaction.raw || {};
        const conditions = reaction.conditions || raw.conditions || raw.reaction_data?.conditions || {};
        const value =
            reaction.target_temperature ??
            reaction.targetTemperature ??
            reaction.requiredTemperature ??
            reaction.required_temperature ??
            conditions.minTemperature ??
            raw.requiredTemperature ??
            raw.required_temperature;
        const n = Number(value);
        if (Number.isFinite(n)) return n;
        if (reaction.heating_required || reaction.heatingRequired) return DEFAULT_REACTION_HEAT_TEMPERATURE;
        return null;
    }

    checkTemperature(container, reaction = {}) {
        if (!reaction.heating_required && !reaction.heatingRequired && this.reactionTemperatureTarget(reaction) === null) {
            return true;
        }
        const current = Number(container?.userData?.currentTemperature ?? container?.userData?.temperature ?? 25);
        const target = this.reactionTemperatureTarget(reaction);
        const tolerance = Number(reaction.temperature_tolerance ?? reaction.temperatureTolerance ?? 5);
        if (target === null) return false;
        return current >= target - tolerance;
    }

    checkCatalyst(container, reaction = {}) {
        const raw = reaction.raw || {};
        const conditions = reaction.conditions || raw.conditions || raw.reaction_data?.conditions || {};
        const catalyst = reaction.catalyst || conditions.catalyst;
        if (!catalyst || !container?.userData) return true;
        const needle = String(catalyst).toLowerCase();
        const values = [
            ...(container.userData.contents || []),
            ...(container.userData.products || []),
            ...Object.keys(container.userData.composition || {}),
            container.userData.current_chemical_name,
            container.userData.chemicalName
        ].filter(Boolean).map(value => String(value).toLowerCase());
        return values.some(value => value.includes(needle) || needle.includes(value));
    }

    notifySetupIssue(validation) {
        const message = validation?.message;
        if (!message) return;
        const appWindow = typeof window !== 'undefined' ? window : null;
        if (typeof appWindow?.triggerMascotSpeech === 'function') {
            appWindow.triggerMascotSpeech(message);
        } else if (typeof appWindow?.mascotTalk === 'function') {
            appWindow.mascotTalk(message);
        }
    }

    validateSetupBeforeReaction(container, reaction = {}) {
        const appWindow = typeof window !== 'undefined' ? window : null;
        return appWindow?.labAssemblyManager?.validateReactionSetup?.(reaction, container) || { ok: true };
    }

    tryTriggerPendingReaction(container) {
        const reaction = container?.userData?.pendingReaction;
        if (!reaction) return null;
        const temperatureOk = this.checkTemperature(container, reaction);
        const catalystOk = this.checkCatalyst(container, reaction);
        const setupValidation = this.validateSetupBeforeReaction(container, reaction);
        console.log('[ReactionManager] pending reaction:', reaction.name || reaction.id);
        console.log('[ReactionManager] temperature ok:', temperatureOk);
        if (setupValidation && !setupValidation.ok) {
            console.log('[ReactionManager] setup ok:', false, setupValidation.missing);
            this.notifySetupIssue(setupValidation);
            return null;
        }
        if (!temperatureOk || !catalystOk) return null;
        container.userData.pendingReaction = null;
        container.userData.pendingReason = null;
        return this.apply(container, { ...reaction, has_reaction: true }, { skipSetupValidation: true });
    }

    getContainerMouthPosition(container, fallback = null) {
        if (fallback) return fallback.clone();
        if (!container) return new THREE.Vector3();
        container.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(container);
        const center = new THREE.Vector3();
        box.getCenter(center);
        center.y = box.max.y + 0.035;
        return center;
    }

    apply(container, reaction, options = {}) {
        if (!container || !reaction) return null;
        if (options.skipSetupValidation !== true) {
            const setupValidation = this.validateSetupBeforeReaction(container, reaction);
            if (setupValidation && !setupValidation.ok) {
                console.log('[ReactionManager] setup ok:', false, setupValidation.missing);
                this.notifySetupIssue(setupValidation);
                return null;
            }
        }
        const fx = this.normalizeReaction(reaction);
        if (!fx.hasReaction && !fx.precipitate && !fx.gas && !fx.smoke && !fx.fire) return null;

        const position = this.getContainerMouthPosition(container, options.position);
        const result = { position, effects: [] };
        const gasAllowed = shouldEmitSmokeOrGas(reaction);
        console.debug('[ReactionFX] ReactionManager gas gate', {
            ...reactionGasDebug(reaction),
            effectActuallyTriggered: []
        });

        // Kết tủa phải nằm trong dụng cụ, dùng local child layer.
        if (fx.precipitate) {
            result.precipitate = this.precipitateSystem.create(container, {
                color: fx.precipitateColor,
                amount: options.precipitateAmount ?? 620
            });
            result.effects.push('precipitate');
        }

        // Bọt khí nhẹ nằm gần mặt dung dịch, gas cloud bay lên.
        const gasIntensity = this.normalizeIntensity(fx.gas, 1);
        if (gasAllowed && gasIntensity > 0) {
            result.gas = this.gasEmitter.bubbles(container, {
                position,
                amount: Math.floor(80 * Math.min(2, gasIntensity)),
                color: options.gasColor || '#ffffff'
            });
            // Giữ tương thích với reactionEffects.js sẵn có.
            spawnGasCloud?.(this.scene, position, { toxicity: gasIntensity });
            result.effects.push('gas');
        }

        if (gasAllowed && fx.foam) { result.foam = this.gasEmitter.bubbles(container, { position, amount: 140, color: '#ffffff' }); }
        if (gasAllowed && fx.foam) {
            spawnFoam?.(this.scene, position, { intensity: this.normalizeIntensity(fx.foam, 1) || 1 });
            result.effects.push('foam');
        }

        const smokeIntensity = this.normalizeIntensity(fx.smoke || fx.vapor, 1);
        if (gasAllowed && hasExplicitSmoke(reaction) && smokeIntensity > 0) {
            result.smoke = this.gasEmitter.smoke(container, {
                position,
                amount: Math.floor(70 * Math.min(2, smokeIntensity)),
                color: options.smokeColor || '#d8d8d8'
            });
            spawnSmoke?.(this.scene, position, { density: smokeIntensity });
            result.effects.push('smoke');
        }

        const fireIntensity = this.normalizeIntensity(fx.fire, 1);
        if (fireIntensity > 0) {
            spawnFireParticles?.(this.scene, position, { intensity: fireIntensity });
            result.effects.push('fire');
        }

        const explosionPower = this.normalizeIntensity(fx.explosion, 1);
        if (explosionPower > 0) {
            createShockwave?.(this.scene, position, { power: explosionPower });
            result.effects.push('explosion');
        }

        const heatStrength = this.normalizeIntensity(fx.heat, 1);
        if (heatStrength > 0) {
            heatDistortion?.(this.scene, position, { strength: heatStrength });
            result.effects.push('heat');
        }

        if (fx.dissolvePrecipitate) {
            dissolvePrecipitate?.(container);
            result.effects.push('dissolvePrecipitate');
        }

        if (fx.mirrorCoating) {
            mirrorSilver?.(container);
            result.effects.push('mirrorSilver');
        }

        if (fx.twoLayerLiquid) {
            phaseSeparation?.(container);
            result.effects.push('phaseSeparation');
        }

        if (fx.decolorize) {
            decolorizeLiquid?.(container, fx.color || '#ffffff');
            result.effects.push('decolorize');
        }

        console.debug('[ReactionFX] ReactionManager triggered effects', {
            ...reactionGasDebug(reaction),
            effectActuallyTriggered: result.effects
        });
        return result;
    }

    startPowderPour(position, color) {
        this.powderSystem.start(position, color);
    }

    emitPowder(position) {
        this.powderSystem.emit(position);
    }

    stopPowderPour() {
        this.powderSystem.stop();
    }

    createPowderDeposit(container, options = {}) {
        return this.powderSystem.createDeposit(container, options);
    }

    update(dt = null) {
        const delta = dt ?? Math.min(0.05, this.clock.getDelta());
        this.precipitateSystem.update(delta);
        this.gasEmitter.update(delta);
        this.powderSystem.update(delta);
    }
}

export function createDefaultReactionManager(scene, options = {}) {
    return new ReactionManager(scene, options);
}

export default ReactionManager;
