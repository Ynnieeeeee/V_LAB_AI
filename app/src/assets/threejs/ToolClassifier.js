const HEATING_SOURCE_KEYWORDS = [
    'den con',
    'bep',
    'bep dien',
    'bep gia nhiet',
    'bep dun',
    'den dot',
    'den bunsen',
    'mo dot',
    'nguon nhiet',
    'alcohol lamp',
    'burner',
    'bunsen burner',
    'hot plate',
    'heater',
    'heating plate'
];

const CONTAINER_KEYWORDS = [
    'ong nghiem',
    'coc thuy tinh',
    'coc',
    'binh tam giac',
    'binh cau',
    'binh',
    'dung cu chua',
    'vat chua',
    'container',
    'vessel',
    'beaker',
    'test tube',
    'flask',
    'erlenmeyer',
    'tube',
    'jar',
    'cup'
];

export function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function hasKeyword(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
}

export function isHeatingSourceName(text = '') {
    return hasKeyword(text, HEATING_SOURCE_KEYWORDS);
}

export function isContainerName(text = '') {
    return hasKeyword(text, CONTAINER_KEYWORDS);
}

export function classifyToolByName(nameVi = '', nameEn = '') {
    const text = normalizeText(`${nameVi} ${nameEn}`);

    if (isHeatingSourceName(text)) {
        return {
            tool_type: 'heating_source',
            is_heating_source: true,
            heating_power: 8,
            max_temperature: 120,
            is_toggleable: true
        };
    }

    if (isContainerName(text)) {
        return {
            tool_type: 'container',
            is_heating_source: false,
            heating_power: 0,
            max_temperature: 25,
            is_toggleable: false
        };
    }

    console.warn('[ToolClassifier] Unknown tool type:', nameVi, nameEn);
    return {
        tool_type: 'unknown',
        is_heating_source: false,
        heating_power: 0,
        max_temperature: 25,
        is_toggleable: false
    };
}

function coerceBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function coerceNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function applyToolMetadataToObject(model, tool = {}) {
    if (!model?.userData) return model;

    const hasDbMetadata = Boolean(tool.tool_type || tool.is_heating_source !== undefined || tool.is_toggleable !== undefined);
    const fallback = hasDbMetadata
        ? {
            tool_type: 'unknown',
            is_heating_source: false,
            heating_power: 0,
            max_temperature: 25,
            is_toggleable: false
        }
        : classifyToolByName(tool.name_tool_vi || tool.name_vi, tool.name_tool_en || tool.name_en);
    const toolType = tool.tool_type || fallback.tool_type || 'unknown';
    const isHeatingSource = coerceBoolean(tool.is_heating_source, fallback.is_heating_source);
    const heatingPower = coerceNumber(tool.heating_power, fallback.heating_power);
    const maxTemperature = coerceNumber(tool.max_temperature, fallback.max_temperature || 25);
    const isToggleable = coerceBoolean(tool.is_toggleable, fallback.is_toggleable);

    model.userData.toolType = toolType;
    model.userData.isHeatingSource = isHeatingSource;
    model.userData.heatingPower = heatingPower;
    model.userData.maxTemperature = maxTemperature;
    model.userData.isToggleable = isToggleable;
    model.userData.isOn = Boolean(model.userData.isOn && isHeatingSource && isToggleable);
    model.userData.currentTemperature = coerceNumber(model.userData.currentTemperature, 25);
    model.userData.temperature = coerceNumber(model.userData.temperature, model.userData.currentTemperature);

    if (toolType === 'unknown' && hasDbMetadata) {
        const key = `${tool.name_tool_vi || tool.name_vi || ''}|${tool.name_tool_en || tool.name_en || ''}`;
        if (model.userData.lastUnknownToolWarning !== key) {
            console.warn('[ToolClassifier] Unknown tool type:', tool.name_tool_vi || tool.name_vi, tool.name_tool_en || tool.name_en);
            model.userData.lastUnknownToolWarning = key;
        }
    }

    return model;
}
