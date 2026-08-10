# BOE API — Endpoint Coverage Plan

> Drafted 2026-07-19 against the live docs page
> <https://www.boe.es/datosabiertos/api/api.php> (verified by browser
> navigation — see "Verification" below). Implements the 14 endpoints the
> current `guide.md` does not yet cover.
>
> The authoritative per-section API specs (3 PDFs + 4 FAQ pages) are
> cached as markdown under `api-guides/boe.es/spec/` by the Phase -1
> step below, so Phases 0–3 do not need web tools or network access in
> context — work from the cached files.

## Status quo

`guide.md` declares **3 of 17** documented endpoints:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `listConsolidada` | `/datosabiertos/api/legislacion-consolidada` |
| ✅ | `getConsolidada` | `/datosabiertos/api/legislacion-consolidada/id/{id}` |
| ✅ | `getSumario` | `/datosabiertos/api/boe/sumario/{fecha}` |

## Verification (live docs, 2026-07-19)

Browser-navigated to the docs URL and expanded all four accordion
sections. The authoritative endpoint list is:

```
Legislación consolidada (8)
  GET /datosabiertos/api/legislacion-consolidada                      ✅ listConsolidada
  GET /datosabiertos/api/legislacion-consolidada/id/{id}              ✅ getConsolidada
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/metadatos    ❌
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/metadata-eli ❌
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/analisis     ❌
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/texto        ❌
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/texto/indice ❌
  GET /datosabiertos/api/legislacion-consolidada/id/{id}/texto/bloque/{id_bloque} ❌

BOE (1)
  GET /datosabiertos/api/boe/sumario/{fecha}                          ✅ getSumario

BORME (1)
  GET /datosabiertos/api/borme/sumario/{fecha}                        ❌

Datos auxiliares (7)
  GET /datosabiertos/api/datos-auxiliares/materias                    ❌
  GET /datosabiertos/api/datos-auxiliares/ambitos                     ❌
  GET /datosabiertos/api/datos-auxiliares/estados-consolidacion       ❌
  GET /datosabiertos/api/datos-auxiliares/departamentos               ❌
  GET /datosabiertos/api/datos-auxiliares/rangos                      ❌
  GET /datosabiertos/api/datos-auxiliares/relaciones-anteriores       ❌
  GET /datosabiertos/api/datos-auxiliares/relaciones-posteriores      ❌
```

→ **14 endpoints to add.** No auth, no pagination on any of them (all
single-resource GETs or flat lookup tables). `helper: true` is not
needed except where date conversion applies (BORME sumario).

## Grouping for implementation

The 14 endpoints fall into three families with identical shape inside
each family. Implement family-by-family, not endpoint-by-endpoint.

### Group A — BORME sumario (1 endpoint, clone of `getSumario`)

```
GET /datosabiertos/api/borme/sumario/{fecha}
```

- Identical contract to the existing `getSumario` (BOE): `fecha` is a
  full day in `aaaammdd`, `accept: json`, single path param.
- The `helper.ts` `DATE_PARAMS` set already includes `fecha`, so the
  ISO→aaaammdd transform fires for free — **no helper change needed.**
- One new operation in `guide.md`: `getSumarioBorme`, `via: restGet`,
  `helper: true` (so the existing date transform runs).

### Group B — Consolidada sub-resources (6 endpoints, same `{id}` base)

All hang off `/datosabiertos/api/legislacion-consolidada/id/{id}` with
a suffix. Same `{id}` path param as the existing `getConsolidada`.

| Operation (proposed) | Path suffix | Notes |
|----------------------|-------------|-------|
| `getConsolidadaMetadatos` | `/metadatos` | metadata only (vs. full XML body) |
| `getConsolidadaMetadataEli` | `/metadata-eli` | ELI-scheme metadata |
| `getConsolidadaAnalisis` | `/analisis` | structural analysis |
| `getConsolidadaTexto` | `/texto` | full consolidated text |
| `getConsolidadaTextoIndice` | `/texto/indice` | text index/table of contents |
| `getConsolidadaTextoBloque` | `/texto/bloque/{id_bloque}` | a single text block |

- Accept formats are **authoritative from `spec/APIconsolidada.md` §2.2**
  (cached in Phase -1), so no live probe is needed for Group B:
  - `metadatos`, `analisis`, `texto/indice` → accept **XML or JSON**;
    use `accept: json` for easier consumption.
  - `metadata-eli`, `texto`, and `texto/bloque/{id_bloque}` → **XML-only**;
    use `accept: xml` + `parse: { format: xml, charset: utf-8 }`.
- The last (`…/texto/bloque/{id_bloque}`) has **two** path params
  (`{id}` and `{id_bloque}`); the schema infers path params from
  `{token}` tokens in `path`, so declaring the path
  `/datosabiertos/api/legislacion-consolidada/id/{id}/texto/bloque/{id_bloque}`
  is sufficient — no extra config.
- No helper needed (no dates, no query DSL). `helper: false` (omitted).

### Group C — Datos auxiliares lookup tables (7 endpoints, trivial)

```
GET /datosabiertos/api/datos-auxiliares/materias
GET /datosabiertos/api/datos-auxiliares/ambitos
GET /datosabiertos/api/datos-auxiliares/estados-consolidacion
GET /datosabiertos/api/datos-auxiliares/departamentos
GET /datosabiertos/api/datos-auxiliares/rangos
GET /datosabiertos/api/datos-auxiliares/relaciones-anteriores
GET /datosabiertos/api/datos-auxiliares/relaciones-posteriores
```

- All no-param, flat-list GETs. `accept: json`, `via: restGet`.
- These are the code tables that decode the `materia@codigo`,
  `ambito@codigo`, `departamento@codigo`, `rango@codigo`, and
  `estado_consolidacion@codigo` fields returned by `listConsolidada` —
  so they're the highest-value add for making existing results readable.
- **Open question:** do any of these paginate? The docs show them as
  plain `GET` with no query string. Plan assumes flat `restGet`; if a
  table is large and paginated, switch that one op to `via: paginate`
  with the guide's existing offset-limit config — but only after a live
  check, not speculatively.

## Implementation phases

### Phase -1 — Cache the API specs locally (no code changes, no network after)

The docs page links to 3 PDF specs and 4 FAQ pages. Cache them all as
markdown once, here, so every later phase reads local files instead of
re-fetching. `uvx --from 'markitdown[pdf]' markitdown` converts both the
PDFs and the HTML FAQ pages to markdown in one tool (verified working
on `APIconsolidada.pdf`). No `pip install` — `uvx` runs it ephemerally.

Target directory: `api-guides/boe.es/spec/` (gitignored from the npm
tarball alongside the rest of the guide dir; the cached specs are a
local dev reference, not a shipped artifact).

```bash
mkdir -p packages/pi-lean-host/api-guides/boe.es/spec

# 3 PDF specs → markdown via uvx + markitdown[pdf]
for spec in APIconsolidada APIsumarioBOE APIsumarioBORME; do
  curl -sS -o "/tmp/${spec}.pdf" "https://www.boe.es/datosabiertos/documentos/${spec}.pdf"
  uvx --quiet --from 'markitdown[pdf]' markitdown "/tmp/${spec}.pdf" \
    > "packages/pi-lean-host/api-guides/boe.es/spec/${spec}.md"
  rm "/tmp/${spec}.pdf"
done

# 4 FAQ pages → markdown (markitdown handles HTML too)
for faq in consolidada boe borme datos-auxiliares; do
  curl -sS "https://www.boe.es/datosabiertos/faq/${faq}.php" \
    | uvx --quiet --from 'markitdown[pdf]' markitdown \
    > "packages/pi-lean-host/api-guides/boe.es/spec/faq-${faq}.md"
done
```

Note: the Datos-auxiliares section has **no PDF spec** — only a FAQ
page. That's fine; the FAQ confirms the 7 endpoints are flat
controlled-vocabulary tables ("valores establecidos para determinados
metadatos", "vocabularios controlados"), updated daily, no params. This
resolves the Group-C pagination question **before** Phase 0: no
pagination, flat `restGet` is correct for all 7.

**Source-of-truth rule for later phases:** when a guide.md edit depends
on an endpoint's accept format, params, or response shape, cite the
cached spec file + line range (e.g. `spec/APIconsolidada.md` §2.2) in
the commit message or a `debug-notes.md` entry — do not re-fetch the
web page. The cached files are the reference; the live site is only
re-checked if a cached file is suspected stale.

Phase -1 already answered two of the plan's open questions (recorded
in Group B below): the consolidada sub-resource accept formats are
documented in `spec/APIconsolidada.md` §2.2 table — `metadatos`,
`analisis`, and `texto/indice` accept **XML or JSON**; `metadata-eli`
and `texto` are **XML-only**; `texto/bloque/{id_bloque}` is XML. So
Group B can use `json` for the three that support it (easier to
consume) and `xml` for the two XML-only ones, instead of defaulting
everything to xml.

### Phase 0 — Live shape probe (no code changes)

For each of the 14 endpoints, issue one `curl` (or `api-fetch` with
`HOST_INTEGRATION=1`) and record: status, `Content-Type`, sample body
size, and whether the body is JSON or XML. Specifically confirm:

1. ~~Each Datos-auxiliares endpoint returns JSON and is **not paginated**~~
   **Resolved by Phase -1** — the cached FAQ (`spec/faq-datos-auxiliares.md`)
   confirms they are flat controlled-vocabulary tables updated daily, no
   params, no pagination. Skip this probe.
2. ~~Each Consolidada sub-resource's required `Accept` header (xml vs.
   json)~~ **Resolved by Phase -1** — `spec/APIconsolidada.md` §2.2 lists
   the accept format per endpoint. Skip this probe.
3. BORME sumario returns JSON for a known publication date and uses the
   same `aaaammdd` `fecha` format as the BOE sumario. (Still worth a
   live 200 check since the BORME PDF spec should be read from
   `spec/APIsumarioBORME.md` first — only live-probe what the cached
   spec doesn't state.)

Output: a short table appended to `debug-notes.md` under a new
"Endpoint coverage probe (2026-07-19)" section. No `guide.md` edits yet.

### Phase 1 — Add Group C (lookup tables) to `guide.md`

Smallest, highest-value, lowest-risk. Seven near-identical `restGet`
operations. Append to the `operations:` list in `guide.md`:

```yaml
  - name: listMaterias
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/materias
    accept: json
  - name: listAmbitos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/ambitos
    accept: json
  - name: listEstadosConsolidacion
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/estados-consolidacion
    accept: json
  - name: listDepartamentos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/departamentos
    accept: json
  - name: listRangos
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/rangos
    accept: json
  - name: listRelacionesAnteriores
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/relaciones-anteriores
    accept: json
  - name: listRelacionesPosteriores
    via: restGet
    path: /datosabiertos/api/datos-auxiliares/relaciones-posteriores
    accept: json
```

Add a short "Auxiliary tables" subsection to the markdown body of
`guide.md` explaining these decode the `@codigo` fields in
`listConsolidada` results. Update the top-level `verified:` date.

If Phase 0 found any of these paginated, convert that one op to
`via: paginate` with the existing offset-limit pagination block instead.

### Phase 2 — Add Group A (BORME sumario) to `guide.md`

One operation, mirroring `getSumario`:

```yaml
  - name: getSumarioBorme
    via: restGet
    path: /datosabiertos/api/borme/sumario/{fecha}
    accept: json
    helper: true
```

No `helper.ts` change — `fecha` is already in `DATE_PARAMS`. Add a
short prose subsection noting the BORME is the mercantile-registry
gazette and shares the BOE sumario's date contract.

### Phase 3 — Add Group B (consolidada sub-resources) to `guide.md`

Six operations. Use the `accept` value confirmed in Phase 0 (defaulting
to `xml` per the existing `getConsolidada` precedent):

```yaml
  - name: getConsolidadaMetadatos
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/metadatos
    accept: json
  - name: getConsolidadaAnalisis
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/analisis
    accept: json
  - name: getConsolidadaMetadataEli
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/metadata-eli
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getConsolidadaTexto
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getConsolidadaTextoIndice
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto/indice
    accept: json
  - name: getConsolidadaTextoBloque
    via: restGet
    path: /datosabiertos/api/legislacion-consolidada/id/{id}/texto/bloque/{id_bloque}
    accept: xml
    parse:
      format: xml
      charset: utf-8
```

Add a "Consolidada sub-resources" prose subsection to `guide.md` body
explaining when to use each (metadatos vs. full texto vs. a single
bloque).

## Testing

### Unit tests (run in bare CI, no network)

`boe-helper.test.ts` already covers the helper transforms. The new
endpoints don't change the helper (Group A reuses `fecha`; Groups B/C
add no transform), so **no new unit tests are strictly required**.
However, add one regression test in
`packages/pi-lean-host/__tests__/parse-api-guide.test.ts` (or the
guide-loading test that covers `boe.es`) asserting the guide parses
with **17 operations** and every new `name` is present — this catches
YAML typos and schema violations without a network.

### Live smoke tests (require `HOST_INTEGRATION=1`)

Extend `integration-smoke.test.ts` (or add `boe-coverage-smoke.test.ts`)
gated on `HOST_INTEGRATION` so bare CI still skips. One assertion per
new endpoint — status 200 + non-empty body — using a known-good
fixture:

- `getSumarioBorme` → `fecha=20250101` (or a known BORME publication date).
- Each Datos-auxiliares endpoint → no params, assert `200` and a non-empty
  `data`/array body.
- Each Consolidada sub-resource → `id=BOE-A-2021-21346` (the fixture
  already used by `getConsolidada` in debug-notes), assert `200`.
- `getConsolidadaTextoBloque` → needs a valid `id_bloque`; fetch
  `getConsolidadaTextoIndice` first in-test to obtain one, then call the
  bloque endpoint. If obtaining a block id is fiddly, skip the bloque
  live smoke and rely on the Phase-0 probe record instead — don't block
  the whole phase on it.

### Manual `api-guide` check

After editing `guide.md`, run `api-guide` for `boe.es` from a pi session
and confirm all 17 operations appear with correct param hints. This is
the user-facing surface; a missing or mis-typed op name shows up here
immediately.

## Files touched

| File | Change |
|------|--------|
| `api-guides/boe.es/guide.md` | +14 operations across 3 families; +3 prose subsections; bump `verified:` |
| `api-guides/boe.es/helper.ts` | **No change** — `fecha` already transformed; new endpoints need no transform |
| `api-guides/boe.es/spec/` (new dir, local-only) | 3 cached PDF→md specs + 4 cached FAQ→md pages from Phase -1 |
| `api-guides/boe.es/debug-notes.md` | + "Endpoint coverage probe (2026-07-19)" section from Phase 0 |
| `__tests__/parse-api-guide.test.ts` (or boe guide-load test) | +1 regression test: 17 operations parse |
| `__tests__/integration-smoke.test.ts` or new `boe-coverage-smoke.test.ts` | +14 live smoke assertions (HOST_INTEGRATION-gated) |

## Out of scope / deliberate omissions

- **No new helper logic.** The existing date + query transforms cover
  every param shape the new endpoints use. Adding transforms for
  hypothetical future params would be speculative — skipped (YAGNI).
- **No pagination on the new endpoints unless Phase 0 proves one
  paginates.** Declaring `via: paginate` speculatively would add a
  `gatherAll` ceiling and offset/limit params the docs don't show.
- **No renaming of the existing 3 operations.** `getSumario` stays as
  the BOE sumario; the BORME one gets a distinct `getSumarioBorme`
  name rather than overloading `getSumario` with a path param switch,
  so callers stay unambiguous.
- **`relaciones-anteriores` / `relaciones-posteriores`** — the docs
  don't clarify whether these take an `{id}` path param (relations *of*
  a norm) or are flat tables. Phase 0 must confirm; if they're
  per-norm, switch those two from the Group-C flat-table shape to the
  Group-B `{id}` shape before Phase 1 commits them.

## Implementation notes

> Added 2026-08-05 during the rollout prerequisite pass. `boe.es` is the
> reference template for the 14-guide queue; the items below record the two
> deviations the prerequisite fix hit.

1. **Group C aux tables return a code→text MAP, not an array.** The live
   response for all seven `/datos-auxiliares/*` endpoints wraps the lookup
   table as a JSON **object** keyed by code (`data: {"2":"A Coruña",…}`),
   not the `{codigo,texto}` list the audit assumed. The prerequisite fix
   re-probed one endpoint live, corrected `endpoint-coverage.test.ts` to
   assert a non-empty map object instead of `Array.isArray`, and confirmed
   all seven pass live. No recipe (`guide.md`) change was needed — `via:
   restGet` and `accept: json` are both correct; the shape assertion in the
   test was the stale piece.
2. **`listConsolidada` now exercised through `paginate`.** The test helper
   `fetchOp` previously called `restGet` for every op, so the declared
   `via: paginate` executor was never the path under test. The prerequisite
   fix made `fetchOp` dispatch on `op.via` (`paginate` → `paginate`, else
   `restGet`) and updated the `listConsolidada` assertion to read the
   paginator's `{items,…}` result. This is the single-place fix the rollout
   flagged for all 14 guides — follower guides copy the corrected `fetchOp`.

Both changes are verified by `HOST_INTEGRATION=1 npx vitest run
packages/pi-lean-host/api-guides/boe.es/` (36/36 pass, all 17 ops covered).

## Order of work

0. **Phase -1** (cache specs) → populates `api-guides/boe.es/spec/`; resolves the Group-C pagination and Group-B accept-format questions before any probe.
1. **Phase 0** (probe) → updates `debug-notes.md` only; now scoped to just the BORME sumario live check.
2. **Phase 1** (Group C, lookup tables) → highest value, ships first.
3. **Phase 2** (Group A, BORME sumario) → trivial clone.
4. **Phase 3** (Group B, consolidada sub-resources) → most prose, last.
5. Final: bump `verified:`, run `api-guide` manual check, run
   `npm run test:ci` (structural) + `HOST_INTEGRATION=1` smoke.
