-- Seed/refresh the loyalty-program reference table. Idempotent (INSERT OR
-- REPLACE) so it can be re-run after edits. Mirrors
-- shared/src/data/programs.ts — keep the two in sync.
-- Run: npm run db:seed:local  (or db:seed:remote)

INSERT OR REPLACE INTO programs (code, name, kind, alliance, transfer_partners, is_active) VALUES
  ('aeroplan',       'Air Canada Aeroplan',            'airline', 'star',     '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('lifemiles',      'Avianca LifeMiles',              'airline', 'star',     '[{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('turkish',        'Turkish Miles&Smiles',           'airline', 'star',     '[{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('united',         'United MileagePlus',             'airline', 'star',     '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"}]', 1),
  ('eva',            'EVA Air Infinity MileageLands',  'airline', 'star',     '[{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('ana',            'ANA Mileage Club',               'airline', 'star',     '[]', 1),
  ('singapore',      'Singapore KrisFlyer',            'airline', 'star',     '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('flyingblue',     'Air France/KLM Flying Blue',     'airline', 'skyteam',  '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  -- No transfer partners: Delta takes Amex only, which the couple doesn't hold.
  ('skymiles',       'Delta SkyMiles',                 'airline', 'skyteam',  '[]', 1),
  ('virginatlantic', 'Virgin Atlantic Flying Club',    'airline', NULL,       '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  -- Renamed from Club Premier. Capital One and Citi only; no Chase, no Bilt.
  ('aeromexico',     'Aeroméxico Rewards',             'airline', 'skyteam',  '[{"currency":"capital_one","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('avios',          'Avios (BA/Iberia/Aer Lingus/Qatar/Finnair)', 'airline', 'oneworld', '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('aadvantage',     'American AAdvantage',            'airline', 'oneworld', '[{"currency":"bilt","ratio":"1:1"}]', 1),
  ('alaska',         'Alaska Mileage Plan',            'airline', 'oneworld', '[{"currency":"bilt","ratio":"1:1"}]', 1),
  ('cathay',         'Cathay Pacific Asia Miles',      'airline', 'oneworld', '[{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('jetblue',        'JetBlue TrueBlue',               'airline', NULL,       '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('qantas',         'Qantas Frequent Flyer',          'airline', 'oneworld', '[{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('emirates',       'Emirates Skywards',              'airline', NULL,       '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('etihad',         'Etihad Guest',                   'airline', NULL,       '[{"currency":"capital_one","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"},{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('hyatt',          'World of Hyatt',                 'hotel',   NULL,       '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"}]', 1),
  ('marriott',       'Marriott Bonvoy',                'hotel',   NULL,       '[{"currency":"bilt","ratio":"1:1"}]', 1),
  ('ihg',            'IHG One Rewards',                'hotel',   NULL,       '[{"currency":"chase_ur","ratio":"1:1"},{"currency":"bilt","ratio":"1:1"}]', 1),
  ('accor',          'Accor Live Limitless',           'hotel',   NULL,       '[{"currency":"capital_one","ratio":"2:1"},{"currency":"citi_ty","ratio":"2:1"}]', 1),
  ('wyndham',        'Wyndham Rewards',                'hotel',   NULL,       '[{"currency":"citi_ty","ratio":"1:1"}]', 1),
  ('choice',         'Choice Privileges',              'hotel',   NULL,       '[{"currency":"citi_ty","ratio":"1:1"},{"currency":"capital_one","ratio":"1:1"}]', 1);
