const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  COLUMN_ORDER,
  extractPlace,
  mapFallbackResultsToSchema,
  saveToCsv,
  searchAsync,
  searchMultipleAsync,
  uniqueByPlaceId
} = require('../src/placesCrawlerV2');
const fallbackScraper = require('../src/scraper-fallback');

function makePlace({
  id,
  title,
  category = 'Category',
  address = 'Address',
  domain = 'example.com',
  url = 'https://example.com',
  stars = 4.8,
  lat = 40.1,
  lng = -74.1,
  phone = '(555) 000-0000',
  intl = '+1 555-000-0000'
}) {
  const row = [];
  row[78] = id;
  row[11] = title;
  row[13] = [category];
  row[39] = address;
  row[7] = [url, domain];
  row[4] = [];
  row[4][7] = stars;
  row[9] = [];
  row[9][2] = lat;
  row[9][3] = lng;
  row[178] = [[null, [[phone], [intl]]]];
  return row;
}

function wrapMapPayload(places) {
  const payload = [];
  payload[64] = places.map((place) => [null, place]);
  return `)]}'\n${JSON.stringify(payload)}`;
}

function createFetchStub(responses) {
  return async function fetchStub(url) {
    if (!(url in responses)) {
      return { ok: false, status: 404, text: async () => '' };
    }

    const value = responses[url];
    return {
      ok: true,
      status: 200,
      text: async () => (typeof value === 'function' ? value(url) : value)
    };
  };
}

test('extractPlace maps fields to python-compatible schema', () => {
  const result = extractPlace(makePlace({ id: 'ChIJ123', title: 'Alpha' }), 'my query');

  assert.equal(result.id, 'ChIJ123');
  assert.equal(result.title, 'Alpha');
  assert.equal(result.category, 'Category');
  assert.equal(result.address, 'Address');
  assert.equal(result.phoneNumber, '(555) 000-0000');
  assert.equal(result.completePhoneNumber, '+1 555-000-0000');
  assert.equal(result.domain, 'example.com');
  assert.equal(result.url, 'https://example.com');
  assert.equal(result.coor, '40.1,-74.1');
  assert.equal(result.stars, 4.8);
  assert.equal(result.reviews, '');
  assert.equal(result.source_query, 'my query');
});

test('searchAsync paginates and respects limit', async () => {
  const searchUrl =
    'https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=us&pb=abc';

  const fetchStub = createFetchStub({
    'https://www.google.com/maps/search/test%20query?hl=en&gl=us':
      '<html><head><link rel="canonical" href="/search?tbm=map&amp;authuser=0&amp;hl=en&amp;gl=us&amp;pb=abc"></head></html>',
    [searchUrl]: wrapMapPayload([
      makePlace({ id: 'ChIJ1', title: 'One' }),
      makePlace({ id: 'ChIJ2', title: 'Two' })
    ]),
    [`${searchUrl}&start=20`]: wrapMapPayload([
      makePlace({ id: 'ChIJ3', title: 'Three' }),
      makePlace({ id: 'ChIJ4', title: 'Four' })
    ]),
    [`${searchUrl}&start=40`]: wrapMapPayload([])
  });

  const rows = await searchAsync('test query', 'en', 'us', 3, fetchStub);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.title),
    ['One', 'Two', 'Three']
  );
});

test('searchMultipleAsync merges multiple queries', async () => {
  const fetchStub = createFetchStub({
    'https://www.google.com/maps/search/first?hl=en&gl=us':
      '<link href="/search?tbm=map&amp;pb=firstpb">',
    'https://www.google.com/search?tbm=map&pb=firstpb': wrapMapPayload([
      makePlace({ id: 'A1', title: 'A1' })
    ]),
    'https://www.google.com/search?tbm=map&pb=firstpb&start=20': wrapMapPayload([]),

    'https://www.google.com/maps/search/second?hl=en&gl=us':
      '<link href="/search?tbm=map&amp;pb=secondpb">',
    'https://www.google.com/search?tbm=map&pb=secondpb': wrapMapPayload([
      makePlace({ id: 'B1', title: 'B1' }),
      makePlace({ id: 'B2', title: 'B2' })
    ]),
    'https://www.google.com/search?tbm=map&pb=secondpb&start=20': wrapMapPayload([])
  });

  const rows = await searchMultipleAsync(['first', 'second'], 'en', 'us', undefined, 2, fetchStub);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.source_query === 'first').length, 1);
  assert.equal(rows.filter((row) => row.source_query === 'second').length, 2);
});

test('saveToCsv writes exact expected column order', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-'));
  const output = path.join(tmpDir, 'out.csv');

  saveToCsv(
    [
      {
        id: 'A',
        title: 'Quoted, Name',
        source_query: 'query',
        stars: 4.2
      }
    ],
    output
  );

  const raw = fs.readFileSync(output, 'utf8').trimEnd();
  const [header, line] = raw.split('\n');
  assert.equal(header, COLUMN_ORDER.join(','));
  assert.ok(line.includes('"Quoted, Name"'));
});

test('uniqueByPlaceId keeps first row per id', () => {
  const rows = [
    { id: 'A', title: 'first-a' },
    { id: 'B', title: 'first-b' },
    { id: 'A', title: 'second-a' },
    { id: '', title: 'empty-id' }
  ];
  const unique = uniqueByPlaceId(rows);
  assert.deepEqual(
    unique.map((row) => row.title),
    ['first-a', 'first-b']
  );
});

test('mapFallbackResultsToSchema maps fallback rows to output schema', () => {
  const mapped = mapFallbackResultsToSchema(
    [
      {
        cid: '12345',
        title: 'Fallback Place',
        category: 'Dentist',
        address: 'Madrid',
        completePhoneNumber: '+34 123',
        url: 'https://example.org/x',
        stars: 4.1,
        reviews: 99
      }
    ],
    'dentistas en madrid'
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, '12345');
  assert.equal(mapped[0].url_place, 'https://www.google.com/maps?cid=12345');
  assert.equal(mapped[0].domain, 'example.org');
  assert.equal(mapped[0].source_query, 'dentistas en madrid');
});

test('searchAsync falls back when pb URL cannot be extracted', async () => {
  const originalFallbackSearch = fallbackScraper.search;
  fallbackScraper.search = async () => ({
    results: [
      {
        cid: 'CID-1',
        title: 'Fallback Dentist',
        category: 'Dentist',
        address: 'Madrid',
        completePhoneNumber: '+34 111',
        url: 'https://clinic.example',
        stars: 4.7,
        reviews: 21
      }
    ]
  });

  try {
    const fetchStub = createFetchStub({
      'https://www.google.com/maps/search/dentistas%20en%20madrid?hl=es&gl=es':
        '<!doctype html><html><head><title>consent.google.com</title></head></html>'
    });

    const rows = await searchAsync('dentistas en madrid', 'es', 'es', 10, fetchStub);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Fallback Dentist');
    assert.equal(rows[0].id, 'CID-1');
  } finally {
    fallbackScraper.search = originalFallbackSearch;
  }
});

test('searchAsync forceFallback skips primary parser and uses fallback directly', async () => {
  const originalFallbackSearch = fallbackScraper.search;
  fallbackScraper.search = async () => ({
    results: [
      {
        cid: 'CID-FORCED',
        title: 'Forced Fallback',
        category: 'Dentist',
        address: 'Madrid',
        completePhoneNumber: '+34 999',
        url: 'https://forced.example',
        stars: 4.9,
        reviews: 12
      }
    ]
  });

  try {
    const fetchStub = async () => {
      throw new Error('primary fetch should not be called when forceFallback is true');
    };

    const rows = await searchAsync('dentistas en madrid', 'es', 'es', 10, fetchStub, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'CID-FORCED');
    assert.equal(rows[0].title, 'Forced Fallback');
  } finally {
    fallbackScraper.search = originalFallbackSearch;
  }
});
