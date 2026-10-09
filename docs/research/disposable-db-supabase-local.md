# Database usa-e-getta su Supabase locale

Ricerca per il ticket #37 (figlio della mappa #36, origine #35). Data: 2026-10-09.

Questo documento stabilisce fatti. Non propone un design: la scelta spetta a chi decide dopo. Ogni affermazione cita la fonte primaria; quello che non si e' potuto verificare e' nella sezione "Non verificato".

Nessuno stack Supabase, container Docker o database in esecuzione e' stato avviato, fermato, resettato o interrogato durante la ricerca. Solo lettura di documentazione e codice sorgente (clone di sola lettura in cartella temporanea). Nessun comando e' stato eseguito: ogni comportamento descritto sotto e' ricavato dal sorgente e dalla documentazione, non osservato.

## Domanda

Su uno stack Supabase LOCALE, come creare un database USA-E-GETTA su cui applicare le migrazioni di un progetto ed eseguire test pgTAP, SENZA toccare ne' leggere i dati del database dove Paolo prova le cose a mano ("db manuale")?

Cinque sotto-domande:

1. Cosa fanno `supabase test db`, `supabase db reset`, `supabase migration up` e `--db-url`; dove girano i test; quale DB colpiscono.
2. Un `CREATE DATABASE` nuovo sullo stesso Postgres ha gli schemi `auth`/`storage`/`extensions`, i ruoli, le estensioni e `pgtap` che le migrazioni Supabase tipiche si aspettano? Se no, da dove vengono e come si ricostruiscono.
3. `CREATE DATABASE ... TEMPLATE ...`: requisiti, cosa copia, compatibilita' con "non toccare/leggere i dati manuali", come ottenere un template pulito.
4. Alternative: secondo stack Supabase locale, container Postgres dedicato con l'immagine `supabase/postgres`: costo di avvio, risorse, rischi di collisione.
5. Pulizia: `DROP DATABASE` con connessioni attive, cosa resta se il processo muore a meta'.

## Risposta breve

- `supabase test db` e `supabase migration up` non hanno un "DB di test" proprio: colpiscono il database nominato dalla connessione (di default `postgres` dello stack locale, oppure quello in `--db-url`). Il database dell'URL decide tutto: nome incluso. La CLI non controlla il nome del DB per decidere se un target e' "locale" (solo host e porta). Fonti: sezione 1.
- `supabase db reset` locale, anche con `--db-url` che punta a un DB diverso dal manuale, cancella il volume dati dell'intero cluster (PG15+) e quindi anche il db manuale. E' l'unico comando qui esaminato certamente distruttivo per il db manuale. Sezione 1.3.
- Un `CREATE DATABASE` nudo sullo stesso Postgres eredita da `template1`, che nell'immagine `supabase/postgres` NON e' personalizzato. Ottiene quindi i ruoli (sono globali al cluster) ma NON gli schemi `extensions`, `auth`, `storage`, `realtime`/`_realtime`, ne' publication, default privileges, event trigger, GUC e grant a livello di database: tutta questa roba la creano gli script di init e i job della CLI SOLO sul database `postgres`. `pgtap` e' installabile in qualunque DB (e' nell'immagine ed e' un'estensione "privileged"), ma `create extension pgtap with schema extensions` (cio' che esegue `test db`) richiede che lo schema `extensions` esista gia'. Sezione 2.
- `CREATE DATABASE ... TEMPLATE x` richiede zero altre connessioni su `x`, copia tutti gli oggetti E I DATI di `x`, non copia GUC (`ALTER DATABASE ... SET`) ne' GRANT a livello di database. Usare il db manuale come template e' quindi incompatibile col vincolo (va scollegato e se ne copiano i dati). Un template pulito va costruito da baseline+migrazioni e non dal db manuale. Sezione 3.
- Il precedente della CLI stessa: per `db diff` la CLI avvia un container Postgres SEPARATO ("shadow", porta 54320 di default, `AutoRemove`, nessun volume nominato), ci applica la baseline di piattaforma (job auth/storage/realtime, privilegi API, roles.sql), poi esegue `CREATE DATABASE contrib_regression TEMPLATE postgres`. Zero contatto col data dir dello stack. Attenzione (inferenza dal codice): `test db --db-url` verso la porta dello shadow (54320) e' trattato come "locale" e il container `pg_prove` userebbe `PGHOST=db`, cioe' il DB principale, non lo shadow. Sezione 4.3.
- Un secondo stack completo richiede un `project_id` diverso (nomi di container, volume e rete derivano da `project_id`) e porte diverse per OGNI servizio nel suo `config.toml`; la documentazione ufficiale non descrive scenari a piu' stack e raccomanda almeno 7 GB di RAM per uno stack. Il rischio principale per il db manuale e' `supabase stop --all` / `--no-backup`. Sezione 4.1.
- `DROP DATABASE ... WITH (FORCE)` (PG13+) termina le altre connessioni ma non scatta con prepared transaction, slot di replica logica attivi o sottoscrizioni. Se il backend muore durante un `CREATE DATABASE`, la callback di errore rimuove le directory copiate; una morte del postmaster/OS puo' lasciare directory orfane (non verificato sperimentalmente). Un DB la cui DROP e' stata interrotta resta marcato "invalid" e va ripulito con DROP. Sezione 5.

### Confronto sintetico dei meccanismi

| Meccanismo | Tocca il db manuale? | Ha gia' `auth`/`storage`/`extensions`/ruoli? | Costo | Nota chiave |
|---|---|---|---|---|
| `test db` / `migration up` senza `--db-url` | Si': colpiscono `postgres` | Si' (e' il db manuale) | Basso | Mai su dati da non toccare |
| `test db` / `migration up --db-url .../<altro_db>` su host:porta locale | Non direttamente, stesso cluster | Ruoli si'; schemi no (DB nudo) | Basso | Stesso Postgres: errore di operazione = rischio comune |
| `db reset` (qualsiasi target "locale") | SI', distrugge il cluster | n/a | Medio | Da evitare |
| `CREATE DATABASE` nudo (template1) | No (non lo legge) | Solo ruoli | Basso (ms-s) | Va ricostruita la baseline per DB |
| `CREATE DATABASE ... TEMPLATE postgres` | Si': richiede disconnettere e copia dati | Si' | Basso | Incompatibile col vincolo |
| `CREATE DATABASE ... TEMPLATE <pulito>` | No, se `<pulito>` non e' derivato dal manuale | Si', se costruito con la baseline | Una tantum | Il template va costruito da baseline+migrazioni |
| Container Postgres dedicato / shadow CLI | No (data dir separato) | Solo se si riapplica la baseline | Avvio container + baseline | Precedente nella CLI (`db diff`) |
| Secondo stack Supabase completo | No se isolato bene | Si' (baseline da `supabase start`) | Alto (7 GB raccomandati) | Collisioni di nomi e porte; non documentato |

## 1. Comandi della CLI e `--db-url`

Versioni. La CLI installata da Paolo e' Homebrew `supabase` 2.116.0; le citazioni di codice riguardano il tag `v2.116.0` (commit `997a1e69a4a83466964ed874d3a604c88a7b3866`). L'ultima release stabile e' v2.120.0 (2026-10-06); dove HEAD (`065888b22180b335a545d8027b056d4cd2473da4`) differisce, e' detto esplicitamente. Le v3.0.0-next.* sono prerelease e non sono state considerate.

### 1.1 `supabase test db`

Cosa fa (tag v2.116.0, `apps/cli/src/legacy/shared/legacy-test-db.handler.ts`):

- Il processo CLI sull'host si connette al database di destinazione ed esegue `create extension if not exists pgtap with schema extensions` (l.31, l.178-206). Se pgtap non esisteva prima (controllo `select 1 from pg_extension where extname = 'pgtap'`, per nome, qualunque schema) esegue `drop extension if exists pgtap` alla fine; altrimenti lo lascia (l.32, l.188-206).
- I test girano in un container Docker usa-e-getta `supabase/pg_prove:3.36` (registry di default `public.ecr.aws/supabase/pg_prove:3.36`, l.39) con comando `pg_prove --ext .pg --ext .sql -r <percorsi>`. La cartella dei test e' montata in sola lettura (`apps/cli/src/commands/test/db/SIDE_EFFECTS.md`, sezione Docker, l.32-40 dell'esemplare HEAD).
- Rete e host: per un target "locale" il container usa `PGHOST=db`, `PGPORT=5432` sulla rete `supabase_network_<project_id>` (o quella di `--network-id`, che prevale su tutto); per un target non locale usa la rete host con host e porta dell'URL (l.128-161). `PGUSER`, `PGPASSWORD` e `PGDATABASE` vengono dalla connessione risolta (l.131-137): quindi un `--db-url` che termina con un altro nome di DB colpisce quell'altro DB.
- `--db-url`, `--linked` e `--local` sono mutuamente esclusivi; il default e' locale (`SIDE_EFFECTS.md` di HEAD, tabella Exit Codes l.68; `legacy-db-config.layer.ts` v2.116.0 ~l.612-625).
- Cosa e' "locale": `host === hostname dei servizi locali` E `port` in `{db.port, db.shadow_port}`; nessun controllo sul nome del DB (TS: `apps/cli/src/legacy/shared/legacy-db-config.layer.ts:75-85`; Go: `apps/cli-go/internal/utils/connect.go:384-386`). Default `127.0.0.1`, con override `SUPABASE_SERVICES_HOSTNAME` o `DOCKER_HOST` tcp (`SIDE_EFFECTS.md` tabella Environment Variables).
- Un file `.sql` di test eseguito da `pg_prove` gira nella propria transazione; la documentazione ufficiale presenta i test come `begin ... rollback` (guida ufficiale ai test, vedi Fonti).
- Documentazione ufficiale di riferimento: "Executes pgTAP tests against the local database", "Requires the local development stack to be started by running `supabase start`", "Runs `pg_prove` in a container with unit test files volume mounted from `supabase/tests` directory"; flag `--db-url`, `--linked`, `--local`. `--network-id` e' documentato solo come flag globale ("use the specified docker network instead of a generated one").

Vincoli:

- Il container `pg_prove` deve poter raggiungere il DB. Con `--db-url` che cade nella definizione di "locale" (host locale + porta 54322 o 54320) il container sara' sulla rete `supabase_network_<project_id>` con `PGHOST=db` e `PGPORT=5432`: raggiunge il Postgres dello stack, col `PGDATABASE` dell'URL. Quindi lo stack `supabase start` deve essere in esecuzione e la rete deve esistere.
- Su `--db-url` NON locale (altro host o altra porta) il container usa la rete host. Il comportamento della rete `host` su Docker Desktop macOS non e' coperto dalla documentazione consentita: non verificato.
- `pgtap` viene installato con `with schema extensions`: il DB di destinazione deve avere lo schema `extensions` (vedi sezione 2).
- `test db` NON crea mai il database di destinazione.

Costi: un `docker run --rm` del container `pg_prove` (immagine da scaricare la prima volta) piu' una connessione dall'host. Tempi misurati: non verificato.

Rischi per i dati del db manuale: senza `--db-url` il comando colpisce `postgres`, cioe' il db manuale. I test ufficiali fanno rollback, ma un test scritto male (DDL, `truncate`, sequenze, `nextval`, funzioni con effetti collaterali, `NOTIFY`) puo' lasciare effetti: i rollback non annullano le sequenze, ne' alcune estensioni. Non si e' potuto verificare nulla sperimentalmente.

Differenza HEAD: nel backend sperimentale "stack" i target `--local` usano uno stack di progetto gestito dalla CLI e non la rete `supabase_network_*` (SIDE_EFFECTS.md HEAD, l.38, l.108). Vedi 4.4.

### 1.2 `supabase migration up`

(Tag v2.116.0, `apps/cli/src/legacy/commands/migration/up/up.handler.ts` l.38-172 e `SIDE_EFFECTS.md` relativo.)

- Connessione dall'host, nessun container. Legge `<workdir>/supabase/migrations/`, applica le versioni non ancora presenti nella tabella di cronologia del target, ha `--include-all` per le migrazioni "fuori ordine" (l.35, l.112-121), esegue l'upsert dei segreti `[db.vault]` (l.134) e non esegue il seed.
- La documentazione ufficiale (`supabase-migration-up`) elenca solo i flag `--db-url`, `--include-all`, `--linked`, `--local`; non ha un paragrafo descrittivo.
- Il DB di destinazione deve gia' esistere: il comando non lo crea.
- Il flag globale `--workdir` ("path to a Supabase project directory", `apps/cli-go/cmd/root.go:340`) sposta la cartella da cui leggere `supabase/migrations`.

Rischi: stessi della 1.1. Con `--db-url` punta al DB nominato; senza, al DB `postgres` locale. La tabella di cronologia delle migrazioni sta nel DB di destinazione, quindi un DB diverso ha la propria cronologia (ricavato dal fatto che e' una tabella del DB di destinazione; non letto dal codice di creazione della tabella).

### 1.3 `supabase db reset`

- Documentazione ufficiale: "Recreates the local Postgres container and applies all local migrations... Any other data or schema changes made during local development will be discarded."
- Codice (`apps/cli-go/internal/db/reset/reset.go` v2.116.0): per un target "locale" (`IsLocalDatabase`, l.54) il percorso e' `resetDatabase`. Per PG15+ `resetDatabase15` (l.114-142) rimuove il container del DB e il VOLUME dati `supabase_db_<project_id>` (`VolumeRemove(ctx, utils.DbId, true)`, l.118), lo ricrea, esegue `SetupLocalDatabase` e riavvia i servizi (l.139-141). Per PG14 e precedenti (l.157-176) esegue `DROP DATABASE IF EXISTS postgres WITH (FORCE)`, `CREATE DATABASE postgres WITH OWNER postgres` e lo stesso per `_supabase`; `DisconnectClients` (l.183 e seguenti) fa `ALTER DATABASE ... ALLOW_CONNECTIONS false` e `pg_terminate_backend` sui client.
- Conclusione: su PG15+ azzera l'intero cluster, db manuale compreso, qualunque sia il database nominato in `--db-url`, purche' l'URL sia "locale" (host locale + porta 54322/54320). Solo un target non locale va in `resetRemote` (l.55).

Rischio per il db manuale: totale (perdita di tutti i dati dello stack). `db reset` non e' un meccanismo per un DB usa-e-getta in coesistenza col db manuale.

## 2. Cosa ha un `CREATE DATABASE` nuovo (rispetto a quello che le migrazioni Supabase si aspettano)

### 2.1 Principio

- I ruoli sono globali al cluster, non per database ("Database roles are global across a database cluster installation", PostgreSQL `database-roles`). Un nuovo DB li vede subito.
- Schemi, estensioni, default privileges, publication, event trigger, GUC e grant a livello di DB sono per-database. "Most system catalogs are copied from the template database during database creation and are thereafter database-specific. A few catalogs are physically shared across all databases in a cluster" (PostgreSQL `catalogs-overview`). `pg_db_role_setting` e' condiviso quando `setdatabase` e' zero. `pg_default_acl` non e' indicato come condiviso nella sua pagina: ricavo che e' per-database e copiato col template.
- `CREATE DATABASE` senza `TEMPLATE` clona `template1` (PostgreSQL `sql-createdatabase`): "If you add objects to template1, these objects will be copied into subsequently created user databases" (`manage-ag-templatedbs`).
- "Database-level configuration parameters (set via ALTER DATABASE) and database-level permissions (set via GRANT) are not copied from the template database" (`sql-createdatabase`).

### 2.2 Dove vengono creati gli oggetti Supabase

Nell'immagine `supabase/postgres` (commit `142c6a2c6cb589e66ae9647e868fa428d20fbda5`):

- `Dockerfile-17:158-160` copia `migrations/db` in `/docker-entrypoint-initdb.d/` e l'immagine imposta `POSTGRES_USER=supabase_admin`, `POSTGRES_DB=postgres` (l.176-177); l'entrypoint e' quello di docker-library/postgres (`ENTRYPOINT ["docker-entrypoint.sh"]`, l.186; scaricato dal commit `6edb0a8c4def40c371514b34aef9037ec82d9110`). Stesse righe in `Dockerfile-15` (l.153-155, l.171-172, l.180).
- Nell'entrypoint di docker-library, `docker_process_sql` esegue `psql ... --dbname "$POSTGRES_DB"` (l.206-209), `docker_setup_db` crea un DB solo se `POSTGRES_DB` non e' `postgres` (l.217-226) e `docker_process_init_files /docker-entrypoint-initdb.d/*` e' a l.358.
- `migrations/db/migrate.sh` (eseguibile, quindi eseguito dall'entrypoint) imposta `PGDATABASE="${POSTGRES_DB:-postgres}"` (l.16): agisce solo su `postgres`. Alla fine applica `/etc/postgresql.schema.sql`, scritto dalla CLI (l.64-69).
- `template1` non e' personalizzato da nessuno script dell'immagine: la ricerca di `template1`/`template0` nel repo ha trovato solo la menzione in uno script di pg_upgrade. Quindi `template1` e' quello standard di initdb.
- I job di servizio della CLI (v2.116.0, `apps/cli-go/internal/db/start/start.go`) puntano al DB `postgres`: realtime con `DB_NAME=postgres` (l.277), storage con `DATABASE_URL=postgresql://supabase_storage_admin:...@host:5432/postgres` (l.306), auth con `GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:...@host:5432/postgres` (l.326). Sono lanciati da `initSchema15` (l.334-357) e `SetupDatabase` (l.383 e seguenti: init schema, privilegi API, segreti vault, `roles.sql`).

### 2.3 Tabella: cosa trovi in un DB nudo e come ricostruirlo

| Elemento | Livello | Presente in un DB nudo? | Origine | Come ricostruirlo |
|---|---|---|---|---|
| Ruoli `supabase_admin`, `supabase_replication_admin`, `supabase_etl_admin`, `supabase_read_only_user`, `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, `dashboard_user` | cluster | Si' | `init-scripts/00000000000000-initial-schema.sql` l.8-33; `...01-auth-schema.sql` l.112; `...02-storage-schema.sql` l.5; `...03-post-setup.sql` l.104 | Nulla |
| `ALTER ROLE ... SET search_path` / `statement_timeout` | cluster (impostazioni di ruolo) | Si' | `...03-post-setup.sql` l.3-4; initial-schema | Nulla |
| Schema `extensions` con `uuid-ossp`, `pgcrypto` | per-DB | No | `...00-initial-schema.sql` l.23-25 | `create schema extensions` + `create extension ... with schema extensions` |
| `default privileges in schema public` per `postgres, anon, authenticated, service_role` | per-DB | No | initial-schema l.40-42, 51-55 | Rieseguire gli `alter default privileges` |
| `publication supabase_realtime` | per-DB | No | initial-schema l.5 | `create publication supabase_realtime` |
| Schema `auth` con `auth.users`, `auth.uid()`, `auth.role()`, `auth.email()` | per-DB | No | `...01-auth-schema.sql` l.3-7, 94, 99, 104; poi altre tabelle da `gotrue migrate` (start.go l.326) | Rieseguire lo script (o l'immagine auth) sul DB nuovo |
| Schema `storage` | per-DB | No | schema creato da `...02-storage-schema.sql` l.3; le tabelle (`storage.buckets`, `storage.objects`) le crea il job storage (`node dist/scripts/migrate-call.js`, start.go l.306), non lo script dell'immagine | Rieseguire storage-api migrate sul DB nuovo |
| Schema `realtime`/`_realtime`, `supabase_functions`, `pg_net`, webhook | per-DB | No | CLI `templates/schema.sql` l.16-17, `templates/webhook.sql` l.4 e seguenti; job realtime (start.go l.277) | Rieseguire i template della CLI |
| Event trigger `issue_pg_cron_access`, `issue_pg_net_access` | per-DB | No | `...03-post-setup.sql` l.42, 95; `webhook.sql` l.219 | Rieseguire gli script |
| Grant a livello di DB (`GRANT ALL ON DATABASE postgres TO dashboard_user`, `GRANT CREATE ON DATABASE postgres TO supabase_storage_admin`, ...) | per-DB, non copiati dal template | No | `...03-post-setup.sql` l.105; `...02-storage-schema.sql` l.7; initial-schema l.16 | Rieseguirli con il nome del nuovo DB |
| GUC `app.settings.jwt_secret`, `app.settings.jwt_exp` | per-DB, non copiati | No | CLI `templates/schema.sql` l.5-6 (`ALTER DATABASE postgres SET`) | `alter database <nuovo> set ...` |
| Estensione `pgtap` | per-DB | Non installata, ma disponibile | Il file di estensione e' nell'immagine (`nix/packages/postgres.nix:35`, `nix/ext/pgtap.nix`); `pgtap` e' in `supautils.privileged_extensions` (`ansible/files/postgresql_config/supautils.conf.j2:10`) | `create extension pgtap with schema extensions` (richiede lo schema `extensions`) |
| Tabella di cronologia delle migrazioni | per-DB | No | creata da `migration up` nel DB di destinazione | La crea il comando |

Note:

- Il ruolo `postgres` (usato dalla CLI nelle connessioni utente) in questa immagine e' `NOSUPERUSER CREATEDB CREATEROLE LOGIN REPLICATION BYPASSRLS` (`migrations/db/migrations/10000000000000_demote-postgres.sql:22`): ha il permesso `CREATEDB` che `CREATE DATABASE` richiede (PostgreSQL `sql-createdatabase`: superuser o `CREATEDB`), ma non e' superuser.
- `CREATE EXTENSION ... SCHEMA`: "The named schema must already exist" (PostgreSQL `sql-createextension`). Dunque `test db` su un DB nudo senza schema `extensions` fallirebbe in `create extension if not exists pgtap with schema extensions`. Inferenza dalla documentazione, non eseguita.
- `pgtap` e' installabile per database come superuser con `CREATE EXTENSION pgtap;`; la documentazione pgTAP dice di installarlo in `template1` se lo si vuole in tutti i nuovi DB (pgtap.org/documentation.html). In Supabase `template1` non e' toccato dall'immagine (2.2).
- Le migrazioni Supabase tipiche che usano `auth.users`, `auth.uid()`, `storage.buckets`, `extensions.uuid_generate_v4()` o `to authenticated` falliscono o cambiano significato su un DB nudo: riferimenti a schemi/funzioni inesistenti dànno errore; le policy `to authenticated` funzionano solo perche' i ruoli sono globali. Questa e' una conseguenza dei fatti sopra, non verificata eseguendo migrazioni reali.

### 2.4 Costo e rischio per il db manuale

`CREATE DATABASE` da `template1` non legge ne' tocca altri DB. Richiede solo che `template1` non abbia altre sessioni (vedi 3.1). Il rischio resta al livello di cluster: i ruoli sono condivisi, quindi modificare un ruolo (`ALTER ROLE ... SET`, `DROP ROLE`, cambio password) per l'uso-e-getta colpirebbe anche il db manuale.

## 3. `CREATE DATABASE ... TEMPLATE ...`

### 3.1 Requisiti e cosa copia (PostgreSQL `sql-createdatabase`, `manage-ag-templatedbs`; codice `dbcommands.c`)

- Permesso: superuser o `CREATEDB`. Non si puo' eseguire in un blocco di transazione.
- "No other sessions can be connected to the template database while it is being copied. CREATE DATABASE will fail if any other connection exists when it starts; otherwise, new connections to the template database are locked out until CREATE DATABASE completes." Codice, PG17 `src/backend/commands/dbcommands.c:1367-1370`: `CountOtherDBBackends(src_dboid, ...)` e errore `source database "%s" is being accessed by other users` (ERRCODE_OBJECT_IN_USE).
- Copia i file del database sorgente: oggetti E DATI ("CREATE DATABASE actually works by copying an existing database"). Non copia GUC (`ALTER DATABASE ... SET`) ne' grant a livello di DB.
- `IS_TEMPLATE`: se vero chiunque abbia `CREATEDB` puo' clonare; se falso solo superuser o il proprietario.
- `STRATEGY`: `WAL_LOG` di default (PG15+); `FILE_COPY` forza checkpoint. L'opzione e' assente nella pagina PG14, presente in quella PG15.
- Codifica e locale devono coincidere col template, salvo l'uso di `template0`.
- La pagina ufficiale avverte che non e' "ancora" pensata come funzione generale di COPY DATABASE.

### 3.2 Compatibilita' col vincolo "non toccare / non leggere i dati del db manuale"

- Usare il db manuale (`postgres`) come TEMPLATE e' incompatibile: (a) richiede che nessun altro sia connesso a `postgres` e blocca nuove connessioni per tutta la copia (indisponibilita' del db manuale); (b) copia anche i dati.
- Il precedente della CLI stessa usa `CREATE DATABASE contrib_regression TEMPLATE postgres` (`apps/cli-go/internal/db/diff/diff.go:164`), ma lo fa dentro il container shadow separato (4.3), dove `postgres` contiene solo la baseline di piattaforma e nessun dato dell'utente.

### 3.3 Come ottenere un template pulito (fatti, non scelte)

Un template e' un normale database; i fatti utili:

- Si puo' creare un DB (`CREATE DATABASE tpl`) da `template1`, applicarvi la baseline (tabella 2.3) e le migrazioni, poi usarlo come sorgente: `CREATE DATABASE x TEMPLATE tpl`, che richiede `tpl` senza altre connessioni. L'opzione `IS_TEMPLATE` di `CREATE DATABASE` (flag `datistemplate`, `manage-ag-templatedbs`) serve solo a permettere la clonazione anche a chi non e' proprietario/superuser: se falso, possono clonare solo superuser o il proprietario (`sql-createdatabase`).
- La baseline di `auth`/`storage`/`realtime` non e' ottenibile con semplici script SQL dell'immagine: parte viene da job che usano immagini di servizio (`gotrue migrate`, `storage-api migrate`, `realtime eval`) e che nella CLI 2.116.0 puntano al DB `postgres` con URL costruiti nel codice (start.go l.277, 306, 326); non c'e' un parametro per sceglierne un altro. Se sia possibile lanciare gli stessi job contro un altro nome di DB passando altre variabili d'ambiente e' ragionevole ma non verificato.
- Il template pulito costruito da baseline+migrazioni non contiene dati del db manuale per costruzione, purche' sia costruito da `template1` e non clonando `postgres`.
- Clonare `postgres` dopo un `db reset` (cioe' "pulito") non e' una strada: `db reset` cancella il db manuale (1.3).

Costi: la copia avviene a livello di file/WAL del solo template; i tempi dipendono dalle dimensioni del template. Tempi misurati: non verificato.

## 4. Alternative a livello di processo/container

### 4.1 Secondo stack Supabase locale

Fatti dal codice della CLI 2.116.0:

- I nomi derivano da `project_id`: `GetId(name) = "supabase_" + name + "_" + ProjectId` (`apps/cli-go/internal/utils/config.go:57`); la rete e' `supabase_network_<project_id>` oppure quella di `--network-id` (l.62-63); il container DB e' `supabase_db_<project_id>` e il volume dati ha lo stesso nome (l.65; start.go l.124 `DbId + ":/var/lib/postgresql/data"`). `project_id` serve a "distinguish different Supabase projects on the same host" (template `pkg/config/templates/config.toml:5`).
- Le porte di default sono tutte fisse nel `config.toml`: api 54321, db 54322, shadow_port 54320, pooler 54329, studio 54323, inbucket 54324, analytics 54327 (template config.toml l.10, 35, 37, 47, 97, 108, 390). Un secondo stack richiede porte diverse per ciascun servizio avviato, o l'esclusione di servizi con `supabase start -x`. Se variabili `SUPABASE_*` d'ambiente sovrascrivono le porte: il loader usa `SetEnvPrefix("SUPABASE")` e `AutomaticEnv()` (`pkg/config/config.go:591-592`) ma la documentazione ufficiale della configurazione cita solo `SUPABASE_EXPERIMENTAL_STACK`: non verificato.
- La documentazione ufficiale di `start` raccomanda "at least 7GB of RAM to start all services"; non descrive piu' stack.
- `supabase stop --all` ferma le istanze di tutti i progetti; `--no-backup` "Deletes all data volumes after stopping" e avverte "it will delete all supabase local projects data" (documentazione ufficiale di `stop`). Un `stop` lanciato dal progetto sbagliato o con `--all` e' quindi un rischio diretto per il db manuale.

Costi: tempo di avvio e consumo di RAM/CPU di uno stack completo: solo la raccomandazione di 7 GB e' documentata; il tempo di avvio misurato e' non verificato. `health_timeout` di default 2m (template l.39) indica l'attesa massima per la salute del DB, non il tempo tipico.

Rischi per il db manuale: nessuno sul dato se i `project_id` e le porte sono distinti e il data dir (volume) e' separato; rischio operativo con `stop --all`, `--no-backup`, e con un `project_id` uguale per errore (stessi volume e container).

Il broker del repo (`src/local-stack.ts`) usa gia' `supabase start --network-id <rete>`; il comportamento di un secondo `start` con altri `project_id` e porte non e' stato ne' letto in documentazione ufficiale ne' eseguito: non verificato.

### 4.2 Container Postgres dedicato con l'immagine `supabase/postgres`

- L'immagine inizializza il cluster con gli script di init (2.2), imposta `POSTGRES_USER=supabase_admin` e `POSTGRES_DB=postgres` (Dockerfile-17 l.176-177), e legge `POSTGRES_PASSWORD` dall'ambiente.
- La CLI usa un entrypoint personalizzato (`NewContainerConfig`, start.go l.63-116): scrive `/etc/postgresql.schema.sql` (schema iniziale + webhook + `_supabase.sql`) e `pgsodium_root.key`, aggiunge impostazioni a `postgresql.conf`, poi `docker-entrypoint.sh postgres -D /etc/postgresql`. Variabili: `POSTGRES_PASSWORD`, `POSTGRES_HOST=/var/run/postgresql`, `JWT_SECRET`, `JWT_EXP` (l.65 e seguenti). Quindi un container avviato "a mano" dall'immagine senza questo entrypoint non avrebbe `/etc/postgresql.schema.sql` ne' i template della CLI (non verificato quale parte si ottenga senza di essi).
- Un container separato ha un proprio data dir: nessun contatto coi dati del db manuale. La baseline `auth`/`storage`/`realtime` e' comunque da applicare (job della CLI, 2.2).
- Rischio di collisione: porta host dedicata diversa da 54322/54320 e nome container diverso da `supabase_db_<project_id>`.
- `pg_prove` e `test db`: contro questo container `test db --db-url` e' un target non locale (porta diversa) con rete host, a meno di usare `--network-id` (1.1). Nessuna verifica.
- Avvio/risorse: non verificato.

### 4.3 Il container "shadow" della CLI (precedente di codice)

Per `db diff` e `pull` la CLI (v2.116.0):

- `CreateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:138-151`) avvia un container separato con `start.NewContainerConfig("-c", "max_worker_processes=0")`, porta host `db.shadow_port` (default 54320), `AutoRemove: true`, senza volume nominato, label del progetto.
- `setupShadowConn` (diff.go l.171-179) applica `start.SetupDatabase` (baseline completa) e poi `CREATE DATABASE contrib_regression TEMPLATE postgres` (`CREATE_TEMPLATE`, l.164). `MigrateShadowDatabase` (l.195-209) applica le migrazioni dell'utente.
- `DiffDatabase` rimuove il container alla fine con `defer utils.DockerRemove(...)` (l.217).
- `PrepareShadowSource`/`PrepareRawShadow` (`shadow.go` l.37 e l.97) forniscono la connessione (utente `postgres`, DB `postgres`, porta `shadow_port`).

Cosa dice come fatto: la CLI stessa costruisce un Postgres usa-e-getta in un container separato con data dir proprio, riapplica la baseline di piattaforma e clona con `TEMPLATE`.

Trappola ricavata dal codice (inferenza, non eseguita). La porta `shadow_port` rientra nei target "locali" (`IsLocalDatabase`, connect.go:384-386). `DockerStart` mette il container shadow sulla rete `NetId` (docker.go:379-382) ma con `networkingConfig` vuoto (diff.go:146), cioe' senza l'alias `db`; l'alias `db` (`DbAliases = ["db", "db.supabase.internal"]`, config.go:36) e' assegnato nel `networkingConfig` del container principale (start.go:139, reset.go:126). Quindi `test db --db-url postgresql://...@127.0.0.1:54320/<db>` abiliterebbe pgtap sul container shadow (connessione dall'host alla porta 54320), mentre il container `pg_prove` riceverebbe `PGHOST=db PGPORT=5432` (legacy-test-db.handler.ts:131-137) e raggiungerebbe il DB principale dello stack, cioe' il cluster del db manuale, con il `PGDATABASE` dell'URL. Un URL con porta di shadow e DB `postgres` farebbe girare i test sul db manuale. Per qualunque container Postgres aggiuntivo vale la regola generale: se host e porta cadono in `{db.port, db.shadow_port}` il container `pg_prove` va sul DB principale; con un'altra porta il target e' non locale e il container usa la rete host.

### 4.4 Backend sperimentale "stack" (solo HEAD / v2.120.0)

- In 2.116.0 `packages/stack` esiste solo come libreria (`@supabase/stack` 0.1.0); non esistono `apps/cli/src/commands/experimental` ne' `EXPERIMENTAL_STACK` in `apps` e `packages`: non raggiungibile dalla CLI installata.
- In HEAD/v2.120.0 e' attivabile con `SUPABASE_EXPERIMENTAL_STACK=1` o `[experimental] stack = true` (`apps/cli/docs/stack-commands.md` l.148, 162-163; `apps/cli/src/commands/start/SIDE_EFFECTS.md` l.3-6). I comandi `db`, `migration`, `test db`, `gen types`, `inspect` con target `--local` usano lo stack di progetto e "provision a throwaway shadow database owned by the stack runtime" (stack-commands.md l.182-184). I nomi Compose (`supabase_db_*`, `supabase_network_*`, `db:5432`) non vengono usati.
- `packages/stack/ARCHITECTURE.md` (HEAD): un database shadow e' "an ordinary database instance with its own ID, password, ports and data" (l.134); la creazione assegna "a unique instance identity and isolated data directory" e "the same call can create a second independent database" (l.206); i test dispongono di stack di sessione usa-e-getta (`testing.ts`); "Parallel stacks with separate identities remain independent" (l.533); le porte sono gestite da un registro per utente OS (`ports.sqlite`, l.65, 583, 617).
- Note di release v2.120.0: `stack list` stampa un ID di 8 caratteri e `--stack-id` accetta l'ID corto; `stop --no-backup` pota i volumi cache di migra.
- Non e' stato eseguito nulla di questo: e' documentazione/codice HEAD, utile a sapere che la CLI sta andando verso database/stack isolati di prima classe, ma non disponibile nella 2.116.0.

## 5. Pulizia

### 5.1 `DROP DATABASE`

(PostgreSQL `sql-dropdatabase`; PG17 `dbcommands.c`.)

- "It cannot be executed while you are connected to the target database" (codice: "cannot drop the currently open database", `dbcommands.c:1699-1702`); non su template (l.1696); non in transazione.
- Con altre connessioni: "fail unless you use the FORCE option" (errore `database "%s" is being accessed by other users`, `dbcommands.c:1751-1754`).
- `WITH (FORCE)` (PG13+; assente nella pagina PG12): "Attempt to terminate all existing connections to the target database. It doesn't terminate if prepared transactions, active logical replication slots or subscriptions are present". Termina solo le connessioni che l'utente corrente ha permesso di terminare con `pg_terminate_backend`; se ne restano, fallisce. In codice `if (force) TerminateOtherDBBackends(db_id)` (l.1742-1743), seguito dal ricontrollo (l.1751); i controlli su slot logici attivi (l.1715) e sottoscrizioni (l.1728-1735) avvengono prima.
- "Cannot be undone." (documentazione).
- Il processo `supabase db reset` per PG14 usa `DROP DATABASE IF EXISTS postgres WITH (FORCE)` (reset.go:169), a conferma dell'uso di FORCE nella CLI.

### 5.2 Cosa resta se il processo muore a meta'

Dal codice PG17 (`src/backend/commands/dbcommands.c`, blob `f529e0ff129481476a148576f09440d6a0a7b9c4`, ramo `REL_17_STABLE` al commit `35c508af520963bf1245b86f437c21f834cc2be0`):

- CREATE DATABASE: la copia e' protetta da `PG_ENSURE_ERROR_CLEANUP(createdb_failure_callback, ...)` (l.1498-1528). La callback (l.1595-1627) scarta i buffer del DB di destinazione (con strategia WAL_LOG), rilascia i lock e rimuove le sottodirectory copiate (`remove_dbtablespaces`, l.1626). Il commento (l.1488-1493) dice che "this is not a 100% solution, because of the possibility of failure during transaction commit... but it should handle most scenarios". Un altro commento (l.1521-1525): se il crash avviene prima del commit "we'll have a DB that's taking up disk space but is not in pg_database". Quindi: errore o uscita pulita del backend = pulizia automatica; crash del server/OS a meta' = possibili directory orfane senza riga in `pg_database` (spazio su disco consumato). Come rimuoverle a mano: non verificato nelle fonti consentite.
- DROP DATABASE: dopo l'eliminazione transazionale della riga catalogo, le azioni successive non sono transazionali; per evitare accessi a un DB con contenuti non validi, PG17 marca il DB come non valido con un aggiornamento in-place (`datconnlimit = DATCONNLIMIT_INVALID_DB`, l.1780-1799) con flush del WAL prima delle operazioni irreversibili sul filesystem. Un DB invalido non si usa come template ("cannot use invalid database \"%s\" as template... Use DROP DATABASE to drop invalid databases", l.999-1000) ne' si altera (l.2443-2444): va riportato a posto con un nuovo DROP. Il commento a l.1850-1854 avverte che un crash prima del commit lascia un DB "gone on disk but still there according to pg_database". Il comportamento delle versioni PG precedenti alla 17 non e' stato verificato.
- Container (4.3): il shadow della CLI ha `AutoRemove: true` e viene rimosso con `defer DockerRemove` (diff.go l.144, 217); se il processo CLI muore prima del `defer`, il container resta finche' non viene fermato (nessuna fonte consultata su cosa lo rimuova): non verificato. Il container ha un'etichetta del progetto (`DockerStart`, `apps/cli-go/internal/utils/docker.go` l.363-423).
- Un DB usa-e-getta rimasto orfano dentro il cluster principale non modifica i dati del db manuale (sono database distinti), ma occupa disco nello stesso data dir. Eventuali ruoli creati per l'uso-e-getta restano nel cluster perche' i ruoli sono globali (`database-roles`) e `DROP DATABASE` non li rimuove.

## Non verificato

Cose che le fonti consentite non permettono di affermare, o che non sono state eseguite (divieto di toccare lo stack e Docker):

1. Tempi di avvio, consumo RAM/CPU di un secondo stack o di un container `supabase/postgres` dedicato. Solo la raccomandazione ufficiale di 7 GB per lo stack completo e' documentata.
2. Se variabili `SUPABASE_*` (per esempio per le porte) sovrascrivono davvero `config.toml`: il codice usa `AutomaticEnv`, la documentazione ufficiale non lo descrive.
3. Che un secondo `supabase start` con `project_id` e porte diversi funzioni in pratica: la documentazione ufficiale non copre piu' stack.
4. Il comportamento di `--network host` su Docker Desktop macOS (documentazione Docker fuori dall'elenco delle fonti consentite).
5. Che `test db --db-url` con porta di shadow (54320) mandi davvero `pg_prove` sul DB principale (inferenza da codice, sezione 4.3, non eseguita); e se un container Postgres aggiuntivo sulla rete del progetto possa essere raggiunto da `pg_prove` con un alias diverso da `db`.
6. Che `supabase test db` fallisca su un DB nudo senza schema `extensions`: dedotto dalla documentazione PostgreSQL di `CREATE EXTENSION ... SCHEMA`, non eseguito.
7. Che i job di servizio (gotrue, storage, realtime) possano essere lanciati contro un database diverso da `postgres` cambiando le variabili d'ambiente: nel codice 2.116.0 gli URL sono costruiti con `/postgres` fisso; non provato.
8. Il comportamento reale di `CREATE DATABASE ... TEMPLATE` col ruolo `postgres` (non superuser) e con l'estensione `supautils` (`session_preload_libraries = 'supautils'`, `reserved_roles`): nessuna esecuzione.
9. Cosa resta su disco e come ripulirlo dopo un crash del server/OS durante `CREATE DATABASE` (solo i commenti del codice PG17), e il comportamento delle versioni PG precedenti alla 17 per il flag "invalid" del DB.
10. Se `pg_default_acl` sia per-database e copiato col template: dedotto dal fatto che la sua pagina non lo indica come condiviso; non provato.
11. Cosa succede ai volumi anonimi del container shadow con `AutoRemove` e chi rimuove un container shadow orfano se il processo CLI muore (documentazione Docker fuori elenco).
12. Il comportamento del backend sperimentale "stack" (HEAD / v2.120.0): non raggiungibile dalla CLI installata 2.116.0 e non eseguito.
13. Versioni PostgreSQL: le pagine ufficiali citate sono "current" (18); il default locale di Supabase e' `major_version = 17` (template config.toml:42) ma il progetto reale puo' averne un'altra (nessun `supabase/config.toml` e' presente in questo repo). `STRATEGY` richiede PG15+, `FORCE` richiede PG13+.
14. Se `--network-id` sia dichiarato come flag sul comando `test db` nella 2.116.0: il `SIDE_EFFECTS.md` di HEAD dice che e' "not declared on the TS command (documented divergence)" mentre il handler 2.116.0 legge `networkIdFlag`; non risolto.

## Fonti

Abbreviazioni per i link a codice:

- CLI = `https://github.com/supabase/cli/blob/v2.116.0/` (commit 997a1e69a4a83466964ed874d3a604c88a7b3866)
- CLI-HEAD = `https://github.com/supabase/cli/blob/065888b22180b335a545d8027b056d4cd2473da4/`
- PGIMG = `https://github.com/supabase/postgres/blob/142c6a2c6cb589e66ae9647e868fa428d20fbda5/`
- PGSRC = `https://github.com/postgres/postgres/blob/35c508af520963bf1245b86f437c21f834cc2be0/` (ramo REL_17_STABLE; il blob di `dbcommands.c` e' `f529e0ff129481476a148576f09440d6a0a7b9c4`, identico al file letto)

Documentazione ufficiale Supabase:

- https://supabase.com/docs/reference/cli/supabase-test-db
- https://supabase.com/docs/reference/cli/supabase-db-reset
- https://supabase.com/docs/reference/cli/supabase-migration-up
- https://supabase.com/docs/reference/cli/supabase-start
- https://supabase.com/docs/reference/cli/supabase-stop
- https://supabase.com/docs/guides/local-development/testing/overview
- https://supabase.com/docs/guides/local-development/cli/config
- https://supabase.com/docs/guides/local-development/overview
- Release v2.120.0: https://github.com/supabase/cli/releases/tag/v2.120.0

Codice Supabase CLI (v2.116.0, salvo indicazione):

- `CLI apps/cli/src/legacy/shared/legacy-test-db.handler.ts` l.31-32 (pgtap), l.39 (immagine), l.100, l.128-161 (rete ed env), l.178-206 (connessione e pgtap), l.222-251 (docker), l.262-277 (errori).
- `CLI apps/cli/src/legacy/shared/legacy-db-config.layer.ts` l.75-85 (`isLocalDatabase`); ~l.500-545 (`--db-url`); ~l.612-625 (`--local` di default).
- `CLI apps/cli/src/legacy/commands/migration/up/up.handler.ts` l.35, 38-172 e `SIDE_EFFECTS.md`.
- `CLI apps/cli-go/internal/db/reset/reset.go` l.34-70, l.96-142, l.157-212, l.290.
- `CLI apps/cli-go/internal/db/start/start.go` l.63-131 (container e host config), l.268-331 (job realtime/storage/auth), l.334-357, l.359-399.
- `CLI apps/cli-go/internal/db/start/templates/schema.sql` l.5-6, 16-17; `webhook.sql` l.4, 219; `_supabase.sql` l.1-5.
- `CLI apps/cli-go/internal/db/diff/diff.go` l.138-151, 164, 171-179, 195-209, 211-217; `shadow.go` l.37-91, 97-116.
- `CLI apps/cli-go/internal/utils/config.go` l.36, 57-65; `connect.go` l.384-386; `docker.go` l.363-423 (rete l.379-382, creazione container l.418).
- Alias `db` del container principale: `CLI apps/cli-go/internal/db/start/start.go` l.139, `reset/reset.go` l.126.
- `CLI apps/cli-go/cmd/root.go` l.340-342 (`--workdir`, `--network-id`).
- `CLI apps/cli-go/pkg/config/config.go` l.591-592; `pkg/config/templates/config.toml` l.5, 10, 35, 37, 39, 42, 47, 97, 108, 390.
- `CLI-HEAD apps/cli/src/commands/test/db/SIDE_EFFECTS.md`; `apps/cli/src/commands/start/SIDE_EFFECTS.md` l.3-6; `apps/cli/docs/stack-commands.md` l.148, 162-163, 177, 182-184; `packages/stack/ARCHITECTURE.md` l.65, 134, 206, 533, 583, 617.

Codice immagine `supabase/postgres`:

- `PGIMG Dockerfile-15` l.153-155, 171-172, 180; `Dockerfile-17` l.158-160, 176-177, 186.
- `PGIMG migrations/db/migrate.sh` l.16, 64-69.
- `PGIMG migrations/db/init-scripts/00000000000000-initial-schema.sql` l.5, 8-33, 40-55; `00000000000001-auth-schema.sql` l.3-7, 94-112; `00000000000002-storage-schema.sql` l.3-7; `00000000000003-post-setup.sql` l.3-4, 42, 95, 104-107.
- `PGIMG migrations/db/migrations/10000000000000_demote-postgres.sql` l.22.
- `PGIMG ansible/files/postgresql_config/supautils.conf.j2` l.10 (`privileged_extensions` incl. `pgtap`).
- `PGIMG nix/packages/postgres.nix` l.35; `nix/ext/pgtap.nix`; `migrations/tests/extensions/03-pgtap.sql` l.2.
- Entrypoint: https://raw.githubusercontent.com/docker-library/postgres/6edb0a8c4def40c371514b34aef9037ec82d9110/15/alpine3.23/docker-entrypoint.sh (l.206-209, 217-226, 358).

PostgreSQL:

- https://www.postgresql.org/docs/current/sql-createdatabase.html (e /docs/14/ e /docs/15/ per `STRATEGY`)
- https://www.postgresql.org/docs/current/sql-dropdatabase.html (e /docs/12/ e /docs/13/ per `FORCE`)
- https://www.postgresql.org/docs/current/manage-ag-templatedbs.html
- https://www.postgresql.org/docs/current/database-roles.html
- https://www.postgresql.org/docs/current/catalogs-overview.html
- https://www.postgresql.org/docs/current/catalog-pg-db-role-setting.html
- https://www.postgresql.org/docs/current/catalog-pg-default-acl.html
- https://www.postgresql.org/docs/current/sql-createextension.html
- `PGSRC src/backend/commands/dbcommands.c` l.999-1000, 1367-1370, 1470-1528, 1595-1627, 1696-1702, 1715, 1728-1735, 1742-1754, 1781-1799, 1851-1855, 2443-2444.

pgTAP:

- https://pgtap.org/documentation.html (installazione per database, `template1`)
- https://pgtap.org/pg_prove.html (`-d/--dbname`, `-h`, `-p`, `-U`, `--ext`, `-r`, variabili libpq)
