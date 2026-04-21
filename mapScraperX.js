#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as crawler from './src/placesCrawlerV2.js';

function readQueriesFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: Could not find the file ${filePath}`);
    } else {
      console.error(`Error reading the file ${filePath}: ${error.message}`);
    }
    return [];
  }
}

async function processSingleQuery(query, lang, country, limit, forceFallback = false) {
  console.log(`Processing query: '${query}'`);
  const results = await crawler.searchAsync(query, lang, country, limit, globalThis.fetch, forceFallback);
  console.log(`Found ${results.length} results for '${query}'`);
  return results;
}

async function processMultipleQueries(
  queries,
  lang,
  country,
  limitPerQuery,
  maxConcurrent = 3,
  forceFallback = false
) {
  const totalQueries = queries.length;
  console.log(`Processing ${totalQueries} queries concurrently (max ${maxConcurrent} at a time)...`);

  const started = Date.now();
  const results = await crawler.searchMultipleAsync(
    queries,
    lang,
    country,
    limitPerQuery,
    maxConcurrent,
    globalThis.fetch,
    forceFallback
  );

  const elapsed = (Date.now() - started) / 1000;
  console.log(`\nCompleted in ${elapsed.toFixed(2)} seconds`);
  console.log(`Average time per query: ${(elapsed / totalQueries).toFixed(2)} seconds`);
  return results;
}

async function main() {
  const program = new Command();

  program
    .name('mapScraperX.js')
    .description('Scrape Google Maps for local services with concurrent processing.')
    .argument('[query]', 'The search query.')
    .option('--queries-file <file>', 'Path to a text file containing one query per line.')
    .option('--lang <code>', 'Language code (e.g., en, es, fr).', 'en')
    .option('--country <code>', 'Country code (e.g., us, es, fr).', 'us')
    .option('--limit <number>', 'Max results (total for single query, per query for file mode)', (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error('--limit must be a positive integer');
      }
      return parsed;
    })
    .option('--output-file <path>', 'Output CSV file path.', 'data/generated/output.csv')
    .option('--concurrent <number>', 'Max concurrent queries (default: 3, recommended: 3-5)', (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error('--concurrent must be a positive integer');
      }
      return parsed;
    }, 3)
    .option('--force-fallback', 'Force fallback scraper for manual debugging and blocked-response diagnostics.', false)
    .addHelpText(
      'after',
      `\nExamples:\n  Single query:\n    node mapScraperX.js "restaurants in Miami" --limit 50\n\n  Multiple queries:\n    node mapScraperX.js --queries-file query_example.txt\n\n  Adjust concurrency level:\n    node mapScraperX.js --queries-file query_example.txt --concurrent 5\n`
    );

  program.parse(process.argv);
  const options = program.opts();
  const query = program.args[0];

  if ((query && options.queriesFile) || (!query && !options.queriesFile)) {
    console.error('Provide either a single query argument or --queries-file, but not both.');
    process.exit(1);
  }

  const outputDir = path.dirname(options.outputFile);
  if (outputDir && outputDir !== '.') {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let results = [];

  if (query) {
    console.log('Mode: Single query');
    if (options.forceFallback) {
      console.log('Force fallback enabled: skipping primary parser.');
    }
    results = await processSingleQuery(
      query,
      options.lang,
      options.country,
      options.limit,
      options.forceFallback
    );
  } else {
    console.log(`Mode: Multiple queries from file (${options.queriesFile})`);
    const queries = readQueriesFromFile(options.queriesFile);
    if (queries.length === 0) {
      console.error('No valid queries found in the file.');
      process.exit(1);
    }

    console.log(`Concurrent processing enabled: ${options.concurrent} queries at a time`);
    if (options.limit) {
      console.log(`Limit per query: ${options.limit}`);
    }
    if (options.forceFallback) {
      console.log('Force fallback enabled: all queries will use fallback scraper.');
    }

    results = await processMultipleQueries(
      queries,
      options.lang,
      options.country,
      options.limit,
      options.concurrent,
      options.forceFallback
    );
  }

  if (results.length > 0) {
    crawler.saveToCsv(results, options.outputFile);
    console.log(`\n${'='.repeat(50)}`);
    console.log('Final Summary:');
    console.log(`  Total results: ${results.length}`);
    console.log(`  File saved to: ${options.outputFile}`);
    console.log(`${'='.repeat(50)}`);
  } else {
    console.log('No results found.');
  }
}

main().catch((error) => {
  console.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});
