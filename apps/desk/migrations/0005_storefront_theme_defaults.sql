UPDATE workspace_settings
SET accent_color = '#c87942',
    canvas_color = '#ffffff',
    ink_color = '#121212',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
  AND accent_color = '#b54a28'
  AND canvas_color = '#f5f2ec'
  AND ink_color = '#191918';
