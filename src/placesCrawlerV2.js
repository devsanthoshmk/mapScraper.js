import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import fallbackScraper from './scraper-fallback.js';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  connection: 'keep-alive',
  'upgrade-insecure-requests': '1'
};

const COLUMN_ORDER = [
  'id',
  'url_place',
  'title',
  'category',
  'address',
  'phoneNumber',
  'completePhoneNumber',
  'domain',
  'url',
  'coor',
  'stars',
  'reviews',
  'source_query'
];

function safeGet(obj, ...indices) {
  let current = obj;
  for (const idx of indices) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[idx];
  }
  return current;
}

function csvEscape(value) {
  const stringValue = value === undefined || value === null ? '' : String(value);
  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  ) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function getDomainFromUrl(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname || '';
  } catch (_) {
    return '';
  }
}

function extractPlace(result, query) {
  const placeId = safeGet(result, 78);
  if (!placeId) {
    return null;
  }

  const output = {
    id: placeId,
    url_place: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
    title: safeGet(result, 11) ?? '',
    category: safeGet(result, 13, 0) ?? '',
    address: safeGet(result, 39) ?? '',
    phoneNumber: '',
    completePhoneNumber: '',
    domain: safeGet(result, 7, 1) ?? '',
    url: safeGet(result, 7, 0) ?? '',
    coor: '',
    stars: safeGet(result, 4, 7) ?? '',
    reviews: '',
    source_query: query
  };

  const phoneLocal = safeGet(result, 178, 0, 1, 0, 0);
  const phoneIntl = safeGet(result, 178, 0, 1, 1, 0);
  if (phoneLocal) output.phoneNumber = phoneLocal;
  if (phoneIntl) output.completePhoneNumber = phoneIntl;

  const lat = safeGet(result, 9, 2);
  const lng = safeGet(result, 9, 3);
  if (lat !== undefined && lat !== null && lng !== undefined && lng !== null) {
    output.coor = `${lat},${lng}`;
  }

  return output;
}

function uniqueByPlaceId(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    if (!row || !row.id || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    unique.push(row);
  }
  return unique;
}

function mapFallbackResultsToSchema(rows, query) {
  return rows.map((row) => {
    const id = row.cid || `${row.title || ''}|${row.address || ''}|${row.url || ''}`;
    const completePhoneNumber = row.completePhoneNumber || '';
    return {
      id,
      url_place: row.cid ? `https://www.google.com/maps?cid=${row.cid}` : '',
      title: row.title || '',
      category: row.category || '',
      address: row.address || '',
      phoneNumber: completePhoneNumber,
      completePhoneNumber,
      domain: getDomainFromUrl(row.url),
      url: row.url || '',
      coor: '',
      stars: row.stars ?? '',
      reviews: row.reviews ?? '',
      source_query: query
    };
  });
}

async function searchWithFallback(query, limit) {
  console.warn(`[${query}] Primary scraper failed or was blocked. Trying fallback scraper...`);
  try {
    const fallback = await fallbackScraper.search(query, 'normal');
    const mapped = mapFallbackResultsToSchema(fallback?.results || [], query);
    const unique = uniqueByPlaceId(mapped);
    return limit ? unique.slice(0, limit) : unique;
  } catch (error) {
    console.error(`[${query}] Fallback scraper failed: ${error.message}`);
    return [];
  }
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.text();
}

async function getSearchUrl(fetchImpl, query, lang, country) {
  const encoded = encodeURIComponent(query);
  const mapsUrl = `https://www.google.com/maps/search/${encoded}?hl=${lang}&gl=${country}`;

  let html;
  try {
    html = await fetchText(mapsUrl, fetchImpl);
  } catch (error) {
    console.error(`[${query}] Failed to fetch Maps page: ${error.message}`);
    return null;
  }

  const match = html.match(/href="(\/search\?tbm=map[^"]+)"/);
  if (!match) {
    console.error(
      `[${query}] Could not find pb= search URL in Maps page. HTML snippet: ${JSON.stringify(
        html.slice(0, 300)
      )}`
    );
    return null;
  }

  return `https://www.google.com${match[1].replaceAll('&amp;', '&')}`;
}

async function fetchResultsPage(fetchImpl, searchUrl, query, start = 0) {
  const url = start === 0 ? searchUrl : `${searchUrl}&start=${start}`;

  let raw;
  try {
    raw = await fetchText(url, fetchImpl);
  } catch (error) {
    console.error(`[${query}] Failed to fetch search results (start=${start}): ${error.message}`);
    return [];
  }

  if (raw.startsWith(")]}'")) {
    raw = raw.slice(4).trim();
  } else {
    console.error(
      `[${query}] Unexpected response format (missing )]}' prefix) at start=${start}.` +
        ` First 80 chars: ${JSON.stringify(raw.slice(0, 80))}`
    );
    return [];
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(`[${query}] JSON parse error at start=${start}: ${error.message}`);
    return [];
  }

  const resultsArray = safeGet(data, 64);
  if (!Array.isArray(resultsArray)) {
    return [];
  }

  const places = [];
  for (const entry of resultsArray) {
    if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
      continue;
    }
    const place = extractPlace(entry[1], query);
    if (place) {
      places.push(place);
    }
  }
  return places;
}

async function searchAsync(
  query,
  lang = 'en',
  country = 'us',
  limit = undefined,
  fetchImpl = globalThis.fetch,
  forceFallback = false
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable. Use Node 20+ or provide fetch implementation.');
  }
  if (forceFallback) {
    return searchWithFallback(query, limit);
  }

  const results = [];
  const searchUrl = await getSearchUrl(fetchImpl, query, lang, country);
  if (!searchUrl) {
    return searchWithFallback(query, limit);
  }

  const pageSize = 20;
  let start = 0;

  while (true) {
    const places = await fetchResultsPage(fetchImpl, searchUrl, query, start);
    if (places.length === 0) {
      if (start === 0) {
        return searchWithFallback(query, limit);
      }
      break;
    }

    for (const place of places) {
      results.push(place);
    }

    const unique = uniqueByPlaceId(results);
    if (limit && unique.length >= limit) {
      return unique.slice(0, limit);
    }

    start += pageSize;
  }

  return uniqueByPlaceId(results);
}

async function searchMultipleAsync(
  queries,
  lang = 'en',
  country = 'us',
  limit = undefined,
  maxConcurrent = 3,
  fetchImpl = globalThis.fetch,
  forceFallback = false
) {
  const limiter = pLimit(maxConcurrent);
  const chunks = await Promise.all(
    queries.map((query) =>
      limiter(() => searchAsync(query, lang, country, limit, fetchImpl, forceFallback))
    )
  );
  return uniqueByPlaceId(chunks.flat());
}

function saveToCsv(data, filename = 'data/generated/output.csv') {
  if (!Array.isArray(data) || data.length === 0) {
    console.log('No data to save.');
    return;
  }

  const dir = path.dirname(filename);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const normalized = data.map((record) => {
    const output = {};
    for (const column of COLUMN_ORDER) {
      output[column] = record[column] ?? '';
    }
    return output;
  });

  const lines = [
    COLUMN_ORDER.join(','),
    ...normalized.map((record) => COLUMN_ORDER.map((column) => csvEscape(record[column])).join(','))
  ];

  fs.writeFileSync(filename, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Data saved to ${filename}`);
}

export {
  COLUMN_ORDER,
  extractPlace,
  fetchResultsPage,
  getSearchUrl,
  mapFallbackResultsToSchema,
  saveToCsv,
  searchAsync,
  searchMultipleAsync,
  safeGet,
  uniqueByPlaceId
};
