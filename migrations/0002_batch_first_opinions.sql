-- Keep the original <=4 request acceptance path as the default.
-- Preserve an explicit user choice if they changed the setting in the Mini App.
update settings
set value = 'false', updated_at = '2024-01-01T00:00:00.000Z'
where key = 'parallel_round1'
  and value = 'true'
  and updated_at = '2024-01-01T00:00:00.000Z';
