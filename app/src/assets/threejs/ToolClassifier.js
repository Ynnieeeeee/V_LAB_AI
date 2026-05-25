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

const SUPPORT_STAND_KEYWORDS = [
    'gia do',
    'gia thi nghiem',
    'kieng ba chan',
    'chan de',
    'tripod stand',
    'lab stand',
    'support stand',
    'ring stand'
];

const DROPPING_FUNNEL_KEYWORDS = ['pheu nho giot', 'phieu nho giot', 'dropping funnel', 'addition funnel'];
const GAS_TUBE_KEYWORDS = ['ong dan khi', 'ong thuy tinh dan khi', 'ong cao su dan khi', 'gas tube', 'delivery tube', 'rubber tubing', 'glass tubing'];
const GAS_COLLECTOR_KEYWORDS = ['binh thu khi', 'chau thu khi', 'ong thu khi', 'gas jar', 'gas collector', 'collection bottle'];
const STIRRING_TOOL_KEYWORDS = ['dua thuy tinh', 'que khuay', 'glass rod', 'stirring rod', 'stirrer'];
const MEASURING_TOOL_KEYWORDS = ['ong dong', 'ong do', 'ong chia vach', 'pipet', 'pipette', 'measuring cylinder', 'graduated cylinder', 'buret', 'burette'];
const FUNNEL_KEYWORDS = ['pheu loc', 'pheu', 'filter funnel', 'funnel'];
const CLAMP_TOOL_KEYWORDS = ['kep', 'kep ong nghiem', 'kep go', 'clamp', 'utility clamp', 'test tube clamp', 'bosshead'];
const STOPPER_KEYWORDS = ['nut cao su', 'nut binh', 'nut day', 'rubber stopper', 'stopper', 'bung'];

export function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
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

export function isSupportStandName(text = '') {
    return hasKeyword(text, SUPPORT_STAND_KEYWORDS);
}

function baseMeta(toolType, capabilities = [], ports = {}, attachPoints = {}, assemblyRole = 'none') {
    return {
        tool_type: toolType,
        is_heating_source: false,
        heating_power: 0,
        max_temperature: 25,
        is_toggleable: false,
        is_support_stand: false,
        can_support_tools: false,
        support_height: 0.8,
        support_radius: 1.0,
        capabilities,
        ports,
        attach_points: attachPoints,
        assembly_role: assemblyRole
    };
}

function containerMeta() {
    return baseMeta(
        'container',
        ['contain_liquid', 'contain_solid', 'receive_liquid', 'react', 'heat_target'],
        {
            opening: { type: 'opening', offset: [0, 1, 0] },
            gas_out: { type: 'gas_out', offset: [0.3, 1, 0] }
        },
        {
            bottom: { type: 'support_target', offset: [0, -0.5, 0] },
            bottom_slot: { type: 'support_target', offset: [0, -0.5, 0] },
            center_slot: { type: 'center_slot', offset: [0, 0, 0] },
            clamp_target: { type: 'clamp_target', offset: [0, 0.45, 0] },
            holder_slot: { type: 'clamp_target', offset: [0, 0.45, 0] },
            heat_target: { type: 'heat_target', offset: [0, -0.45, 0] },
            heat_slot: { type: 'heat_target', offset: [0, -0.45, 0] }
        },
        'reaction_vessel'
    );
}

function supportStandMeta() {
    const meta = baseMeta(
        'support_stand',
        ['support', 'clamp', 'heat_target'],
        {},
        {
            support_top: { type: 'support_top', offset: [0, 0.8, 0] },
            top_slot: { type: 'support_top', offset: [0, 0.8, 0] },
            container_slot: { type: 'support_top', offset: [0, 0.8, 0] },
            clamp_point: { type: 'clamp_point', offset: [0.3, 1.2, 0] },
            holder_slot: { type: 'clamp_point', offset: [0.3, 1.2, 0] },
            heat_target: { type: 'heat_target', offset: [0, -0.35, 0] },
            heat_slot: { type: 'heat_target', offset: [0, -0.35, 0] }
        },
        'support'
    );
    return { ...meta, is_support_stand: true, can_support_tools: true };
}

function heatingSourceMeta() {
    const meta = baseMeta(
        'heating_source',
        ['heat'],
        {},
        {
            heating_zone: { type: 'heating_zone', offset: [0, 0.3, 0] },
            heat_slot: { type: 'heating_zone', offset: [0, 0.3, 0] },
            top_slot: { type: 'heating_zone', offset: [0, 0.3, 0] }
        },
        'heating_source'
    );
    return { ...meta, is_heating_source: true, heating_power: 8, max_temperature: 120, is_toggleable: true };
}

function droppingFunnelMeta() {
    return baseMeta(
        'dropping_funnel',
        ['contain_liquid', 'drop_liquid'],
        {
            opening: { type: 'liquid_in', offset: [0, 0.5, 0] },
            liquid_out: { type: 'liquid_out', offset: [0, -0.5, 0] }
        },
        { clamp_target: { type: 'clamp_target', offset: [0, 0.2, 0] } },
        'liquid_feeder'
    );
}

function gasTubeMeta() {
    return baseMeta(
        'gas_tube',
        ['transfer_gas'],
        {
            gas_in: { type: 'gas_in', offset: [-0.5, 0, 0] },
            gas_out: { type: 'gas_out', offset: [0.5, 0, 0] }
        },
        {},
        'gas_transfer'
    );
}

function gasCollectorMeta() {
    return baseMeta(
        'gas_collector',
        ['collect_gas', 'contain_gas'],
        { gas_in: { type: 'gas_in', offset: [0, 0.8, 0] } },
        {},
        'gas_collector'
    );
}

function stopperMeta() {
    return baseMeta(
        'stopper',
        ['seal', 'connect_gas', 'receive_liquid'],
        {
            bottom: { type: 'liquid_out', offset: [0, -0.5, 0] },
            opening: { type: 'liquid_in', offset: [0, 0.5, 0] },
            gas_out: { type: 'gas_out', offset: [0.5, 0.1, 0] }
        },
        {
            bottom_slot: { type: 'liquid_out', offset: [0, -0.5, 0] },
            top_slot: { type: 'liquid_in', offset: [0, 0.5, 0] },
            holder_slot: { type: 'clamp_target', offset: [0, 0.15, 0] }
        },
        'sealed_adapter'
    );
}

function stirringToolMeta() {
    return baseMeta('stirring_tool', ['stir'], {}, {}, 'stirrer');
}

function measuringToolMeta() {
    return baseMeta(
        'measuring_tool',
        ['measure_volume', 'contain_liquid', 'drop_liquid'],
        { liquid_out: { type: 'liquid_out', offset: [0, -0.5, 0] } },
        {},
        'measuring'
    );
}

function funnelMeta() {
    return baseMeta(
        'funnel',
        ['receive_liquid', 'transfer_liquid', 'filter'],
        {
            opening: { type: 'liquid_in', offset: [0, 0.4, 0] },
            liquid_out: { type: 'liquid_out', offset: [0, -0.45, 0] }
        },
        {},
        'liquid_transfer'
    );
}

function clampToolMeta() {
    return baseMeta(
        'clamp_tool',
        ['clamp'],
        {},
        {
            clamp_point: { type: 'clamp_point', offset: [0, 0.15, 0] }
        },
        'clamp'
    );
}

export function classifyToolByName(nameVi = '', nameEn = '') {
    const text = normalizeText(`${nameVi} ${nameEn}`);

    if (hasKeyword(text, DROPPING_FUNNEL_KEYWORDS)) return droppingFunnelMeta();
    if (hasKeyword(text, STOPPER_KEYWORDS)) return stopperMeta();
    if (hasKeyword(text, GAS_TUBE_KEYWORDS)) return gasTubeMeta();
    if (hasKeyword(text, GAS_COLLECTOR_KEYWORDS)) return gasCollectorMeta();
    if (isSupportStandName(text)) {
        return supportStandMeta();
    }

    if (isHeatingSourceName(text)) {
        return heatingSourceMeta();
    }

    if (hasKeyword(text, STIRRING_TOOL_KEYWORDS)) return stirringToolMeta();
    if (hasKeyword(text, MEASURING_TOOL_KEYWORDS)) return measuringToolMeta();
    if (hasKeyword(text, CLAMP_TOOL_KEYWORDS)) return clampToolMeta();
    if (hasKeyword(text, FUNNEL_KEYWORDS)) return funnelMeta();
    if (isContainerName(text)) {
        return containerMeta();
    }

    console.warn('[ToolClassifier] Unknown tool type:', nameVi, nameEn);
    return baseMeta('unknown');
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

function coerceJsonObject(value, fallback = {}) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
        } catch {
            return fallback;
        }
    }
    return fallback;
}

function coerceJsonArray(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch {
            return fallback;
        }
    }
    return fallback;
}

export function applyToolMetadataToObject(model, tool = {}) {
    if (!model?.userData) return model;

    const nameFallback = classifyToolByName(tool.name_tool_vi || tool.name_vi, tool.name_tool_en || tool.name_en);
    const hasDbMetadata = Boolean(tool.tool_type || tool.is_heating_source !== undefined || tool.is_toggleable !== undefined);
    const fallback = hasDbMetadata
        ? {
            ...nameFallback,
            tool_type: tool.tool_type || nameFallback.tool_type || 'unknown',
            is_heating_source: coerceBoolean(tool.is_heating_source, nameFallback.is_heating_source),
            is_toggleable: coerceBoolean(tool.is_toggleable, nameFallback.is_toggleable)
        }
        : nameFallback;
    const toolType = tool.tool_type || fallback.tool_type || 'unknown';
    const isSupportStand = toolType === 'support_stand' || coerceBoolean(tool.is_support_stand, fallback.is_support_stand);
    const isHeatingSource = isSupportStand ? false : coerceBoolean(tool.is_heating_source, fallback.is_heating_source);
    const heatingPower = coerceNumber(tool.heating_power, fallback.heating_power);
    const maxTemperature = coerceNumber(tool.max_temperature, fallback.max_temperature || 25);
    const isToggleable = coerceBoolean(tool.is_toggleable, fallback.is_toggleable);
    const canSupportTools = coerceBoolean(tool.can_support_tools, fallback.can_support_tools);
    const supportHeight = coerceNumber(tool.support_height, fallback.support_height || 0.8);
    const supportRadius = coerceNumber(tool.support_radius, fallback.support_radius || 1.0);
    const rawCapabilities = coerceJsonArray(tool.capabilities, fallback.capabilities || []);
    const rawPorts = coerceJsonObject(tool.ports, fallback.ports || {});
    const rawAttachPoints = coerceJsonObject(tool.attach_points, fallback.attach_points || {});
    const capabilities = rawCapabilities.length ? rawCapabilities : (fallback.capabilities || []);
    const ports = Object.keys(rawPorts).length ? rawPorts : (fallback.ports || {});
    const attachPoints = Object.keys(rawAttachPoints).length ? rawAttachPoints : (fallback.attach_points || {});
    const assemblyRole = tool.assembly_role || fallback.assembly_role || 'none';

    model.userData.toolType = toolType;
    model.userData.isHeatingSource = isHeatingSource;
    model.userData.heatingPower = isSupportStand ? 0 : heatingPower;
    model.userData.maxTemperature = isSupportStand ? 25 : maxTemperature;
    model.userData.isToggleable = isSupportStand ? false : isToggleable;
    model.userData.isSupportStand = isSupportStand;
    model.userData.canSupportTools = isSupportStand ? true : canSupportTools;
    model.userData.supportHeight = supportHeight;
    model.userData.supportRadius = supportRadius;
    model.userData.capabilities = capabilities;
    model.userData.ports = ports;
    model.userData.attachPoints = attachPoints;
    model.userData.attach_points = attachPoints;
    model.userData.assemblyRole = assemblyRole;
    model.userData.assembly_role = assemblyRole;
    model.userData.isOn = Boolean(model.userData.isOn && isHeatingSource && model.userData.isToggleable);
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
