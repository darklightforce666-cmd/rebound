-- Schema fingerprint: run on the reference DB and on Supabase; every row must match.
with s as (
 select 'col' k, table_name||'.'||column_name||':'||data_type||':'||coalesce(domain_name,'')||':'||coalesce(column_default,'')||':'||is_nullable x from information_schema.columns where table_schema='rebound'
 union all select 'con', conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='rebound'::regnamespace
 union all select 'idx', indexname||':'||indexdef from pg_indexes where schemaname='rebound'
 union all select 'fn', proname||':'||md5(prosrc)||':'||coalesce(array_to_string(proconfig,','),'')||':'||prosecdef from pg_proc where pronamespace='rebound'::regnamespace
 union all select 'trg', tgrelid::regclass::text||':'||tgname||':'||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='rebound'::regnamespace)
 union all select 'rls', tablename||':'||policyname||':'||array_to_string(roles,',')||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') from pg_policies where schemaname='rebound'
 union all select 'grant', grantee||':'||table_name||':'||privilege_type from information_schema.role_table_grants where table_schema='rebound' and grantee in ('anon','authenticated','rebound_api','rebound_indexer','rebound_scheduler','rebound_verifier')
 union all select 'colgrant', grantee||':'||table_name||':'||column_name||':'||privilege_type from information_schema.column_privileges where table_schema='rebound' and grantee in ('anon','authenticated','rebound_api','rebound_indexer','rebound_scheduler','rebound_verifier')
 union all select 'pub', tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='rebound'
 union all select 'policy', version||':'||hash from rebound.reward_policies
 union all select 'mig', version::text from rebound.reward_schema_migrations
)
select k, count(*) n, md5(string_agg(x, E'\n' order by x)) h from s group by k order by k;
