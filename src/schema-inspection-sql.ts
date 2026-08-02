export const SCHEMA_INSPECTION_PSQL_ARGS = [
  "--no-psqlrc",
  "--quiet",
  "--tuples-only",
  "--no-align",
  "--set",
  "ON_ERROR_STOP=1",
  "--file",
  "-"
] as const;

export const CATALOG_INSPECTION_SQL = String.raw`begin transaction read only;
set local statement_timeout = '5s';
set local lock_timeout = '1s';

with requested as (
  select
    (ordinality - 1)::integer as index,
    value as check
  from jsonb_array_elements(
    pg_catalog.convert_from(
      pg_catalog.decode(:'supadrum_schema_checks_base64', 'base64'),
      'UTF8'
    )::jsonb
  )
       with ordinality as item(value, ordinality)
),
resolved as (
  select
    requested.index,
    requested.check ->> 'kind' as kind,
    case requested.check ->> 'kind'
      when 'relation' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'relation',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'name'),
        'present', relation_match.oid is not null,
        'relation_kind', relation_match.relation_kind
      ))
      when 'column' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'column',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'relation') || '.' ||
                  (requested.check ->> 'name'),
        'present', column_match.attnum is not null,
        'data_type', column_match.data_type,
        'nullable', column_match.nullable
      ))
      when 'trigger' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'trigger',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'relation') || '.' ||
                  (requested.check ->> 'name'),
        'present', trigger_match.oid is not null,
        'enabled', trigger_match.enabled
      ))
      when 'routine' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'routine',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'name') || '(' ||
                  coalesce((
                    select string_agg(argument.value, ', ' order by argument.ordinality)
                    from jsonb_array_elements_text(
                      requested.check -> 'argument_types'
                    ) with ordinality as argument(value, ordinality)
                  ), '') || ')',
        'present', routine_match.oid is not null,
        'identity_arguments', routine_match.identity_arguments
      ))
      when 'row-security' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'row-security',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'relation'),
        'present',
          row_security_match.oid is not null
          and row_security_match.enabled =
              (requested.check ->> 'enabled')::boolean
          and row_security_match.force =
              (requested.check ->> 'force')::boolean
          and row_security_match.roles_without_bypass,
        'enabled', row_security_match.enabled,
        'force', row_security_match.force,
        'roles', row_security_match.roles
      ))
      when 'policy' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'policy',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'relation') || '.' ||
                  (requested.check ->> 'name'),
        'present',
          policy_match.oid is not null
          and policy_match.command = requested.check ->> 'command'
          and policy_match.roles = (
            select jsonb_agg(role_name order by role_name)
            from jsonb_array_elements_text(
              requested.check -> 'roles'
            ) as expected_role(role_name)
          )
          and policy_match.permissive =
              (requested.check ->> 'permissive')::boolean
          and policy_match.structure_matches,
        'command', policy_match.command,
        'roles', policy_match.roles,
        'permissive', policy_match.permissive,
        'using_present', policy_match.using_present,
        'with_check', policy_match.with_check
      ))
      when 'schema-privilege' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'schema-privilege',
        'target', (requested.check ->> 'schema') || ':' ||
                  (requested.check ->> 'role') || ':' ||
                  (requested.check ->> 'privilege'),
        'present',
          schema_privilege_match.oid is not null
          and schema_privilege_match.granted =
              (requested.check ->> 'granted')::boolean,
        'role', requested.check ->> 'role',
        'privilege', requested.check ->> 'privilege',
        'granted', schema_privilege_match.granted
      ))
      when 'relation-privilege' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'relation-privilege',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'relation') || ':' ||
                  (requested.check ->> 'role') || ':' ||
                  (requested.check ->> 'privilege'),
        'present',
          relation_privilege_match.oid is not null
          and relation_privilege_match.granted =
              (requested.check ->> 'granted')::boolean,
        'role', requested.check ->> 'role',
        'privilege', requested.check ->> 'privilege',
        'granted', relation_privilege_match.granted
      ))
      when 'routine-privilege' then jsonb_strip_nulls(jsonb_build_object(
        'index', requested.index,
        'kind', 'routine-privilege',
        'target', (requested.check ->> 'schema') || '.' ||
                  (requested.check ->> 'name') || '(' ||
                  coalesce((
                    select string_agg(argument.value, ', ' order by argument.ordinality)
                    from jsonb_array_elements_text(
                      requested.check -> 'argument_types'
                    ) with ordinality as argument(value, ordinality)
                  ), '') || '):' ||
                  (requested.check ->> 'role') || ':' ||
                  (requested.check ->> 'privilege'),
        'present',
          routine_privilege_match.oid is not null
          and routine_privilege_match.granted =
              (requested.check ->> 'granted')::boolean,
        'identity_arguments',
          routine_privilege_match.identity_arguments,
        'role', requested.check ->> 'role',
        'privilege', requested.check ->> 'privilege',
        'granted', routine_privilege_match.granted
      ))
    end as result
  from requested
  left join lateral (
    select
      relation.oid,
      case relation.relkind
        when 'r' then 'table'
        when 'p' then 'partitioned table'
        when 'v' then 'view'
        when 'm' then 'materialized view'
        when 'f' then 'foreign table'
        when 'S' then 'sequence'
      end as relation_kind
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'name'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    order by relation.oid
    limit 1
  ) relation_match
    on requested.check ->> 'kind' = 'relation'
  left join lateral (
    select
      attribute.attnum,
      pg_catalog.format_type(
        attribute.atttypid,
        attribute.atttypmod
      ) as data_type,
      not attribute.attnotnull as nullable
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation
      on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'relation'
      and attribute.attname = requested.check ->> 'name'
      and attribute.attnum > 0
      and not attribute.attisdropped
    order by attribute.attnum
    limit 1
  ) column_match
    on requested.check ->> 'kind' = 'column'
  left join lateral (
    select
      trigger.oid,
      trigger.tgenabled <> 'D' as enabled
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation
      on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'relation'
      and trigger.tgname = requested.check ->> 'name'
      and not trigger.tgisinternal
    order by trigger.oid
    limit 1
  ) trigger_match
    on requested.check ->> 'kind' = 'trigger'
  left join lateral (
    select
      routine.oid,
      pg_catalog.pg_get_function_identity_arguments(
        routine.oid
      ) as identity_arguments
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = requested.check ->> 'schema'
      and routine.proname = requested.check ->> 'name'
      and routine.prokind = 'f'
      and routine.pronargs =
          jsonb_array_length(requested.check -> 'argument_types')
      and not exists (
        select 1
        from jsonb_array_elements_text(
          requested.check -> 'argument_types'
        ) with ordinality as argument(type_name, position)
        where pg_catalog.to_regtype(argument.type_name) is null
           or routine.proargtypes[
                (argument.position - 1)::integer
              ] <> pg_catalog.to_regtype(argument.type_name)::oid
      )
    order by routine.oid
    limit 1
  ) routine_match
    on requested.check ->> 'kind' = 'routine'
  left join lateral (
    select
      relation.oid,
      relation.relrowsecurity as enabled,
      relation.relforcerowsecurity as force,
      role_state.roles,
      role_state.matched_roles =
        jsonb_array_length(
          requested.check -> 'roles_without_bypass'
        )
        and not role_state.any_bypass as roles_without_bypass
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral (
      select
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'role', requested_role.name,
              'bypasses_rls',
                role_match.rolbypassrls or role_match.rolsuper
            )
            order by requested_role.ordinality
          ) filter (where role_match.oid is not null),
          '[]'::jsonb
        ) as roles,
        count(role_match.oid) as matched_roles,
        coalesce(
          bool_or(
            role_match.rolbypassrls or role_match.rolsuper
          ) filter (where role_match.oid is not null),
          false
        ) as any_bypass
      from jsonb_array_elements_text(
        requested.check -> 'roles_without_bypass'
      ) with ordinality as requested_role(name, ordinality)
      left join pg_catalog.pg_roles role_match
        on role_match.rolname = requested_role.name
    ) role_state
    where namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'relation'
      and relation.relkind in ('r', 'p')
    order by relation.oid
    limit 1
  ) row_security_match
    on requested.check ->> 'kind' = 'row-security'
  left join lateral (
    select
      policy.oid,
      case policy.polcmd
        when 'r' then 'SELECT'
        when 'a' then 'INSERT'
        when 'w' then 'UPDATE'
        when 'd' then 'DELETE'
        when '*' then 'ALL'
      end as command,
      policy_roles.roles,
      policy.polpermissive as permissive,
      policy.polqual is not null as using_present,
      case
        when policy.polwithcheck is not null then 'explicit'
        when policy.polcmd in ('w', '*') then 'inherited'
        else 'not-applicable'
      end as with_check,
      case policy.polcmd
        when 'r' then
          policy.polqual is not null
          and policy.polwithcheck is null
        when 'd' then
          policy.polqual is not null
          and policy.polwithcheck is null
        when 'a' then
          policy.polqual is null
          and policy.polwithcheck is not null
        when 'w' then policy.polqual is not null
        when '*' then policy.polqual is not null
        else false
      end as structure_matches
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation
      on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral (
      select coalesce(
        jsonb_agg(
          case
            when policy_role.oid = 0 then 'PUBLIC'
            else role_match.rolname
          end
          order by
            case
              when policy_role.oid = 0 then 'PUBLIC'
              else role_match.rolname
            end
        ),
        '[]'::jsonb
      ) as roles
      from unnest(policy.polroles) as policy_role(oid)
      left join pg_catalog.pg_roles role_match
        on role_match.oid = policy_role.oid
    ) policy_roles
    where namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'relation'
      and policy.polname = requested.check ->> 'name'
    order by policy.oid
    limit 1
  ) policy_match
    on requested.check ->> 'kind' = 'policy'
  left join lateral (
    select
      namespace.oid,
      pg_catalog.has_schema_privilege(
        role_match.oid,
        namespace.oid,
        requested.check ->> 'privilege'
      ) as granted
    from pg_catalog.pg_namespace namespace
    join pg_catalog.pg_roles role_match
      on role_match.rolname = requested.check ->> 'role'
    where requested.check ->> 'kind' = 'schema-privilege'
      and namespace.nspname = requested.check ->> 'schema'
    order by namespace.oid
    limit 1
  ) schema_privilege_match
    on requested.check ->> 'kind' = 'schema-privilege'
  left join lateral (
    select
      relation.oid,
      pg_catalog.has_table_privilege(
        role_match.oid,
        relation.oid,
        requested.check ->> 'privilege'
      ) as granted
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles role_match
      on role_match.rolname = requested.check ->> 'role'
    where requested.check ->> 'kind' = 'relation-privilege'
      and namespace.nspname = requested.check ->> 'schema'
      and relation.relname = requested.check ->> 'relation'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    order by relation.oid
    limit 1
  ) relation_privilege_match
    on requested.check ->> 'kind' = 'relation-privilege'
  left join lateral (
    select
      routine.oid,
      pg_catalog.pg_get_function_identity_arguments(
        routine.oid
      ) as identity_arguments,
      pg_catalog.has_function_privilege(
        role_match.oid,
        routine.oid,
        requested.check ->> 'privilege'
      ) as granted
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    join pg_catalog.pg_roles role_match
      on role_match.rolname = requested.check ->> 'role'
    where requested.check ->> 'kind' = 'routine-privilege'
      and namespace.nspname = requested.check ->> 'schema'
      and routine.proname = requested.check ->> 'name'
      and routine.prokind = 'f'
      and routine.pronargs =
          jsonb_array_length(requested.check -> 'argument_types')
      and not exists (
        select 1
        from jsonb_array_elements_text(
          requested.check -> 'argument_types'
        ) with ordinality as argument(type_name, position)
        where pg_catalog.to_regtype(argument.type_name) is null
           or routine.proargtypes[
                (argument.position - 1)::integer
              ] <> pg_catalog.to_regtype(argument.type_name)::oid
      )
    order by routine.oid
    limit 1
  ) routine_privilege_match
    on requested.check ->> 'kind' = 'routine-privilege'
)
select jsonb_build_object(
  'migration_history_available',
  pg_catalog.to_regclass(
    'supabase_migrations.schema_migrations'
  ) is not null,
  'checks',
  coalesce(
    jsonb_agg(result order by index)
      filter (where kind <> 'migration'),
    '[]'::jsonb
  )
)::text
from resolved;

commit;
`;

export const MIGRATION_INSPECTION_SQL = String.raw`begin transaction read only;
set local statement_timeout = '5s';
set local lock_timeout = '1s';

with requested as (
  select
    (ordinality - 1)::integer as index,
    value as check
  from jsonb_array_elements(
    pg_catalog.convert_from(
      pg_catalog.decode(:'supadrum_schema_checks_base64', 'base64'),
      'UTF8'
    )::jsonb
  )
       with ordinality as item(value, ordinality)
  where value ->> 'kind' = 'migration'
)
select jsonb_build_object(
  'checks',
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'index', requested.index,
        'kind', 'migration',
        'target', requested.check ->> 'version',
        'present', migration.version is not null,
        'history_available', true
      )
      order by requested.index
    ),
    '[]'::jsonb
  )
)::text
from requested
left join lateral (
  select history.version
  from supabase_migrations.schema_migrations history
  where history.version = requested.check ->> 'version'
  limit 1
) migration on true;

commit;
`;

export const PRISMA_CATALOG_INSPECTION_SQL =
  CATALOG_INSPECTION_SQL.replace(
    "'supabase_migrations.schema_migrations'",
    "'public._prisma_migrations'"
  );

export const PRISMA_MIGRATION_INSPECTION_SQL =
  MIGRATION_INSPECTION_SQL
    .replaceAll("migration.version", "migration.migration_name")
    .replace("select history.version", "select history.migration_name")
    .replace(
      "from supabase_migrations.schema_migrations history",
      "from public._prisma_migrations history"
    )
    .replace(
      "where history.version = requested.check ->> 'version'",
      String.raw`where (
    history.migration_name = requested.check ->> 'version'
    or history.migration_name like
       ((requested.check ->> 'version') || '\_%') escape '\'
  )
  and history.finished_at is not null
  and history.rolled_back_at is null`
    );
