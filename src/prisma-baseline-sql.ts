export const PRISMA_HISTORY_AVAILABILITY_SQL = String.raw`begin transaction read only;
set local statement_timeout = '5s';
set local lock_timeout = '1s';

select jsonb_build_object(
  'available',
  pg_catalog.to_regclass('public._prisma_migrations') is not null
)::text;

commit;
`;

export const PRISMA_BASELINE_HISTORY_SQL = String.raw`begin transaction read only;
set local statement_timeout = '5s';
set local lock_timeout = '1s';

select jsonb_build_object(
  'rows',
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'migration_name', history.migration_name,
        'checksum', history.checksum,
        'started_at', history.started_at,
        'finished_at', history.finished_at,
        'rolled_back_at', history.rolled_back_at,
        'logs', history.logs
      )
      order by history.started_at, history.migration_name
    ),
    '[]'::jsonb
  )
)::text
from public._prisma_migrations history;

commit;
`;
