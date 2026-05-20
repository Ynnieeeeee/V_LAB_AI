// Reaction client: ưu tiên backend deterministic engine theo ID hóa chất.
// Có local deterministic database để chạy đủ phản ứng khi backend chưa sẵn sàng.
import { findLocalReaction } from './ReactionDatabase.js';


function toEffectIntensity(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'number') return Math.max(0, Math.min(2, value));
        if (value === true) return 1;
        if (value === false) continue;
        if (typeof value === 'object') {
            const nested = value.intensity ?? value.power ?? value.strength ?? value.density ?? value.toxicity ?? value.value;
            const n = toEffectIntensity(nested);
            if (n > 0) return n;
        }
    }
    return 0;
}

function inferVisibleEffects(data, text = '') {
    const haystack = [
        text,
        data?.mascot_speech,
        data?.mascotText,
        data?.equation,
        ...(data?.products || [])
    ].join(' ').toLowerCase();

    return {
        gas: /(h₂|h2|co₂|co2|khí|gas|bong bóng|bọt khí|↑)/i.test(haystack),
        smoke: /(khói|smoke|mù|hơi trắng|white fume|fume|nh₄cl|nh4cl)/i.test(haystack),
        fire: /(cháy|bốc cháy|lửa|fire|flame|ignit)/i.test(haystack),
        explosion: /(nổ|explosion|mạnh|violent)/i.test(haystack),
        heat: /(tỏa nhiệt|nóng|heat|exothermic)/i.test(haystack),
        foam: /(bọt|sủi|foam|effervescence)/i.test(haystack),
        precipitate: /(↓|kết tủa|ket tua|precipitate|precipitation|insoluble|không tan|khong tan|agcl|baso₄|baso4|caco₃|caco3|cu\(oh\)₂|cu\(oh\)2|fe\(oh\)₃|fe\(oh\)3|pbcl₂|pbcl2)/i.test(haystack)
    };
}

function normalizeApiReaction(data) {
    const visual = data?.visual || {};
    const effectList = Array.isArray(data?.effects) ? data.effects : [];
    const effects = Array.isArray(data?.effects) ? {} : (data?.effects || {});
    const effectByType = (type) => effectList.find(fx => fx?.type === type);
    const inferred = inferVisibleEffects(data || {});

    if (!data || !data.has_reaction) {
        return {
            has_reaction: false,
            reason: data?.reason || 'no_reaction',
            foam: data?.foam ?? visual.foam ?? effects.foam ?? inferred.foam,
            mascotText: data?.mascot_speech || 'Không có dấu hiệu phản ứng hóa học rõ ràng.'
        };
    }

    const resultColor =
        data.color ||
        visual.result_color ||
        visual.color ||
        '#ffffff';

    const gasEffect = effectByType('gas');
    const smokeEffect = effectByType('smoke');
    const fireEffect = effectByType('fire');
    const heatEffect = effectByType('heat');
    const foamEffect = effectByType('foam');
    const precipitateEffect = effectByType('precipitate');

    const gas = toEffectIntensity(data.gas, gasEffect, visual.gas_effect, effects.gas, inferred.gas);
    const smoke = toEffectIntensity(data.smoke, smokeEffect, visual.smoke_effect, effects.smoke, inferred.smoke);
    const fire = toEffectIntensity(data.fire, fireEffect, visual.fire_effect, effects.fire, inferred.fire);
    const explosion = toEffectIntensity(data.explosion, visual.explosion_effect, effects.explosion, inferred.explosion);
    const heat = toEffectIntensity(data.heat, heatEffect, visual.heat_effect, effects.heat, inferred.heat);

    const explicitPrecipitate =
        data.precipitate ??
        data.precipitate_effect ??
        data.has_precipitate ??
        visual.precipitate ??
        visual.precipitate_effect ??
        effects.precipitate ??
        precipitateEffect ??
        effects.has_precipitate;

    const precipitate = Boolean(explicitPrecipitate ?? inferred.precipitate);

    const inferredPrecipitateColor =
        /xanh lam|xanh dương|blue|cu\(oh\)₂|cu\(oh\)2/i.test([
            data?.mascot_speech,
            data?.mascotText,
            data?.equation,
            ...(data?.products || [])
        ].join(' ').toLowerCase()) ? '#4fc3f7' :
        /nâu đỏ|đỏ nâu|brown|fe\(oh\)₃|fe\(oh\)3/i.test([
            data?.mascot_speech,
            data?.mascotText,
            data?.equation,
            ...(data?.products || [])
        ].join(' ').toLowerCase()) ? '#8b4a2b' :
        /vàng|yellow|pbi₂|pbi2|agi/i.test([
            data?.mascot_speech,
            data?.mascotText,
            data?.equation,
            ...(data?.products || [])
        ].join(' ').toLowerCase()) ? '#ffd54f' :
        '#ffffff';

    return {
        has_reaction: true,
        color: resultColor,
        gas,
        smoke,
        fire,
        explosion,
        heat,
        foam: data.foam ?? visual.foam ?? effects.foam ?? Boolean(foamEffect) ?? inferred.foam,
        precipitate,
        precipitateColor: data.precipitateColor || data.precipitate_color || precipitateEffect?.color || visual.precipitateColor || visual.precipitate_color || effects.precipitateColor || effects.precipitate_color || inferredPrecipitateColor,
        gasColor: data.gasColor || data.gas_color || gasEffect?.color || visual.gasColor || visual.gas_color || effects.gasColor || effects.gas_color,
        smokeColor: data.smokeColor || data.smoke_color || smokeEffect?.color || visual.smokeColor || visual.smoke_color || effects.smokeColor || effects.smoke_color,
        dissolvePrecipitate: Boolean(data.dissolvePrecipitate || data.dissolve_precipitate || visual.dissolvePrecipitate || effectByType('dissolvePrecipitate')),
        mirrorCoating: Boolean(data.mirrorCoating || data.mirror_coating || visual.mirrorCoating || effectByType('mirrorSilver')),
        twoLayerLiquid: Boolean(data.twoLayerLiquid || data.two_layer_liquid || visual.twoLayerLiquid || effectByType('phaseSeparation')),
        decolorize: Boolean(data.decolorize || visual.decolorize || effectByType('decolorize')),
        transparency: data.transparency ?? visual.transparency,
        result_chemical_id: data.reaction_data?.result_chemical_id || data.result_chemical_id,
        result_chemical_type: data.reaction_data?.result_chemical_type || data.result_chemical_type || 'generic_solution',
        equation: data.reaction_data?.equation || data.equation || '',
        products: data.reaction_data?.products || data.products || [],
        effects: effectList.length ? effectList : effects,
        consumes: data.consumes || data.reaction_data?.consumes || {},
        producesState: data.producesState || data.produces_state || data.reaction_data?.producesState || {},
        mascotText: data.mascot_speech || data.mascotText || 'Phản ứng hóa học đã xảy ra.',
        raw: data
    };
}

// Fallback nhỏ khi backend chưa chạy. Chỉ giữ các phản ứng chắc chắn, không đoán rộng.
const VERIFIED_FALLBACK_RULES = [
    // IỐT
    // =====================================================

    {
        names: ['Iốt', 'Glucozơ'],
        result: {
            has_reaction: true,
            color: '#c58a3d',
            heat: false,
            equation: 'I₂ bị khử bởi glucozơ',
            mascotText: 'Màu nâu của iốt nhạt dần.'
        }
    },

    {
        names: ['Iốt', 'Amoniac'],
        result: {
            has_reaction: true,
            explosion: true,
            color: '#553311',
            equation: 'Tạo NI₃',
            mascotText: 'Tạo hợp chất NI₃ nhạy nổ.'
        }
    },

    // =====================================================
    // ETANOL
    // =====================================================

    {
        names: ['Ancol Etylic', 'Oxi'],
        result: {
            has_reaction: true,
            fire: true,
            heat: true,
            equation: 'C₂H₅OH + 3O₂ → 2CO₂ + 3H₂O',
            mascotText: 'Ancol Etylic cháy tạo ngọn lửa xanh.'
        }
    },

    // =====================================================
    // AXIT AXETIC
    // =====================================================

    {
        names: ['Axit Axetic', 'Natri Hydroxit'],
        result: {
            has_reaction: true,
            heat: true,
            color: '#ffffff',
            equation: 'CH₃COOH + NaOH → CH₃COONa + H₂O',
            mascotText: 'Phản ứng trung hòa tạo Natri Axetat.'
        }
    },

    // =====================================================
    // BENZEN
    // =====================================================

    {
        names: ['Benzen', 'Axit Nitric'],
        result: {
            has_reaction: true,
            heat: true,
            color: '#f5e28a',
            equation: 'C₆H₆ + HNO₃ → C₆H₅NO₂ + H₂O',
            mascotText: 'Xảy ra phản ứng nitro hóa benzen.'
        }
    }
];

function fallbackByName(sourceName, targetName) {
    const a = String(sourceName || '').toLowerCase().trim();
    const b = String(targetName || '').toLowerCase().trim();

    for (const rule of VERIFIED_FALLBACK_RULES) {
        const [x, y] = rule.names.map(v => v.toLowerCase().trim());
        if ((a === x && b === y) || (a === y && b === x)) {
            return { ...rule.result };
        }
    }

    return { has_reaction: false, reason: 'no_verified_fallback_rule' };
}

export async function detectReaction(source, target) {
    const sourceId = source?.userData?.id_chemical || source?.userData?.current_chemical_id;
    const targetId = target?.userData?.current_chemical_id || target?.userData?.id_chemical;

    // Local database được kiểm tra trước để hỗ trợ phản ứng nhiều giai đoạn dựa trên contents/products.
    const local = findLocalReaction(source, target);
    if (local?.has_reaction) return normalizeApiReaction(local);

    // Nếu thiếu ID, vẫn cho phép fallback theo tên/contents thay vì chặn hoàn toàn.
    if (!sourceId || !targetId || sourceId === targetId) {
        return fallbackByName(
            source?.userData?.name_vi || source?.userData?.chemicalName || source?.userData?.current_chemical_name,
            target?.userData?.chemicalName || target?.userData?.name_vi || target?.userData?.current_chemical_name
        );
    }

    try {
        const url = `/api/reactions/check?source_id=${encodeURIComponent(sourceId)}&target_id=${encodeURIComponent(targetId)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const normalized = normalizeApiReaction(data);
        if (normalized?.has_reaction) return normalized;
        return local;
    } catch (error) {
        console.warn('Backend reaction API unavailable, using local reaction database:', error);
        return local?.has_reaction ? normalizeApiReaction(local) : fallbackByName(
            source?.userData?.name_vi || source?.userData?.chemicalName || source?.userData?.current_chemical_name,
            target?.userData?.chemicalName || target?.userData?.name_vi || target?.userData?.current_chemical_name
        );
    }
}
