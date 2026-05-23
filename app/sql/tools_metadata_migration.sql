ALTER TABLE public.tools
ADD COLUMN IF NOT EXISTS tool_type text DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS is_heating_source boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS heating_power double precision DEFAULT 0,
ADD COLUMN IF NOT EXISTS max_temperature double precision DEFAULT 25,
ADD COLUMN IF NOT EXISTS is_toggleable boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS ports jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS attach_points jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS assembly_role text DEFAULT 'none';

UPDATE public.tools
SET
  tool_type = 'heating_source',
  is_heating_source = true,
  heating_power = 8,
  max_temperature = 120,
  is_toggleable = true
WHERE lower(name_tool_vi) LIKE '%den con%'
   OR lower(name_tool_vi) LIKE '%đèn cồn%'
   OR lower(name_tool_vi) LIKE '%bếp%'
   OR lower(name_tool_vi) LIKE '%bep%'
   OR lower(name_tool_vi) LIKE '%nguồn nhiệt%'
   OR lower(name_tool_vi) LIKE '%nguon nhiet%'
   OR lower(name_tool_en) LIKE '%alcohol lamp%'
   OR lower(name_tool_en) LIKE '%burner%'
   OR lower(name_tool_en) LIKE '%hot plate%'
   OR lower(name_tool_en) LIKE '%heater%'
   OR lower(name_tool_en) LIKE '%heating plate%';

UPDATE public.tools
SET
  tool_type = 'container',
  is_heating_source = false,
  heating_power = 0,
  max_temperature = 25,
  is_toggleable = false
WHERE lower(name_tool_vi) LIKE '%ống nghiệm%'
   OR lower(name_tool_vi) LIKE '%ong nghiem%'
   OR lower(name_tool_vi) LIKE '%cốc%'
   OR lower(name_tool_vi) LIKE '%coc%'
   OR lower(name_tool_vi) LIKE '%bình%'
   OR lower(name_tool_vi) LIKE '%binh%'
   OR lower(name_tool_en) LIKE '%test tube%'
   OR lower(name_tool_en) LIKE '%beaker%'
   OR lower(name_tool_en) LIKE '%flask%'
   OR lower(name_tool_en) LIKE '%container%'
   OR lower(name_tool_en) LIKE '%vessel%';


ALTER TABLE public.tools
ADD COLUMN IF NOT EXISTS rotation_x double precision DEFAULT 0,
ADD COLUMN IF NOT EXISTS rotation_y double precision DEFAULT 0,
ADD COLUMN IF NOT EXISTS rotation_z double precision DEFAULT 0;
