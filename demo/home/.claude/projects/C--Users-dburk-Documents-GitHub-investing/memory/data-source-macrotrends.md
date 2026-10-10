---
name: data-source-macrotrends
description: Macrotrends is the only price source for the investing site; never Yahoo
metadata:
  type: feedback
---

Use Macrotrends for every price series (S&P 500, NASDAQ, Dow, gold, silver, copper). Don't add Yahoo Finance or another source as a fallback.

**Why:** Yahoo's history doesn't go back far enough. The charts start in 1927 for stocks and 1971 for metals.

**How to apply:** `scripts/fetch-data.mjs` calls Macrotrends through curl, because Node's fetch gets a 403 from Cloudflare. If GitHub's runners are ever blocked, refresh the CSVs by hand and commit them rather than switching sources.
