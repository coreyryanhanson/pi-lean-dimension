# WAF / Firewall Notes

> Central tracker for Web Application Firewall (WAF), rate-limiting, or
> bot-detection quirks observed against API endpoints during endpoint-
> coverage plan drafting. Each entry records the symptom, the observed
> protection layer, and any workaround known.

## Purpose

When probing API endpoints with `curl` or `web-fetch` during plan
drafting, some APIs respond with HTTP 403/503 or a CAPTCHA page instead
of the expected JSON. This usually means the API sits behind a WAF
(Cloudflare, Imperva/Incapsula, Akamai, AWS WAF, etc.) that blocks
non-browser User-Agents, missing headers, or requests without cookies.

These issues rarely block the pi-lean-host tool at runtime (it uses
Node.js `fetch()` with standard headers) but they **do** block live
probes and integration tests run from the command line. This tracker
exists so implementers know what to expect.

---

## Entries

### `datos.gob.es`

- **Observed:** 2026-07-20 during Batch A plan drafting
- **Symptom:** `curl -sI` returns `HTTP/2 503` with response body
  containing Imperva/Incapsula tracking cookies (`visid_incap_*`,
  `nlbi_*`, `incap_ses_*`) and `x-cdn: Imperva` header.
- **WAF layer:** Imperva Incapsula (application-layer WAF + DDoS
  protection). Fingerprints by User-Agent, TLS handshake, and request
  patterns.
- **Affected endpoints:** All API endpoints under `/apidata/` —
  confirmed: `/apidata/catalog/publisher`, `/apidata/nti/public-sector`,
  `/apidata/catalog/dataset/format/csv`.
- **Does NOT affect:** The docs pages (`/en/apidata`,
  `/en/accessible-apidata`) — those are served through a separate path
  (Drupal/CKAN frontend) and are reachable by `web-fetch` / `curl`.
- **Workaround:** The pi-lean-host `restGet`/`paginate` tool works
  (existing `listDatasets` operation runs fine in production). The WAF
  tolerates Node.js `fetch()` with the default UA. For live probes and
  integration tests, run the request through the pi-lean-host tool
  rather than raw `curl`.
- **Risk to integration tests:** `endpoint-coverage.test.ts` using the
  recipe's `execute` path should work (same code path as the tool).
  Direct `fetch()` in test code without matching headers may hit the
  WAF; use the `apiFetch` helper from the guide pipeline instead.

---

### `www.federalregister.gov`

- **Observed:** 2026-07-21 during Batch B plan drafting
- **Symptom:** `curl` to the docs page (`https://www.federalregister.gov/developers`)
  returns an HTML "Request Access" page with a reCAPTCHA challenge instead of
  the developer documentation. The page states: *"Due to aggressive automated
  scraping of FederalRegister.gov and eCFR.gov, programmatic access to these
  sites is limited to access to our extensive developer APIs."* A `POST /unblock`
  form with a `g-recaptcha-response` is required to clear the block.
- **WAF layer:** reCAPTCHA + custom bot-detection on the **HTML website**
  (not the API). The block is site-wide for non-browser UAs hitting HTML
  pages; it is NOT applied to `/api/v1/*` JSON endpoints.
- **Affected endpoints:** The developer docs page (`/developers`, `/developers/api/v1`)
  and the general HTML site. The CAPTCHA wall prevented `web-fetch`/`curl`
  from retrieving the API reference during plan drafting.
- **Does NOT affect:** The entire `/api/v1/` JSON API — every endpoint probed
  (`/api/v1/documents`, `/api/v1/agencies`, `/api/v1/articles`,
  `/api/v1/public_inspection_documents`, `/api/v1/sections`, and the
  single-resource lookups `/api/v1/documents/{document_number}` and
  `/api/v1/agencies/{slug}`) returned clean JSON with HTTP 200 to plain
  `curl` with no auth, no cookies, no special headers.
- **Workaround:** Two paths:
  1. **For the API** — probe directly via `/api/v1/*`. Every JSON endpoint
     returns clean 200s to plain `curl` with no auth/cookies/headers.
  2. **For the API reference docs** — use the pi-lean-portal `browser-navigate`
     tool (Chromium). The CAPTCHA wall targets non-browser User-Agents; a real
     browser session loads the Swagger UI at
     `/developers/documentation/api/v1` without challenge. The full OpenAPI
     spec can then be extracted from the Swagger UI's in-memory store via
     `browser-console` (`window.ui.specSelectors.specJson().toJS()`). Do NOT
     use `curl`/`web-fetch` for the docs pages — they hit the CAPTCHA wall.
- **Risk to integration tests:** None for the API. `endpoint-coverage.test.ts`
  hitting `/api/v1/*` will pass without special handling. Do NOT point tests
  at the HTML `/developers` page — that will hit the CAPTCHA wall.

## Template

```markdown
### `domain.tld`

- **Observed:** YYYY-MM-DD during <batch>
- **Symptom:** <HTTP status, response body snippet, headers>
- **WAF layer:** <Cloudflare / Imperva / Akamai / AWS WAF / custom>
- **Affected endpoints:** <paths or patterns>
- **Does NOT affect:** <paths that work fine>
- **Workaround:** <how to probe successfully>
- **Risk to integration tests:** <pass/fail, mitigation>
```
