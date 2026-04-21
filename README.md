![Header](https://github.com/christivn/mapScraper/blob/main/github-header-image.png?raw=true)

# Google Maps Scraper (JavaScript)

A Node.js + `pnpm` Google Maps scraper for local business data, migrated from the original Python implementation with feature parity.

## Features

- Single-query scraping from CLI
- Multi-query scraping via text file
- Configurable concurrency for file mode
- Language/country targeting (`--lang`, `--country`)
- Result limiting (`--limit`)
- CSV export with stable schema
- Same output fields as the previous Python version:
  - `id`, `url_place`, `title`, `category`, `address`
  - `phoneNumber`, `completePhoneNumber`, `domain`, `url`
  - `coor`, `stars`, `reviews`, `source_query`

## Requirements

- Node.js 20+
- `pnpm` 10+

## Installation

```bash
git clone https://github.com/christivn/mapScraper.git
cd mapScraper
pnpm install
```

## Usage

Basic:

```bash
node mapScraperX.js "your search query"
```

With options:

```bash
node mapScraperX.js "coffee shops in London" --lang en --country gb --limit 50 --output-file data/generated/london.csv
```

From query file:

```bash
node mapScraperX.js --queries-file query_example.txt --lang en --country us --limit 25 --concurrent 3 --output-file data/generated/multi.csv
```

Force fallback mode (manual debugging):

```bash
node mapScraperX.js "dentistas en Madrid" --lang es --country es --force-fallback
```

## CLI Options

| Option | Description | Default |
|---|---|---|
| `query` | Single search query | - |
| `--queries-file <file>` | File with one query per line (`#` comments ignored) | - |
| `--lang <code>` | Language code | `en` |
| `--country <code>` | Country code | `us` |
| `--limit <n>` | Max results (single query total, file mode per query) | none |
| `--output-file <path>` | Output CSV path | `data/generated/output.csv` |
| `--concurrent <n>` | Max concurrent queries in file mode | `3` |
| `--force-fallback` | Skip primary parser and force fallback scraper | `false` |

## Output Layout

- Tracked sample output: `data/samples/output.sample.csv`
- Runtime/generated outputs: `data/generated/` (gitignored)
- Optional debug/verification outputs: `artifacts/` (gitignored)

## Testing

Run all tests:

```bash
pnpm test
```

The test suite covers:

- Place field extraction
- Pagination and limit behavior
- Multi-query aggregation with concurrency
- CSV schema and escaping

## Reliability Notes

- The scraper uses a two-step flow:
  1. Request Maps search page to extract canonical `tbm=map` search URL.
  2. Request `tbm=map` payload and parse nested results from `data[64]`.
- If the primary flow is blocked (consent wall / captcha / bot-detection style responses),
  the scraper automatically falls back to the secondary parser in
  `src/scraper-fallback.js`.
- For manual control/debugging, pass `--force-fallback` to use fallback mode directly.
- Google can change response shape at any time; parsing is defensive and fails gracefully.
- `reviews` is usually unavailable in this response format and is emitted as empty.

## Migration Status (Python -> JS)

The project is now JavaScript-first with `pnpm` tooling.

Validated parity checks performed during migration:

- Single query: Python and JS both returned 2 rows for the same live query.
- Multi-query file mode: Python and JS both returned 4 rows (`--limit 1`) over the same query file.
- Output CSV schema and headers match exactly.

Only one sample CSV is tracked in Git for reference:

- `data/samples/output.sample.csv`

## License

MIT
