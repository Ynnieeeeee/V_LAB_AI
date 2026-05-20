// Reaction client: ưu tiên backend deterministic engine theo ID hóa chất.
// Không còn dùng rule quá rộng kiểu "salt_solution + strong_base" vì dễ sai.

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
    if (!data || !data.has_reaction) {
        return {
            has_reaction: false,
            reason: data?.reason || 'no_reaction',
            foam: data.foam ?? visual.foam ?? effects.foam ?? inferred.foam,
            mascotText: data?.mascot_speech || 'Không có dấu hiệu phản ứng hóa học rõ ràng.'
        };
    }

    const visual = data.visual || {};
    const effects = data.effects || {};
    const inferred = inferVisibleEffects(data);

    const resultColor =
        data.color ||
        visual.result_color ||
        visual.color ||
        '#ffffff';

    const gas = toEffectIntensity(data.gas, visual.gas_effect, effects.gas, inferred.gas);
    const smoke = toEffectIntensity(data.smoke, visual.smoke_effect, effects.smoke, inferred.smoke);
    const fire = toEffectIntensity(data.fire, visual.fire_effect, effects.fire, inferred.fire);
    const explosion = toEffectIntensity(data.explosion, visual.explosion_effect, effects.explosion, inferred.explosion);
    const heat = toEffectIntensity(data.heat, visual.heat_effect, effects.heat, inferred.heat);

    const explicitPrecipitate =
        data.precipitate ??
        data.precipitate_effect ??
        data.has_precipitate ??
        visual.precipitate ??
        visual.precipitate_effect ??
        effects.precipitate ??
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
        precipitate,
        precipitateColor: data.precipitateColor || data.precipitate_color || visual.precipitateColor || visual.precipitate_color || effects.precipitateColor || effects.precipitate_color || inferredPrecipitateColor,
        result_chemical_type: data.reaction_data?.result_chemical_type || data.result_chemical_type || 'generic_solution',
        equation: data.reaction_data?.equation || data.equation || '',
        products: data.reaction_data?.products || data.products || [],
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

    if (!sourceId || !targetId || sourceId === targetId) {
        return { has_reaction: false, reason: 'missing_or_same_chemical_id' };
    }

    try {
        const url = `/api/reactions/check?source_id=${encodeURIComponent(sourceId)}&target_id=${encodeURIComponent(targetId)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return normalizeApiReaction(data);
    } catch (error) {
        console.warn('Backend reaction API unavailable, using verified fallback:', error);
        return fallbackByName(
            source?.userData?.name_vi || source?.userData?.chemicalName,
            target?.userData?.chemicalName || target?.userData?.name_vi
        );
    }
}
