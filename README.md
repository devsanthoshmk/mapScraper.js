![Header](https://github.com/christivn/mapScraper/blob/main/github-header-image.png?raw=true)

# Google Maps Scraper (JavaScript)

Node.js + `pnpm` Google Maps scraper with CSV export, multi-query mode, and fallback scraping support.

## What This Project Does

- Scrapes business listings from Google Maps for a query.
- Supports single query and file-based batch queries.
- Exports normalized CSV output.
- Falls back to an alternate scraper path when the primary parser is blocked or unstable.

## Requirements

- Node.js `20+`
- `pnpm` `10+`

## Installation

### 1. For CLI Usage (Standalone)

Clone the repository and install dependencies to run the scraper directly from your terminal:

```bash
git clone https://github.com/devsanthoshmk/mapScraper.js.git
cd mapScraper.js
pnpm install
```

### 2. For Programmatic Usage (As a Dependency)

If you want to use the scraping logic in your own Node.js project, add it via `npm` or `pnpm` directly from GitHub:

```bash
# Using pnpm
pnpm add github:devsanthoshmk/mapScraper.js#main

# Using npm
npm install github:devsanthoshmk/mapScraper.js#main
```

## Quick Start (CLI)

Run one query:

```bash
pnpm start -- "dentists in madrid"
```

Run from query file:

```bash
pnpm start -- --queries-file query_example.txt --concurrent 3
```

Force fallback mode for debugging:

```bash
pnpm start -- "dentistas en Madrid" --lang es --country es --force-fallback
```

## Programmatic Usage

Once installed as a dependency, you can require the core functions using the package name `map-scraper-js` (as defined in `package.json`).

### Basic Example

```javascript
const { searchAsync, saveToCsv } = require('map-scraper-js');

async function run() {
  try {
    // Search for a single query
    const results = await searchAsync('dentists in madrid', 'es', 'es', 10);
    
    console.log(`Found ${results.length} results`);
    
    // Each result follows this schema:
    // {
    //   id: '...',
    //   url_place: '...',
    //   title: '...',
    //   category: '...',
    //   address: '...',
    //   phoneNumber: '...',
    //   completePhoneNumber: '...',
    //   domain: '...',
    //   url: '...',
    //   coor: '...',
    //   stars: '...',
    //   reviews: '...',
    //   source_query: '...'
    // }
    
    // Save to a custom CSV file
    saveToCsv(results, 'data/generated/dentists_madrid.csv');
  } catch (error) {
    console.error('Scraping failed:', error);
  }
}

run();
```

### Multiple Queries

```javascript
const { searchMultipleAsync } = require('map-scraper-js');

async function runBatch() {
  const queries = ['coffee shops in london', 'gyms in london'];
  const results = await searchMultipleAsync(queries, 'en', 'gb', 50, 3);
  
  console.log(`Total unique results across queries: ${results.length}`);
}

runBatch();
```

### API Reference

#### `searchAsync(query, lang, country, limit, fetchImpl, forceFallback)`
- `query`: (String) The search term.
- `lang`: (String) Language code (default: `en`).
- `country`: (String) Country code (default: `us`).
- `limit`: (Number) Maximum number of results to fetch.
- `forceFallback`: (Boolean) If true, skips the primary parser (default: `false`).

#### `searchMultipleAsync(queries, lang, country, limit, maxConcurrent, fetchImpl, forceFallback)`
- `queries`: (Array<String>) List of search terms.
- `maxConcurrent`: (Number) Maximum number of queries to run in parallel (default: `3`).

#### `saveToCsv(data, filename)`
- `data`: (Array<Object>) The results array.
- `filename`: (String) Output path (default: `data/generated/output.csv`).

## CLI Advanced Usage

If you are running from the source (cloned repo):

```bash
node mapScraperX.js [query] [options]
```

Rules:
- Provide either a positional `query` or `--queries-file`.
- Do not provide both together.

Options:

| Option | Description | Default |
|---|---|---|
| `query` | Single search query | - |
| `--queries-file <file>` | Text file with one query per line (`#` comment lines ignored) | - |
| `--lang <code>` | Language code | `en` |
| `--country <code>` | Country code | `us` |
| `--limit <n>` | Max results (single mode = total, file mode = per query) | none |
| `--concurrent <n>` | Max concurrent queries in file mode | `3` |
| `--output-file <path>` | Output CSV path | `data/generated/output.csv` |
| `--force-fallback` | Skip primary parser and use fallback module directly | `false` |

Examples:

```bash
node mapScraperX.js "coffee shops in london" --limit 30
node mapScraperX.js --queries-file query_example.txt --limit 10 --concurrent 5
node mapScraperX.js "dentistas en Madrid" --lang es --country es --force-fallback
```

## Output Files

- Tracked sample output: `data/samples/output.sample.csv`
- Runtime output directory: `data/generated/` (gitignored)
- Debug/verification artifacts: `artifacts/` (gitignored)

CSV schema:
`id,url_place,title,category,address,phoneNumber,completePhoneNumber,domain,url,coor,stars,reviews,source_query`

## Project Structure

```text
mapScraperX.js              CLI entrypoint
src/placesCrawlerV2.js      Primary scraping/parsing + CSV export
src/scraper-fallback.js     Fallback scraper path
tests/crawler.test.js       Node test suite
query_example.txt           Example input queries
data/samples/               Tracked sample output
data/generated/             Generated outputs (ignored)
```

## Testing

Run full test suite:
```bash
pnpm test
```

## Reliability Notes

- Primary flow parses Maps payload from the `tbm=map` endpoint.
- If blocked by consent/captcha/bot-detection style responses, fallback path is used.
- `--force-fallback` is available for manual control during debugging.

## License

MIT
