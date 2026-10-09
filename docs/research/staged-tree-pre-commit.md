# Quale indice e quale tree vede un hook pre-commit, e come estrarlo in una cartella temporanea

Ticket #38 (figlio della mappa #36, origine #35). Ricerca del 2026-10-09.
Lo scopo e' accertare fatti: la scelta di disegno spetta a una persona.

Legenda delle etichette usate in tutto il documento:

- **[E]** verificato per esperimento (comando e output riportati, repo `git init` usa-e-getta in una cartella temporanea, mai il repo Supadrum).
- **[S]** letto nel sorgente di git, tag `v2.50.1`.
- **[D]** dalla documentazione ufficiale (git-scm.com / `Documentation/` dello stesso tag).
- **[NV]** non verificato.

Ambiente di tutti gli esperimenti: `git --version` = `git version 2.50.1 (Apple Git-155)`, macOS (Darwin 25.5.0), APFS case-insensitive.

## Domanda

Un hook `pre-commit` deve far dimostrare a un processo separato (il runner del broker, avviato fuori dall'hook) il contenuto **in staging** (il tree dell'indice, `git write-tree`), non il working tree e non `HEAD`.
Quale indice e quale tree vede l'hook? Come si estrae quel tree in una cartella temporanea senza toccare working tree, `HEAD` e indice reale? Chi deve calcolare l'OID del tree (hook o broker) e come puo' verificarlo il broker?

Vincoli fissi dati dal ticket: solo camere locali; il chiamante non passa argv/env/SQL/credenziali; mai toccare il DB locale di prova a mano dello sviluppatore; rifiuto esplicito se runner spento / stack che non risponde / camera non locale; test mai saltati.

## Risposta breve

1. **L'hook non vede sempre `.git/index`.** Con `git commit` l'hook riceve `GIT_INDEX_FILE` che puo' valere quattro cose diverse a seconda di come si e' lanciato il commit (tabella al punto 1). Solo nel commit "as-is" (`git commit` semplice, `--amend`) e' l'indice reale `.git/index`, e li' e' un percorso **relativo** (`GIT_INDEX_FILE=.git/index`). Con `-a` e `--include <path>` e' `<abs>/.git/index.lock`; con `<path>`, `--only`, `--amend --only` e' `<abs>/.git/next-index-<PID>.lock`. In un worktree collegato gli stessi file stanno sotto `<main>/.git/worktrees/<nome>/` e l'hook riceve anche `GIT_DIR`. [E][S]
2. **Un processo non figlio (il runner) con ambiente pulito vede l'indice sbagliato** in tutti i casi tranne uno: `git -C <repo> write-tree` muore con `Unable to create '.../.git/index.lock': File exists` sotto `-a`/`--include`/`--only`, e il suo `diff --cached` mostra l'indice reale *vecchio*; in un worktree collegato vede l'indice del worktree principale. Coincide con l'hook solo nel commit as-is nel worktree principale. [E]
3. **Chi calcola l'OID: l'hook.** Solo l'hook sa quale dei quattro file indice e' quello che il commit usera'. Il comando e' `git write-tree` eseguito dentro l'hook con il suo `GIT_INDEX_FILE` ereditato (reso assoluto se relativo). In tutte le modalita' provate il tree dell'hook e' uguale al tree poi committato (`HEAD^{tree}`), con una sola eccezione: nel commit as-is l'indice reale non e' lockato durante l'hook, quindi un `git add` concorrente viene committato ma non e' nel tree dell'hook. [E][S]
4. **Il broker non puo' ricostruire l'OID da solo con il suo ambiente di default** (punto 2). Puo' rifare il calcolo solo se l'hook gli passa il percorso assoluto dell'indice (`GIT_INDEX_FILE=<abs> git -C <repo> write-tree`) e solo **mentre l'hook e' vivo**: se il file e' sparito, `write-tree` risponde con il **tree vuoto** `4b825dc642cb6eb9a060e54bf8d69288fbee4904` con exit 0 e lascia un file `next-index-<PID>.lock` orfano. [E]
5. **Cio' che il broker puo' verificare su un OID dato:** formato (esadecimale pieno, 40 cifre per sha1; `rev-parse` accetta anche rami e prefissi, quindi serve un controllo di formato prima), esistenza e tipo (`git cat-file -t <oid>` = `tree`), completezza (`git rev-list --objects <oid>`), contenuto (`git ls-tree -r <oid>`). **Non puo' verificare** che l'OID venga dall'indice dell'hook, ne' che il commit avverra': esistenza non e' autenticita'. [E]
6. **Estrazione senza toccare nulla** (indice reale, `HEAD`, ref e working tree invariati negli snapshot prima/dopo): `git archive --format=tar <tree> | tar -x -C <dir>` oppure indice temporaneo + `git read-tree` + `git checkout-index`. Sono fedeli al tree (attributi presi dal tree stesso) rispettivamente cosi': `git archive` di default; `checkout-index` solo con `git --attr-source=<tree> ...` (o `GIT_ATTR_SOURCE=<tree>`) oppure con `--work-tree` su una cartella vuota. `checkout-index --prefix` lanciato dentro il repo **senza** `--attr-source` usa gli attributi del working tree e **non** e' fedele. `git worktree add` rifiuta un tree OID (serve un commit, che scrive un oggetto e registra `.git/worktrees/<nome>`). [E]
7. **Fedelta' ha due significati.** "Come un checkout di quel tree" (smudge/eol dai suoi `.gitattributes`): `git archive <tree>`, `--attr-source=<tree>`. "Byte per byte uguale ai blob": solo `checkout-index` con `--attr-source=<tree vuoto>` **e** configurazione neutra (`core.autocrlf=false`, `core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`); `git archive` non si puo' rendere neutro con `--attr-source`. [E]
8. **Effetti collaterali reali da conoscere:** `git write-tree` scrive tree nell'odb del repo (oggetti non raggiungibili, potabili da `git prune`); un odb temporaneo con alternates evita le scritture ma **rinfresca l'mtime** degli oggetti gia' presenti; `commit-tree` + `worktree add` scrivono un commit e registrano un worktree. Il filtro `smudge` e' un comando arbitrario preso dalla config e viene eseguito sia da `archive` sia da `checkout-index`. [E]

## Metodo

Cartella degli esperimenti: scratchpad di sessione (fuori dal repo Supadrum). Repo di prova creati con `git init -b main`, `user.name=tester`.

- **Fixture r1** (punti 1, 4, 5): `a.txt`, `b.txt`, `c.txt`, `run.sh` (755), `link` (symlink), `sub/s.txt`; `a.txt` in staging (`a2`), `b.txt` e `c.txt` modificati non in staging. Index tree di partenza `788627c5c93c9f299c492ae5e8363d40320a542b`.
- **Hook di prova** (`.git/hooks/pre-commit`): stampa `env | grep '^GIT_'`, `git rev-parse --git-dir --git-common-dir --show-toplevel`, `git write-tree`, `git diff --cached --stat`; poi scrive la toplevel in una FIFO e aspetta la risposta del runner.
- **Runner simulato**: processo lungo avviato con `env -i` (nessuna `GIT_*` nell'ambiente), cwd diversa dal repo, che esegue `git -C <repo> write-tree`, `git -C <repo> diff --cached --stat`, `cat-file -t`, `rev-parse --verify <oid>^{tree}`, `ls-tree -r`. Nota di metodo: nell'esperimento il percorso del repo registrato glielo ha passato l'hook (ricavato da `git rev-parse --git-common-dir`); il runner reale lo avrebbe registrato a parte.
- **Fixture r2** (punto 3): file eseguibile `exec.sh` (755), symlink `link`, directory annidata `dir/`, submodule `sm` (gitlink), `.gitattributes` in **tre versioni diverse** per distinguere le fonti: A0 in `HEAD` (`crlf.txt text eol=crlf`, ...), A1 nell'indice/staged (`ignored.txt export-ignore`, `subst.txt export-subst`, `filt.txt filter=upper`, nessun `eol` su `crlf.txt`), A2 nel working tree (`crlf.txt text eol=crlf`, `subst.txt export-subst`, niente export-ignore ne' filtro). Contenuto di `plain.txt`: `hello` in HEAD, `staged content` nell'indice, `worktree content` nel working tree. `filter.upper.smudge = tr a-z A-Z`. Index tree `180634bd209b4a81c5d70073d101abc532276466`.
- **Fixture r3** (costi): 20 000 file in 200 directory da 100, indice di 1 605 361 byte.
- Prova di non-interferenza: prima e dopo ogni esperimento di materializzazione si e' registrato `shasum .git/index`, `HEAD`, `git status --short`, contenuto del working tree, numero di ref e di worktree. Nessuna variazione di indice, `HEAD`, `status`, working tree e ref. Unica differenza: +1 oggetto loose (16 -> 17), il commit orfano creato apposta dal caso M4b (punto 3.2).

## 1. Quale indice vede l'hook con `git commit`, e cosa vede un processo non figlio

### 1.1 Documentazione [D]

- `githooks`, sezione `pre-commit`: "This hook is invoked by git-commit, and can be bypassed with the `--no-verify` option. It takes no parameters, and is invoked before obtaining the proposed commit log message and making a commit. Exiting with a non-zero status from this script causes the `git commit` command to abort before creating a commit." e "All the `git commit` hooks are invoked with the environment variable `GIT_EDITOR=:` if the command will not bring up an editor to modify the commit message." (`Documentation/githooks.adoc` righe 97-112)
- `githooks`, intestazione: "Before Git invokes a hook, it changes its working directory to ... the root of the working tree in a non-bare repository" e "Environment variables, such as `GIT_DIR`, `GIT_WORK_TREE`, etc., are exported so that Git commands run by the hook can correctly locate the repository." (righe 24-35)
- `git-commit`: `--only` / `--include` / `-a` descrivono *quali contenuti* finiscono nel commit ma la documentazione **non** dice quale file indice riceve l'hook ne' che esista un indice temporaneo. Questo si ricava solo dal sorgente.

### 1.2 Sorgente [S]

`builtin/commit.c`, funzione `prepare_index` (righe 348-547) sceglie l'indice e lo restituisce; `prepare_to_commit` lo passa all'hook. `run_commit_hook` (in `commit.c`, righe 1938-1960) esporta `GIT_INDEX_FILE=<index_file>` (riga 1945) e `GIT_EDITOR=:` solo se non si usa un editor (riga 1951).

| Modo | Riga | File indice passato all'hook |
|---|---|---|
| as-is: `git commit`, `--amend` (senza `-a`, senza path) | 460-482 | `repo_get_index_file()` = indice reale, **relativo** (`.git/index`). Il lock viene preso ma rilasciato (`COMMIT_LOCK \| SKIP_IF_UNCHANGED`): `.git/index` **non e' lockato** durante l'hook. Prima dell'hook fa `cache_tree_update(WRITE_TREE_SILENT)` (riga 473-475). |
| `-a`, `--include <path>` | 429-458 | `<abs>/.git/index.lock` (percorso del lock). L'indice reale resta il VECCHIO finche' il commit non riesce ("on failure, rollback the real index", riga 439). |
| `<path>`, `--only`, `--amend --only` | 484-542 | `<abs>/.git/next-index-<PID>.lock` ("false index", riga 528): `HEAD` + solo i path indicati (`create_base_index(current_head)`, riga 533). Anche `index.lock` e' tenuto. Altri file in staging sono **ignorati** nel commit. |
| `-p` / `--interactive` | 387-427 | `index.lock` usato come indice temporaneo (riga 425). Non eseguito, solo letto. |

Dopo l'hook l'indice viene riletto (`discard_index` + `read_index_from`, righe 1080-1088) e il tree da committare e' ricalcolato con `cache_tree_update` (riga 1090): il tree committato e' quello dell'indice **dopo** l'hook, non quello visto dall'hook.
`prepare_to_commit` chiama il `pre-commit` alla riga 761, **prima** del controllo "niente da committare" (riga 1060) e prima di `prepare-commit-msg` (riga 1095) e `commit-msg` (riga 1112), che possono ancora far abortire il commit. [S]

Variabili d'ambiente: `GIT_DIR` e' esportata solo quando il repo e' raggiunto tramite *gitfile*, cioe' in un worktree collegato: `setup.c` riga 1132 (`if (strcmp(gitdir, DEFAULT_GIT_DIR_ENVIRONMENT)) set_git_dir(gitdir, 0)`) e riga 1663 (`xsetenv(GIT_DIR_ENVIRONMENT, path, 1)`). Nel worktree principale (`gitdir` = `.git`) non viene esportata. [S]

### 1.3 Esperimenti [E]

Ogni caso: fixture r1 ricreata, poi `git commit ...` con l'hook di prova; il runner simulato parte con `env -i`.
Comandi (tutti `-q`): `git commit -m case1` / `git commit -a -m case2` / `git commit -m case3 c.txt` / `git commit --only -m case3b c.txt` / `git commit --include -m case4 c.txt` / `git commit --amend -m case5` / `git commit --amend --only -m case5b` / `git commit --amend -a -m case5c`.

| Caso | `GIT_INDEX_FILE` visto dall'hook | tree dell'hook (`git write-tree`) | tree committato (`HEAD^{tree}`) | `git -C <repo> write-tree` del runner |
|---|---|---|---|---|
| 1 `commit` | `.git/index` (relativo) | `788627c5c93c9f299c492ae5e8363d40320a542b` | uguale | uguale (`788627c5...`) |
| 2 `-a` | `<abs>/.git/index.lock` | `e14161b40fa675920c4d72b2a00ef27b7df14bf8` (a, b, c) | uguale | `fatal: Unable to create '<abs>/.git/index.lock': File exists.` |
| 3 `c.txt` | `<abs>/.git/next-index-10817.lock` | `cf22efd9c35ef9553aa5daace3e3e87e2babb2af` (solo c.txt) | uguale | stesso errore `index.lock` |
| 3b `--only c.txt` | `<abs>/.git/next-index-10865.lock` | `cf22efd9...` | uguale | stesso errore |
| 4 `--include c.txt` | `<abs>/.git/index.lock` | `95e5327630c6f2ecfcf81e0b7c8bd768105f1f8c` (a staged + c) | uguale | stesso errore |
| 5 `--amend` | `.git/index` | `788627c5...` | uguale | uguale |
| 5b `--amend --only` (senza path) | `<abs>/.git/next-index-11018.lock` | `e23ded9f8eabb5177f57513b50012e7f0d04b345` (= tree di `HEAD`, lo staged `a.txt` e' ignorato) | uguale | stesso errore |
| 5c `--amend -a` | `<abs>/.git/index.lock` | `8d291cee650ec5c2dfb7d12c70e03910eafb1561` | uguale | stesso errore |

`git diff --cached --stat` del runner nei casi 2, 3, 3b, 4, 5b, 5c mostrava `a.txt | 2 +-` (l'indice reale *vecchio*), mentre l'hook vedeva i file che il commit contiene davvero (es. caso 3: solo `c.txt`; caso 5b: nessun cambiamento).

Variabili `GIT_*` effettivamente viste dall'hook nel worktree principale: `GIT_AUTHOR_DATE`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_NAME`, `GIT_EDITOR=:`, `GIT_EXEC_PATH`, `GIT_INDEX_FILE`, `GIT_PREFIX`. **Non** presenti: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`. `GIT_PREFIX` vale `sub/` se il commit parte da `sub/` (casi 6, 6b), ma la cwd dell'hook resta la toplevel del working tree. Se il chiamante imposta un editor e non passa `-m`, `GIT_EDITOR` resta quello del chiamante (caso 7 rieseguito: `GIT_EDITOR=<ed.sh>`); con `-m` vale `:` anche se il chiamante aveva `GIT_EDITOR` (caso 7b).

Quando l'hook parte, e quando no:

| Situazione | Comando | Esito osservato |
|---|---|---|
| `--no-verify` | `git commit -q --no-verify -m nv` | hook **non** eseguito; commit riuscito |
| `--dry-run` | `git commit --dry-run -q -m dry` | hook **non** eseguito |
| niente da committare | `git commit -m nothing` (working tree pulito) | hook **eseguito** (`GIT_INDEX_FILE=.git/index`, tree = tree di `HEAD`), poi `nothing to commit, working tree clean`, exit 1 |
| indice con conflitti non risolti | `git commit -m m` | exit 128, `Committing is not possible because you have unmerged files.`, hook **non** eseguito |
| conflitto, ma con `-a` | `git commit -a -m m` | hook eseguito (`GIT_INDEX_FILE=<abs>/.git/index.lock`, tree `1d5d44e322e77fcd11caaa7d3b3250d8434987e4`), commit riuscito col contenuto conflittato (cioe' con i marcatori) |

Un OID prodotto dall'hook quindi **non implica** che un commit avvenga: l'hook parte anche se poi non c'e' nulla da committare, e puo' ancora fallire un hook successivo ([S] righe 1095-1112, non eseguito).

Rollback con hook che fallisce (fixture fresca r4, `HOOK_EXIT=1 git commit -q -a -m failing`, `a.txt` modificato non in staging): exit 1; `GIT_INDEX_FILE=<abs>/.git/index.lock`; dopo: `git status --short` = ` M a.txt` e `git ls-files -s a.txt` invariato (`da0f8ed9...`), nessun file `*.lock` o `next-index*` rimasto in `.git`, `HEAD` invariato. L'indice reale e' ripristinato. [E] Verificato solo per `-a`; per `--include`/`--only` ripristino letto nel sorgente (commenti righe 437-439 e 499-501), non eseguito.

Con hook riuscito, `commit --only c.txt` (fixture r4, `a.txt` in staging): exit 0, tree dell'hook `5c6ce291c0f0ecb06508eed74f4092b64f2017d3` = `HEAD^{tree}`; dopo il commit il file `next-index-<PID>.lock` **non esiste piu'**, `a.txt` e' ancora in staging. [E]

### 1.4 Corsa (TOCTOU) sul commit as-is [E]

L'hook di prova (`hook-race`) esegue `git write-tree` (T1), poi `git add b.txt` (simula un `git add` di un altro processo: nel commit as-is l'indice reale non e' lockato), poi di nuovo `git write-tree` (T2).

```
== hook-race: GIT_INDEX_FILE=.git/index
   hook write-tree T1 => 788627c5c93c9f299c492ae5e8363d40320a542b
   real index entry b.txt now: 100644 e6bfff5c1d0f0ecd501552b43a1e13d8008abc31 0	b.txt
   hook write-tree T2 (same GIT_INDEX_FILE) => 8d291cee650ec5c2dfb7d12c70e03910eafb1561
after: HEAD tree=8d291cee650ec5c2dfb7d12c70e03910eafb1561 ; HEAD:b.txt=b2  (b2 means the concurrent add was committed)
```

Il commit contiene T2, non T1. Con `git commit -a` lo stesso `git add b.txt` fallisce (`fatal: Unable to create '<abs>/.git/index.lock': File exists.`) e T1 = T2 = `8d291cee...`. Coerente con [S] 1080-1090. Quindi: un tree calcolato all'inizio dell'hook e' garantito uguale al tree committato solo se qualcosa non modifica `.git/index` fra la fine dell'hook e il commit; per `-a`/`--include`/`--only`/`-p` il lock lo garantisce, per il commit as-is no.

### 1.5 Cosa vede un processo non figlio per default [E]

Runner avviato con `env -i` (nessuna `GIT_*`), cwd fuori dal repo:

- Non eredita `GIT_INDEX_FILE`: lavora su `<repo>/.git/index` (con `git -C <repo>`).
- `git write-tree` prende un lock esclusivo su `<index>.lock` anche se serve solo a leggere (`cache-tree.c` `write_index_as_tree`, righe 727-761: `hold_lock_file_for_update(&lock_file, index_path, LOCK_DIE_ON_ERROR)`, riga 733). Quindi sotto `-a`/`--include`/`--only`/`-p` fallisce (tabella 1.3) e, al contrario, un `write-tree` del runner sull'indice reale puo' far fallire un `git add` concorrente dello sviluppatore con `index.lock: File exists`. [S] per il secondo effetto; il primo [E].
- Percorso relativo: `GIT_INDEX_FILE=.git/index` va risolto contro la cwd di chi lo usa. Con `git -C <repo>` il `chdir` avviene prima e il percorso cade nel repo; con `git --git-dir=<repo>/.git` da un'altra cwd no:

```
cwd = .../other-cwd  (not a repository, no .git here)
1) GIT_INDEX_FILE=.git/index git -C r1 write-tree        => 9075f59bf9435380399df277b51af40652f827d2
2) GIT_INDEX_FILE=.git/index git --git-dir=r1/.git write-tree => fatal: Unable to create '.../other-cwd/.git/index.lock': No such file or directory
```

Se in `other-cwd/.git/` ci fosse stato un indice, il comando 2 avrebbe agito su quello. L'hook deve quindi passare un percorso **assoluto** (`git rev-parse --absolute-git-dir` o `realpath`). [E] (la seconda parte, "se esistesse", e' un'inferenza dal sorgente `lockfile`, non provata).
- Replay con il percorso assoluto dato dall'hook (`GIT_INDEX_FILE=<abs> git -C <repo> write-tree`): riproduce l'OID dell'hook finche' il file indice esiste (verificato nei casi del punto 4). [E]
- **Replay tardivo**: se il file e' sparito (tipico di `next-index-<PID>.lock` dopo il commit), `write-tree` non fallisce:

```
$ GIT_INDEX_FILE=<abs>/.git/next-index-18336.lock git write-tree      # file inesistente
4b825dc642cb6eb9a060e54bf8d69288fbee4904     (exit 0)
$ ls .git | grep next-index
next-index-18336.lock                         # creato dal replay, rimasto orfano
$ git hash-object -t tree /dev/null
4b825dc642cb6eb9a060e54bf8d69288fbee4904
```

Un broker che rifacesse il calcolo con un percorso sparito otterrebbe il tree vuoto con exit 0. [E]

## 2. `git write-tree`: conflitti, `--missing-ok`, oggetti scritti, costo, alternative

### 2.1 Documentazione e sorgente

- [D] `git-write-tree`: "Creates a tree object using the current index. The name of the new tree object is printed to standard output. The index must be in a fully merged state." `--missing-ok`: "Normally `git write-tree` ensures that the objects referenced by the directory exist in the object database. This option disables this check." Sinossi: `git write-tree [--missing-ok] [--prefix=<prefix>/]`; **non esiste un'opzione "dry-run"**.
- [S] `write_index_as_tree_internal` (`cache-tree.c` 675-700) restituisce `WRITE_TREE_UNMERGED_INDEX` se `cache_tree_update` fallisce. `write_index_as_tree` (727-761) riscrive il file indice (con l'estensione cache-tree) solo se il cache-tree non era interamente valido (`!was_valid`, riga 748); un errore di scrittura e' ignorato di proposito (commento righe 750-755).
- [S] `update_one` salta i sotto-tree il cui cache-tree ha `entry_count >= 0` e il cui OID esiste gia' nell'odb (`has_object`, `cache-tree.c` ~riga 294): non riscrive oggetti che ci sono.

### 2.2 Esperimenti [E]

**Conflitti non risolti** (`git merge` con conflitto su `a.txt`; `ls-files -s` mostra gli stadi 1, 2, 3):

```
$ git write-tree
a.txt: unmerged (da0f8ed91a8f2f0f067b3bdf26265d5ca48cf82c)
a.txt: unmerged (cbb9aa30a6518a54df04c4d7b62e5c5e2864eafc)
a.txt: unmerged (2299c37978265a95cbe835a4b0f0bbf15aad5549)
fatal: git-write-tree: error building trees           (exit 128)
$ git write-tree --missing-ok                          # stesso output, exit 128
```

`--missing-ok` non aiuta sui conflitti. In un hook, `git commit` senza `-a` non arriva nemmeno all'hook con file non risolti (punto 1.3).

**Blob mancante** (`git update-index --add --cacheinfo 100644,deadbeefdeadbeefdeadbeefdeadbeefdeadbeef,ghost.txt`):

```
$ git write-tree
error: invalid object 100644 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef for 'ghost.txt'
fatal: git-write-tree: error building trees           (exit 128)
$ git write-tree --missing-ok
7539f13408f5aea5a354ae0d91c2f40c7a946077              (exit 0)
$ git cat-file -t 7539f134...                          -> tree
$ git ls-tree 7539f134...   -> 100644 blob deadbeef...	ghost.txt
$ git rev-list --objects 7539f134...
fatal: missing blob object 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'   (exit 128)
```

Un tree prodotto con `--missing-ok` esiste e ha tipo `tree` ma e' incompleto: solo `rev-list --objects` lo scopre.

**Entry intent-to-add** (`git add -N intent.txt`): `ls-files -s` mostra `e69de29b...` (blob vuoto) e `git status` ` A intent.txt`, ma `git write-tree` restituisce `8e99ff90...` = tree di `HEAD` e `intent.txt` non e' nel tree. Le entry i-t-a sono escluse dal tree. [E]

**Oggetti scritti** (repo piccolo, conteggio oggetti loose in `.git/objects`):

```
start: 59
after 'git add b.txt' (blob): 60
after 'git write-tree' => 2d2d9e813676ce0fdda7d02515e4537b867ed438 : 61   (+1: root tree)
second 'git write-tree' => same OID : 61                                 (nessun oggetto nuovo)
after changing sub/s.txt and add: 62 ; write-tree => bb2397e3...: 64     (+2 tree: sub/ e root)
index sha before write-tree: e8ba4fe8376e ; after: a5f89bf73716          (il file indice e' stato riscritto con il cache-tree)
```

`git write-tree` quindi scrive solo i tree nuovi, e se il cache-tree non era valido riscrive il file indice puntato da `GIT_INDEX_FILE`. [E] Dentro un commit as-is il cache-tree e' gia' aggiornato *prima* dell'hook ([S] riga 473-475), quindi il `write-tree` dell'hook costa praticamente nulla (inferenza dal sorgente + questi conteggi).

**Costo** (r3, 20 000 file in 200 directory, indice 1 605 361 byte):

| Scenario | Tempo | Oggetti scritti |
|---|---|---|
| cache-tree interamente valido (appena dopo un commit) | 0.017 s | 0 |
| dopo un file cambiato + `git add` | 0.019 s | +2 tree (20203 -> 20205) |
| indice **senza** cache-tree (ricostruito con `update-index --index-info`), tutti i tree gia' nell'odb | 0.105 s | 0 (20205 -> 20205) |
| come sopra, ma `GIT_OBJECT_DIRECTORY=<tmp vuota>` + `GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo>/.git/objects` | 0.123 s | 0 nella tmp (tutti i tree gia' presenti nell'alternato) |

### 2.3 Alternative che non scrivono oggetti nell'odb del repo [E]

Indice temporaneo + `GIT_OBJECT_DIRECTORY=<tmp>` + `GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo>/.git/objects`:

```
objects before: 65  (blob c9 already written by 'git add')
write-tree with GIT_OBJECT_DIRECTORY=tmp => d19093a2bc4b2b01bd7db2e0d28a8eed8cb9c615
objects after in repo odb: 65 (expected unchanged);  loose objects in tmp odb: 1
git cat-file -t d19093a2... in the real repo: fatal: git cat-file: could not get object info
same OID, with the tmp odb as alternate: tree
```

I tree nuovi finiscono solo nella cartella temporanea; il repo reale non li conosce. **Ma** gli oggetti *gia' presenti* nell'odb reale vengono "rinfrescati" (aggiornamento dell'mtime, `freshen_loose_object`, `object-file.c` riga 923): con un tree loose messo a `2020-01-01 00:00` con `touch -t`, dopo il `write-tree` via alternate l'mtime era `2026-10-09 07:18` (= l'ora della prova; 0 oggetti scritti nella tmp, perche' il tree esisteva gia'). Quindi quest'alternativa non e' "a scrittura zero" sul repo, tocca i metadati dei file oggetto. Inoltre il broker, per ritrovare quel tree, dovrebbe avere la tmp come alternate (non basta l'odb registrato). [E]

Altri modi per leggere il contenuto in staging senza scrivere tree (`git ls-files -s`, `git diff --cached --raw`) non producono un OID di tree; non e' stato provato nulla di piu'. [NV per qualunque altro schema di digest]

### 2.4 Persistenza dell'oggetto: `prune` e `gc` [E][D]

Un tree creato da un indice temporaneo e mai committato non e' raggiungibile. In un repo di prova:

```
TREE_REAL  (index .git/index)         = 3d6d4a4a3716ba95c8e38cc615baca055ac52763
TREE_TMP   (temp index, not committed) = add965173476bb73c8056b6632788c84bb09307b
$ git prune -n --expire=now      -> elenca TREE_TMP (tra altri); TREE_REAL non elencato
$ git prune --expire=now ; git cat-file -t TREE_REAL -> tree ; git cat-file -t TREE_TMP -> fatal: git cat-file: could not get object info
```

`TREE_REAL` e' protetto perche' `git prune` tratta come radici gli indici di tutti i worktree (`reachable.c` riga 370 `add_index_objects_to_pending`, `revision.c` righe 1823-1885) [S]. Un tree che e' solo nell'indice temporaneo (`index.lock`, `next-index-*.lock`) non lo e'. Di default `git gc` chiama `prune --expire 2.weeks.ago` (`Documentation/config/gc.adoc` righe 96-98) [D], quindi fra hook e uso da parte del broker (secondi) non e' un rischio, a meno di `gc.pruneExpire=now` o un `git prune --expire=now` manuale. Non studiato oltre. Se il commit prosegue, il tree diventa raggiungibile tramite il commit.

## 3. Materializzare un tree in una cartella temporanea senza toccare working tree, `HEAD`, indice reale

### 3.1 Documentazione e sorgente

- [D] `git-archive`: "writes ... the tree structure for the named tree"; con un tree ID (non un commit) "the current time is used as the modification time of each file in the archive" e l'ID del commit non e' disponibile (`git-archive.adoc` righe 24-31). "Note that attributes are by default taken from the `.gitattributes` files in the tree that is being archived." e `--worktree-attributes` per usare quelli del working tree; in alternativa `$GIT_DIR/info/attributes` (righe 180-186).
- [S] `archive.c` righe 526-545: senza `--worktree-attributes` spacchetta il tree in un indice in memoria e chiama `git_attr_set_direction(GIT_ATTR_INDEX)`, quindi gli attributi vengono dal tree. `attr.c` `read_attr` (841-872): con direzione `GIT_ATTR_INDEX` legge sempre dall'indice **prima** di considerare `--attr-source`, quindi `archive` non e' influenzato da `--attr-source`; nella direzione predefinita (`GIT_ATTR_CHECKIN`, quella di `checkout-index`) legge prima il file nel working tree e solo poi l'indice, **a meno che** sia impostata una sorgente di attributi (`tree_oid`): in quel caso legge solo dal tree (riga 849-850).
- [D] `git`: "`--attr-source=<tree-ish>`: Read gitattributes from <tree-ish> instead of the worktree. ... This is equivalent to setting the `GIT_ATTR_SOURCE` environment variable." (`git.adoc` righe 228-231). Implementazione: `attr.c` righe 1175-1223 (`compute_default_attr_source`).
- [D] `git-checkout-index`, esempio "export an entire tree": "Just read the desired tree into the index, and do: `git checkout-index --prefix=git-export-dir/ -a`" (`git-checkout-index.adoc` righe 156-166).
- [D] `git-worktree`: `add <path> [<commit-ish>]` (riga 66): serve un commit-ish, non un tree.

### 3.2 Esperimenti sul fixture r2 [E]

Tutti con `TREE=$(git write-tree)` = `180634bd209b4a81c5d70073d101abc532276466` (indice) e con la verifica finale `SNAPSHOT BEFORE == SNAPSHOT AFTER` (`shasum .git/index` = `30ae76bb580c`, `HEAD=2e03bcb`, `status=[MM .gitattributes MM plain.txt]`, working tree invariato).

Comandi:

```
M1   git archive --format=tar "$TREE" | tar -x -C out/m1
M1c  git archive --format=tar --worktree-attributes "$TREE" | tar -x -C out/m1c
M1d  (cd out && git --git-dir=r2/.git archive --format=tar "$TREE" | tar -x -C out/m1d)      # da fuori dal working tree
M2   GIT_INDEX_FILE=out/m2tmp/index git read-tree "$TREE"
     GIT_INDEX_FILE=out/m2tmp/index git checkout-index -a --prefix=out/m2/                    # dentro il repo
M3   GIT_INDEX_FILE=out/m3tmp/index git read-tree "$TREE"
     GIT_INDEX_FILE=out/m3tmp/index git --work-tree=out/m3 checkout-index -a                  # work tree = cartella vuota
M3b  come M3 ma da fuori, con --git-dir=r2/.git --work-tree=out/m3b                            # identico a M3 (diff -r)
A1   GIT_INDEX_FILE=... git --attr-source="$TREE" checkout-index -a --prefix=out/a1/          # dentro il repo
A2   GIT_ATTR_SOURCE="$TREE" GIT_INDEX_FILE=... git checkout-index -a --prefix=out/a2/
M4   git worktree add --detach out/m4 "$TREE"
M4b  C=$(git commit-tree "$TREE" -m tmp); git worktree add -q --detach out/m4b "$C"
```

Risultato per file (contenuto atteso se "fedele all'indice": `.gitattributes` = A1, `plain.txt` = `staged content`):

| File | M1 `archive <tree>` | M1c `archive --worktree-attributes` | M2 `checkout-index --prefix` dentro il repo | M3 work-tree vuoto, A1 `--attr-source=<tree>`, A2 env, M4b worktree |
|---|---|---|---|---|
| `.gitattributes` | A1 | A1 | A1 | A1 |
| `plain.txt` | `staged content` | `staged content` | `staged content` | `staged content` |
| `crlf.txt` (blob: `l1`/`l2` LF) | LF (A1 non ha `eol`) | **CRLF** (attributi del working tree A2) | **CRLF** | LF |
| `filt.txt` (blob: `mixed Case`) | `MIXED CASE` (smudge `upper` da A1) | `mixed Case` (A2 senza filtro) | `mixed Case` | `MIXED CASE` |
| `ignored.txt` (export-ignore in A1) | **assente** | presente | presente | presente (`export-ignore` vale solo per `archive`) |
| `subst.txt` (export-subst) | `$Format:%H$` non espanso | `$Format:%H$` | `$Format:%H$` | `$Format:%H$` |
| `exec.sh` | `-rwxr-xr-x` | `-rwxr-xr-x` | `-rwxr-xr-x` | `-rwxr-xr-x` |
| `link` | symlink -> `plain.txt` | idem | idem | idem |
| `sm` (submodule) | directory **vuota** | idem | idem | idem |
| `dir/nested.txt` | presente | presente | presente | presente |

Controllo M1b (`git archive <commit di HEAD>`): attributi A0, `plain.txt` = `hello`, `subst.txt` espanso con l'hash del commit `2e03bcbb...` (con un tree ID non c'e' commit da espandere).

Cosa dicono i numeri:

- `git archive <tree>` e' fedele al tree: attributi del tree, non del working tree (M1 vs M1c). Funziona da fuori dal working tree con `--git-dir` (M1d, exit 0).
- `checkout-index --prefix` lanciato **dentro il repo** senza `--attr-source` NON e' fedele (M2): legge il `.gitattributes` del working tree. Contromisure verificate: `--work-tree` su cartella vuota (M3, M3b anche da fuori), oppure `--attr-source=<tree>` / `GIT_ATTR_SOURCE=<tree>` (A1, A2): `diff -r a1 a3` e `diff -r a1 a2` risultano identici; `diff -r a1 a4` (vs archive) differisce solo per `ignored.txt`. Il controllo A5 (senza `--attr-source`) differisce da A1 in `crlf.txt` e `filt.txt`.
- `git worktree add <dir> <tree-oid>` fallisce: `error: object 180634bd... is a tree, not a commit` / `fatal: invalid reference: 180634bd...` (exit 128). Con `commit-tree` si crea un commit (+1 oggetto loose: 16 -> 17) e `git worktree add --detach` registra `.git/worktrees/m4b` (visibile in `git worktree list`); `git worktree remove --force` lo pulisce ma il commit resta (`git cat-file -t` = `commit`). Contenuto identico a M3. Tocca quindi lo stato del repo (`.git/worktrees`, un commit orfano) anche se working tree e `HEAD` restano uguali.

### 3.3 Export byte per byte uguale ai blob [E]

Fixture r2, per ogni blob regolare `git cat-file blob "$TREE:$p" | cmp - out/<dir>/$p` (esclusi symlink e `sm`). `EMPTY=4b825dc642cb6eb9a060e54bf8d69288fbee4904`.

| Variante | File diversi dal blob |
|---|---|
| B0: `checkout-index --prefix` dentro il repo, nessuna opzione | `crlf.txt` |
| B1: `git --attr-source=$EMPTY checkout-index ...` | nessuno |
| B2: B1 + `-c core.autocrlf=true` | `.gitattributes .gitmodules crlf.txt dir/nested.txt exec.sh filt.txt ignored.txt plain.txt subst.txt` (conversione guidata dalla config sopravvive) |
| B3: B1 + `-c core.attributesFile=<file con "plain.txt text eol=crlf">` | `plain.txt` (gli attributi globali sopravvivono a `--attr-source`) |
| B4: B1 + `-c core.autocrlf=false -c core.attributesFile=/dev/null` + `GIT_ATTR_NOSYSTEM=1` | nessuno (`ignored.txt` presente, `subst.txt` = `$Format:%H$`, `filt.txt` = `mixed Case`) |
| B5: `git --attr-source=$EMPTY archive <tree>` | `filt.txt`, e `ignored.txt` assente: **`--attr-source` non cambia `archive`** |
| B6: `git -c core.attributesFile=<globale> archive <tree>` | `filt.txt`, `plain.txt`, `ignored.txt` assente: gli attributi globali raggiungono `archive` |

Conclusione: "byte per byte come i blob" si ottiene solo con `checkout-index` + `--attr-source=<tree vuoto>` + configurazione neutra; `archive` applica sempre gli attributi del tree (smudge, export-ignore) e non si neutralizza con `--attr-source`. Nota: `$GIT_DIR/info/attributes` e' citato dalla documentazione di `archive` come fonte di attributi; l'effetto su `checkout-index` con `--attr-source` non e' stato provato [NV].

### 3.4 Cio' che NON riproduce fedelmente l'indice

- **Attributi del working tree**: `checkout-index` dentro il repo senza `--attr-source` (M2, B0); `archive --worktree-attributes` (M1c). [E]
- **Configurazione dell'utente/macchina**: `core.autocrlf=true` converte sia con `archive` sia con `checkout-index`: `plain.txt` esce `staged content^M|` e `exec.sh` `#!/bin/sh^M|echo hi^M|` (E1, passato con `-c`, a rappresentare `~/.gitconfig`). `core.symlinks=false`: `archive` mantiene il symlink, `checkout-index` scrive un file regolare con contenuto `plain.txt` (E2). [E]
- **Filtri `filter.<driver>.smudge`**: sono comandi arbitrari presi dalla config e *eseguiti* da entrambi. Con `filter.upper.required=true` e `smudge=false`: `error: external filter 'false' failed 1` / `fatal: filt.txt: smudge filter upper failed`, exit 128 sia per `archive` sia per `checkout-index` (E5). Una materializzazione puo' quindi eseguire codice dello sviluppatore e fallire per colpa della config. [E]
- **Attributi globali e di sistema** (`core.attributesFile`, file di sistema): influenzano `checkout-index` anche con `--attr-source` (B3) e `archive` (B6). [E]
- **Filesystem case-insensitive** (APFS): un tree con `File` e `file`. `git archive | tar -x`: exit 0, **un solo** file `file` con contenuto `two` (sovrascrittura silenziosa). `checkout-index -a`: `file already exists, no checkout`, exit 1, resta `File` con contenuto `one`. Esiti diversi e diversi codici d'uscita. [E]
- **Submodule**: il gitlink diventa una directory vuota (`sm/ (dir, 0 entries)`); il contenuto del submodule non e' materializzato. [E]
- **`export-subst`**: non espanso con un tree ID (`$Format:%H$` resta). **`export-ignore`**: omette file solo in `archive`. **Tempo**: `archive` di un tree ID usa l'ora corrente come mtime (D, non misurato sui file estratti). [E][D]
- **Git LFS**: `git: 'lfs' is not a git command` su questa macchina; non verificato. [NV]
- **Sparse checkout / skip-worktree / assume-unchanged**: non provati. [NV]

### 3.5 Costo (r3, 20 000 file) [E]

| Operazione | Tempo |
|---|---|
| `git archive --format=tar <tree> \| tar -x` | 1.593 s |
| indice temporaneo: `read-tree` + `checkout-index -a` con `GIT_WORK_TREE` vuoto | 1.209 s |
| indice temporaneo: `read-tree` + `checkout-index --prefix` con cwd nel working tree | 1.279 s |

Contenuto identico fra `archive` e `checkout-index` in quel fixture (senza attributi). Un file `GIT_INDEX_FILE` temporaneo e' creato da `read-tree`; l'indice reale (`shasum .git/index`) non e' cambiato (E6).

## 4. Worktree collegati, `GIT_DIR` e `GIT_COMMON_DIR`

### 4.1 Documentazione e sorgente

- [D] `gitrepository-layout`: `commondir` ("If this file exists, $GIT_COMMON_DIR will be set to the path specified in this file if it is not explicitly set"), `worktrees` ("Contains administrative data for linked working trees"), `worktrees/<id>/gitdir` (righe 268-290). L'indice del worktree collegato sta in `worktrees/<id>/index`; `objects`, `hooks`, `refs` condivisi nella directory comune.
- [D] `git-rev-parse`: `--git-common-dir`: "Show `$GIT_COMMON_DIR` if defined, else `$GIT_DIR`." (riga 267-268); `--local-env-vars` elenca le variabili che l'hook dovrebbe ripulire per lavorare su un altro repo (`githooks.adoc` righe 30-40: `unset $(git rev-parse --local-env-vars); git -C ../foreign-repo ...`).
- [S] `GIT_DIR` esportata nel worktree collegato: `setup.c` righe 1132 e 1663 (vedi punto 1.2).

### 4.2 Esperimenti [E]

Fixture: `git worktree add -b wt ../r1-wt` dal repo r1 (principale). `r1-wt/.git` e' un file: `gitdir: <main>/.git/worktrees/r1-wt`; `<main>/.git/worktrees/r1-wt/` contiene `HEAD ORIG_HEAD commondir gitdir index logs refs`. Un hook installato in `<main>/.git/hooks` e' stato eseguito dal commit lanciato in `r1-wt` (hook condivisi). Il runner conosce **solo** `<main>` (cosi' registrato).

Visto dall'hook in `r1-wt` (casi 11a, 11b, 11c):

```
GIT_DIR=<main>/.git/worktrees/r1-wt
GIT_EDITOR=:
GIT_INDEX_FILE=<main>/.git/worktrees/r1-wt/index              (11a commit)
               <main>/.git/worktrees/r1-wt/index.lock         (11b commit -a)
               <main>/.git/worktrees/r1-wt/next-index-11951.lock   (11c commit --only c.txt)
GIT_PREFIX=
rev-parse: --git-dir=<main>/.git/worktrees/r1-wt  --absolute-git-dir=<main>/.git/worktrees/r1-wt
           --git-common-dir=<main>/.git  --show-toplevel=<...>/r1-wt
```

`GIT_WORK_TREE` e `GIT_COMMON_DIR` **non** sono esportate. Nel worktree principale `--git-common-dir` restituisce il percorso relativo `.git` (casi 1-5 e 11d); con `git rev-parse --path-format=absolute --git-common-dir` restituisce l'assoluto (verificato nel worktree principale: `<main>/.git`).

Confronto OID (runner con `env -i`, cwd altrove, repo registrato = `<main>`):

| Caso | OID dell'hook | `git -C <main> write-tree` (indice di default del runner) | `GIT_INDEX_FILE=<abs dell'hook> git -C <main> write-tree` |
|---|---|---|---|
| 11a worktree collegato, commit | `4c3c9b6c5705d00f187acefab47010ec05154963` | `e23ded9f8eabb5177f57513b50012e7f0d04b345` (indice del *principale*) | `4c3c9b6c...` (uguale) |
| 11b collegato, `-a` | `56076821bd859e5c1871ebb97026623f33ed23cf` | `e23ded9f...` | `56076821...` |
| 11c collegato, `--only c.txt` | `20856a5ef8f758fdc58a460f4dd6a772644926ed` | `e23ded9f...` | `20856a5e...` |
| 11d **principale**, commit (con il collegato esistente) | `1324f72bc4bcfc9cdd1cc6b62fd0fbf32cddde71` | `1324f72b...` (uguale) | `1324f72b...` |

Per tutti: `git -C <main> cat-file -t <oid>` = `tree`; `git -C <main> rev-parse --verify <oid>^{tree}` = `<oid>`; `git -C <main> ls-tree -r <oid> | wc -l` = 6. L'odb e' **condiviso**: un tree creato dal worktree collegato e' visibile dal repo registrato. `git -C <main> worktree list --porcelain` elenca i worktree con percorso, `HEAD`, ramo.

Cosa NON e' stato studiato: se il runner potrebbe individuare da solo "quale worktree sta committando" (euristica), perche' non gli viene detto: [NV]. Cosa e' documentato ma non provato qui: che con `GIT_DIR` esportata un `git -C <altro repo>` dentro l'hook agisca ancora sul repo di `GIT_DIR` (motivo per cui `githooks` consiglia di ripulire le variabili) [D][NV].

## 5. Un terzo processo puo' verificare un OID di tree?

### 5.1 Comportamento osservato [E]

Repo r1, runner / shell pulita, per ciascun input `git cat-file -t X` e `git rev-parse --verify X^{tree}`:

| Input `X` | `cat-file -t` | `rev-parse --verify X^{tree}` |
|---|---|---|
| tree esistente `d19093a2bc4b2b01bd7db2e0d28a8eed8cb9c615` | `tree` | stesso OID |
| tree `e23ded9f8eabb5177f57513b50012e7f0d04b345` | `tree` | stesso OID |
| **commit** `10dd94345455e3c1eabcd89588aedeae2f729d41` | `commit` | `e23ded9f...` (il tree del commit: **pela** il commit) |
| **blob** `da0f8ed91a8f2f0f067b3bdf26265d5ca48cf82c` | `blob` | `error: ...^{tree}: expected tree type, but the object dereferences to blob type` |
| prefisso `d19093a2` | `tree` | OID pieno |
| nome di ramo `main` | `commit` | tree di HEAD |
| `HEAD^{tree}` | `tree` | tree di HEAD |
| OID inesistente `0123456789012345678901234567890123456789` | `fatal: git cat-file: could not get object info` | `fatal: Needed a single revision` |
| `not-a-hex` | `fatal: Not a valid object name not-a-hex` | `fatal: Needed a single revision` |

Quindi `rev-parse --verify <x>^{tree}` **non** distingue un OID da un nome simbolico o da un prefisso: accetta `main`, `HEAD^{tree}`, un prefisso, un commit. Per accettare *solo* un OID di tree serve prima un controllo di formato (esadecimale intero della lunghezza dell'algoritmo: 40 per sha1, 64 per sha256) e poi `cat-file -t` uguale a `tree`. [E] ([NV] per i repo sha256.) [D] `git-cat-file`: "`-t` Instead of the content, show the object type identified by `<object>`." (riga 39-41).

### 5.2 Esiste nell'odb del repo registrato?

Si', se l'hook ha scritto il tree nell'odb del repo (il caso di `git write-tree` normale) e il repo registrato condivide l'odb (stesso repo o worktree collegato): confermato dai casi 11a-c e 1-5. **No**, se l'OID e' stato prodotto con un odb temporaneo non alternato (punto 2.3): `cat-file -t` fallisce nel repo reale. [E]

### 5.3 Cosa garantisce e cosa NO

Garantisce [E]:

- che l'oggetto con quell'OID esiste nell'odb visibile al broker e ha tipo `tree` (`cat-file -t`);
- con `git rev-list --objects <oid>` (exit 0): che tutti gli oggetti raggiungibili da quel tree esistono (un tree prodotto con `--missing-ok` fallisce qui con `fatal: missing blob object ...`, mentre `cat-file -t` dice `tree`, punto 2.2);
- con `git ls-tree -r <oid>`: l'elenco di percorsi, modi e blob: il contenuto che il tree dichiara.

NON garantisce [E]:

- **Provenienza.** Qualunque processo che scriva oggetti nell'odb (anche un `write-tree` su un indice temporaneo qualsiasi, vedi `TREE_TMP` al punto 2.4, o un tree con `--missing-ok` come `7539f134...`) produce un OID per cui `cat-file -t` dice `tree`. L'esistenza non dimostra che l'OID sia l'indice dell'hook, ne' che sia il contenuto in staging.
- **Che il commit avverra'.** L'hook parte anche se non c'e' nulla da committare, e `prepare-commit-msg`/`commit-msg` dopo di lui possono abortire (punto 1.3).
- **Persistenza.** Un tree non raggiungibile puo' essere potato (punto 2.4); non e' un problema nei secondi che separano hook e broker, lo e' se l'OID viene conservato.
- **Identita' col commit finale** nel commit as-is, per la corsa del punto 1.4.
- Se `cat-file -t` ricalcola e verifica l'hash del contenuto dell'oggetto letto: [NV] (non verificato; `git fsck` non e' stato usato).

Ricalcolo da parte del broker: possibile solo con `GIT_INDEX_FILE=<percorso assoluto passato dall'hook> git -C <repo> write-tree`, con le trappole del punto 1.5 (file sparito -> tree vuoto con exit 0; lock preso dal `write-tree`; percorso relativo). Un ricalcolo che usa un input fornito dallo stesso chiamante da' lo stesso grado di fiducia dell'OID fornito dal chiamante: cambia solo il controllo di coerenza, non la provenienza. (Osservazione, non prova.)

## Non verificato

- **Git LFS** (`filter=lfs`): non installato qui (`git: 'lfs' is not a git command`); nessuna prova di cosa faccia un export con puntatori LFS.
- **Altri sistemi e versioni**: provato solo macOS/APFS case-insensitive, `git version 2.50.1 (Apple Git-155)`; sorgenti letti al tag `v2.50.1`. Linux, Windows, altre versioni di git non provati (il passaggio di `GIT_INDEX_FILE` relativo/assoluto e' una scelta di implementazione che potrebbe variare).
- **Repo sha256**; **sparse-index, skip-worktree, assume-unchanged**; **partial clone / promisor** (`cache-tree.c` riga 487 ha un ramo per i promisor); **fsmonitor**; **split-index** (`sharedindex.*`).
- **`git commit -p` / `--interactive`** e `--pathspec-from-file`: descritti dal sorgente (righe 387-427), non eseguiti. **`merge`, `cherry-pick`, `rebase`** (sequencer) e il comportamento dell'hook in quei flussi: non provati.
- **Altri hook** (`prepare-commit-msg`, `commit-msg`, `post-commit`): ordine letto nel sorgente, non provati; il fatto che possano far abortire il commit dopo il `pre-commit` e' `[S]`.
- **Rollback con hook fallito per `--include` / `--only` / `-p`**: provato solo per `-a`.
- **Submodule**: materializzazione del contenuto del submodule non studiata (solo gitlink = directory vuota).
- **`$GIT_DIR/info/attributes`** e il suo effetto su `checkout-index` con `--attr-source`; **`core.eol`** e altre config di conversione non provate.
- **`git -C <altro repo>` dentro l'hook con `GIT_DIR` esportata** (worktree collegato): raccomandazione documentata in `githooks`, comportamento non riprodotto.
- **Individuazione autonoma del worktree che sta committando** da parte del runner (euristica): non studiata.
- **`cat-file -t` e verifica dell'hash del contenuto**; **tempi di `prune`/`gc`** oltre gli esperimenti e il default documentato di 2 settimane.
- **Tempi di `git archive` con tree ID su `mtime` estratti**: letto nella documentazione, non misurato sui file.

## Fonti

Documentazione (pagine correnti; il testo e' stato verificato su `Documentation/*.adoc` del tag `v2.50.1`):

- githooks: https://git-scm.com/docs/githooks (https://github.com/git/git/blob/v2.50.1/Documentation/githooks.adoc)
- git-commit: https://git-scm.com/docs/git-commit (https://github.com/git/git/blob/v2.50.1/Documentation/git-commit.adoc)
- git-write-tree: https://git-scm.com/docs/git-write-tree (https://github.com/git/git/blob/v2.50.1/Documentation/git-write-tree.adoc)
- git-read-tree: https://git-scm.com/docs/git-read-tree
- git-checkout-index: https://git-scm.com/docs/git-checkout-index (https://github.com/git/git/blob/v2.50.1/Documentation/git-checkout-index.adoc)
- git-archive: https://git-scm.com/docs/git-archive (https://github.com/git/git/blob/v2.50.1/Documentation/git-archive.adoc)
- gitattributes: https://git-scm.com/docs/gitattributes
- git (opzione `--attr-source`, `GIT_ATTR_SOURCE`): https://git-scm.com/docs/git (https://github.com/git/git/blob/v2.50.1/Documentation/git.adoc)
- git-worktree: https://git-scm.com/docs/git-worktree
- git-rev-parse: https://git-scm.com/docs/git-rev-parse
- git-cat-file: https://git-scm.com/docs/git-cat-file
- git-prune: https://git-scm.com/docs/git-prune
- git-gc / `gc.pruneExpire`: https://git-scm.com/docs/git-gc (https://github.com/git/git/blob/v2.50.1/Documentation/config/gc.adoc)
- gitrepository-layout: https://git-scm.com/docs/gitrepository-layout

Sorgente (tag `v2.50.1`):

- `builtin/commit.c`: https://github.com/git/git/blob/v2.50.1/builtin/commit.c (`prepare_index` L348-547, `prepare_to_commit` L743, hook L761, controllo "nothing to commit" L1060, riletture indice L1080-1093)
- `commit.c` (`run_commit_hook`, L1938-1960): https://github.com/git/git/blob/v2.50.1/commit.c
- `setup.c` (L1132, L1663): https://github.com/git/git/blob/v2.50.1/setup.c
- `cache-tree.c` (`write_index_as_tree`, L727-761): https://github.com/git/git/blob/v2.50.1/cache-tree.c
- `builtin/write-tree.c`: https://github.com/git/git/blob/v2.50.1/builtin/write-tree.c
- `archive.c` (L526-545): https://github.com/git/git/blob/v2.50.1/archive.c
- `attr.c` (`read_attr` L841-872, `compute_default_attr_source` L1175-1223): https://github.com/git/git/blob/v2.50.1/attr.c
- `object-file.c` (`freshen_loose_object`, L923): https://github.com/git/git/blob/v2.50.1/object-file.c
- `reachable.c` (L370) e `revision.c` (L1823-1885): https://github.com/git/git/blob/v2.50.1/reachable.c , https://github.com/git/git/blob/v2.50.1/revision.c

Esperimenti: eseguiti nello scratchpad di sessione (non versionato) con `git version 2.50.1 (Apple Git-155)`; i comandi e gli output rilevanti sono riportati nelle sezioni sopra.
