/**
 * @module scraper
 * @description Google Local Search scraper that extracts business listings
 * including title, address, phone, website, ratings, and category.
 *
 * ## Search Modes
 *
 * | Mode     | Speed  | Data Completeness | Description                                      |
 * |----------|--------|-------------------|--------------------------------------------------|
 * | "fast"   | Fastest| Basic only        | Scrapes search pages only. Skips phone fallback.  |
 * | "normal" | Medium | Good              | Default. Fetches missing phones via CID lookup.   |
 * | "long"   | Slowest| Maximum           | Fetches extra details for ALL results (full       |
 * |          |        |                   | address, phone, hours, etc.)                      |
 *
 * ## Usage
 *
 * ```js
 * import { search } from './services/scraper.js';
 *
 * // Fast mode - quick results, may miss some phone numbers
 * const fast = await search('restaurants in Chennai', 'fast');
 *
 * // Normal mode (default) - fills in missing phones
 * const normal = await search('restaurants in Chennai');
 *
 * // Long mode - enriches every result with full details
 * const detailed = await search('restaurants in Chennai', 'long');
 * ```
 *
 * ## Return Shape
 *
 * Each item in the returned array:
 * ```
 * {
 *   title: string,
 *   cid: string,
 *   stars: number,
 *   reviews: number,
 *   category: string,
 *   address: string,
 *   completePhoneNumber: string,
 *   url: string
 * }
 * ```
 */

/**
 * Dynamically imports jsdom only in Node.js, hidden from Vite's static analysis.
 */
async function getJSDOM() {
  // Use indirect eval so Vite cannot statically resolve this import
  const mod = await new Function('return import("jsdom")')();
  return mod.JSDOM;
}

/**
 * Parses an HTML string into a Document, using native DOMParser in browser
 * or jsdom in Node.js.
 */
async function parseHTML(html) {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(html, 'text/html');
  }
  const JSDOM = await getJSDOM();
  return new JSDOM(html).window.document;
}

/**
 * Extracts a phone number (8+ digits) from a text string.
 * @param {string} text - Raw text that may contain a phone number.
 * @returns {string} The first valid phone number found, or empty string.
 */
function extractPhone(text) {
  if (!text) return '';

  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  const matches = text.match(phoneRegex);

  if (!matches) return '';

  for (const match of matches) {
    if (match.replace(/\D/g, '').length < 8) continue;
    return match.trim();
  }
  return '';
}

/**
 * Extracts contact info by feeding the raw, messy string directly to the DOM engine.
 * Safely strips unpredictable colons, spaces, and hyphens.
 * Works universally in both Browser and Node.js.
 * @param {string} rawPayload - The completely raw RPC/JSON/HTML string.
 * @returns {Promise<Object>} The extracted contact info.
 */
async function extractContactInfoBulletproof(rawPayload) {
  let document;

  document = await parseHTML(rawPayload);

  const result = {
    address: null,
    phoneNumbers: []
  };

  function getInfoUsingXPath(labelName) {
    // FIX 1: Changed //span to //* because Google uses <a> tags for these labels now
    const xpath = `//*[normalize-space(text())='${labelName}']`;
    
    // Replace XPathResult.FIRST_ORDERED_NODE_TYPE with 9
    const targetNode = document.evaluate(xpath, document, null, 9, null).singleNodeValue;
    if (!targetNode) return null;

    // Define the family tree (down parent, grandparent, up parent)
    const parent = targetNode.parentElement;
    const grandparent = parent ? parent.parentElement : null;
    const greatGrandparent = grandparent ? grandparent.parentElement : null;

    // Helper function to extract and clean the inner text
    function extractAndClean(element) {
      if (!element) return null;
      
      // Get the entire inner text
      let text = element.innerText || element.textContent;
      
      // Check if the text actually contains the label
      if (text && text.includes(labelName)) {
        // Remove the label name itself
        let cleanedText = text.replace(labelName, '');
        // Remove any leading colons, spaces, or hyphens
        cleanedText = cleanedText.replace(/^[\s:,-]+/, '').trim();
        
        // If we have a valid string left over, return it
        if (cleanedText.length > 0) {
          return cleanedText;
        }
      }
      return null;
    }

    // 2. Try the grandparent element first (Main Logic)
    let extractedValue = extractAndClean(grandparent);

    // 3. Test down parent if grandparent failed
    if (!extractedValue) {
      extractedValue = extractAndClean(parent);
    }

    // 4. Test up parent (great-grandparent) if both failed
    if (!extractedValue) {
      extractedValue = extractAndClean(greatGrandparent);
    }

    return extractedValue;
  }

  // Extract Address
  result.address = getInfoUsingXPath('Address');

  // Extract Phone Numbers
  const phoneRaw = getInfoUsingXPath('Phone');
  if (phoneRaw) {
    // FIX 2: Removed the single space from the regex so it doesn't split "093844 60454"
    const numbers = phoneRaw.split(/(?:\s{2,}|\u00A0{2,}|,|\||\/)/);
    result.phoneNumbers = numbers
      .map(num => num.trim())
      .filter(num => num.length > 0);
  }

  return result;
}

// Helper to fetch the raw messy payload from Google's async endpoint
async function fetchExtraDetails(query, cid) {
  const url = `https://www.google.com/async/lcl_akp?q=${encodeURIComponent(query)}&async=ludocids:${cid},_fmt:prog`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  };

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    console.error(`Failed to fetch extra details for CID ${cid}:`, error.message);
    return null;
  }
}

async function fetchit(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  };

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const htmlText = await response.text();
    const doc = await parseHTML(htmlText);

    const searchEl = doc.querySelector('#search');
    const items = searchEl ? searchEl.querySelectorAll('.VkpGBb') : null;
    if (!items) return []; 
    
    const scrapedData = [];

    items.forEach((item) => {
      const row = {
        title: 'N/A',
        cid: '', 
        stars: 0,
        reviews: 0,
        category: '',
        address: '',
        completePhoneNumber: '',
        url: ''
      };

      // --- 0. EXTRACT DATA-CID ---
      const cidElement = item.querySelector('[data-cid]');
      if (cidElement) {
        row.cid = cidElement.getAttribute('data-cid');
      }

      const titleEl = item.querySelector('[role="heading"]');
      if (titleEl) {
        row.title = titleEl.textContent.replace(/\s+/g, ' ').trim();
      }

      // --- 1. NEW STRATEGY: ADDRESS FROM DIRECTIONS URL ---
      const allLinks = Array.from(item.querySelectorAll('a'));
      const directionsLink = allLinks.find(a => a.getAttribute('href')?.startsWith('/maps/dir/'));
      
      if (directionsLink) {
        const href = directionsLink.getAttribute('href');
        try {
          const destSegment = href.split('/data=')[0].split('/').pop();
          if (destSegment) {
            let fullAddress = decodeURIComponent(destSegment).replace(/\+/g, ' ').trim();
            if (row.title && row.title !== 'N/A') {
              if (fullAddress.startsWith(row.title)) {
                fullAddress = fullAddress.substring(row.title.length).replace(/^[, \-]+/, '').trim();
              } else if (fullAddress.endsWith(row.title)) {
                fullAddress = fullAddress.substring(0, fullAddress.length - row.title.length).replace(/[, \-]+$/, '').trim();
              }
            }
            row.address = fullAddress;
          }
        } catch (e) {
          console.warn('Could not parse directions URL for address');
        }
      }

      // --- 2. WEBSITE EXTRACTION ---
      const websiteLink = allLinks.find(a => {
        const linkText = a.textContent.toLowerCase();
        const href = a.getAttribute('href') || '';
        return linkText.includes('website') && href.startsWith('http');
      });

      if (websiteLink) {
        row.url = websiteLink.getAttribute('href');
      }

      // --- 3. TEXT PARSING ---
      const detailsDiv = item.querySelector('.rllt__details');
      if (detailsDiv) {
        const lines = Array.from(detailsDiv.children); 
        
        lines.forEach(line => {
          if (line.getAttribute('role') === 'heading' || line.querySelector('[role="heading"]')) return;

          const text = line.textContent.replace(/\s+/g, ' ').trim();
          if (!text) return;

          if (line.querySelector('[role="img"]') || text.match(/^\d\.\d/)) {
            const starSpan = line.querySelector('.yi40Hd') || line.querySelector('[aria-hidden="true"]');
            if (starSpan) row.stars = parseFloat(starSpan.textContent) || 0;
            
            const reviewSpan = line.querySelector('[aria-label*="reviews"]') || line.querySelector('.RDApEe');
            if (reviewSpan) row.reviews = parseInt(reviewSpan.textContent.replace(/\D/g, '')) || 0;
            
            if (text.includes('·')) {
              row.category = text.split('·').pop().trim();
            }
            return;
          }

          const isStatusOrFeature = text.includes('Opens') || text.includes('Closed') || 
                                    text.includes('Open 24 hours') || text.includes('Dine-in') || 
                                    text.includes('Takeout') || text.includes('Delivery');
          const isQuote = line.classList.contains('pJ3Ci');
          if (isStatusOrFeature || isQuote) return;

          const segments = text.split('·').map(s => s.trim());
          segments.forEach(segment => {
            if (segment.includes('years in business')) return;

            const phone = extractPhone(segment);
            const looksLikePhone = /^[\d\s\-\+\(\)]{8,}$/.test(segment);

            if (phone) {
              row.completePhoneNumber = phone;
            } else if (!looksLikePhone && segment.length > 3 && !row.address) {
              row.address = segment;
            }
          });
        });
      }

      scrapedData.push(row);
    });
    
    return scrapedData;
  } catch (error) {
    console.error('Error fetching data:', error);
    return [];
  }
}

/**
 * Searches Google Local listings and returns structured business data.
 *
 * Supports **pause & resume**: when `onProgress` returns `false`, the search
 * stops immediately and returns a result object whose `resumeState` is non-null.
 * Pass that `resumeState` back as the fourth argument to continue where you
 * left off — it carries the pagination offset, already-collected results, and
 * enrichment progress so nothing is re-fetched.
 *
 * ### Return shape
 *
 * ```js
 * {
 *   results: Array<Object>,   // The business listings collected so far
 *   resumeState: {            // null when the search completed normally
 *     query: string,          // Original search query
 *     mode: string,           // Search mode that was active
 *     pagination: number,     // Google pagination offset to resume from
 *     phase: 'search' | 'enrich',  // Which phase was interrupted
 *     enrichIndex: number,    // (enrich phase) index of the next item to enrich
 *     partialResults: Array,  // Deduplicated results including any enriched so far
 *   } | null
 * }
 * ```
 *
 * ### Resume example
 *
 * ```js
 * // First run — user pauses mid-search
 * const first = await search('cafes in Mumbai', 'normal', progressCb);
 * // first.resumeState !== null  →  search was paused
 *
 * // Later — continue from where we left off
 * const second = await search('cafes in Mumbai', 'normal', progressCb, first.resumeState);
 * // second.resumeState === null  →  search completed
 * ```
 *
 * @param {string} query - The search query (e.g. "plumbers in Mumbai").
 * @param {"fast"|"normal"|"long"} [mode="normal"] - Controls speed vs completeness.
 * @param {Function|null} [onProgress=null] - Progress callback. Return `false` to pause.
 * @param {Object|null} [resumeState=null] - State object from a previous paused search.
 * @returns {Promise<{results: Array<Object>, resumeState: Object|null}>}
 */
async function search(query, mode = 'normal', onProgress = null, resumeState = null) {
  // --- Restore state from a previous paused run, or start fresh ---
  let fullList = resumeState ? [...resumeState.partialResults] : [];
  let pagination = resumeState ? resumeState.pagination : 0;
  let pageNum = resumeState ? Math.floor(resumeState.pagination / 10) : 0;
  const startInEnrich = resumeState?.phase === 'enrich';
  let enrichStartIndex = resumeState?.enrichIndex ?? 0;

  // Phase 1: Main Search Loop (skipped if resuming into enrich phase)
  if (!startInEnrich) {
    while (true) {
      pageNum++;
      if (onProgress) {
        const cont = onProgress({ phase: 'search', page: pageNum, found: fullList.length, message: `Searching page ${pageNum}...` });
        if (cont === false) {
          const uniqueResults = dedup(fullList);
          return {
            results: uniqueResults,
            resumeState: { query, mode, pagination, phase: 'search', enrichIndex: 0, partialResults: uniqueResults },
          };
        }
      }

      const url = new URL('https://www.google.com/search');
      url.search = new URLSearchParams({
        q: query,
        start: pagination,
        udm: '1',
      }).toString();
      console.log(`[${mode}] Fetching Search Page: ${url}`);

      const result = await fetchit(url.toString());
      if (result?.length > 0) {
        pagination += 10;
        fullList.push(...result);
      } else {
        break;
      }
    }
  }

  // Deduplicate before doing intensive sub-fetches
  const uniqueResults = dedup(fullList);

  if (onProgress) {
    onProgress({ phase: 'search-done', found: uniqueResults.length, message: `Found ${uniqueResults.length} leads` });
  }

  // Fast mode: return immediately with what we have
  if (mode === 'fast') {
    return { results: uniqueResults, resumeState: null };
  }

  // Normal mode: skip enrichment entirely if ANY result already has a phone number
  const anyPhoneFound = uniqueResults.some(item => !!item.completePhoneNumber);
  if (mode === 'normal' && anyPhoneFound) {
    console.log('[normal] Phone numbers found in search results, skipping enrichment.');
    return { results: uniqueResults, resumeState: null };
  }

  // Phase 2: Extra detail fetches via CID
  const toEnrich = uniqueResults.filter(item => !!item.cid);
  let enriched = enrichStartIndex;

  for (let i = enrichStartIndex; i < uniqueResults.length; i++) {
    const item = uniqueResults[i];
    if (!item.cid) continue;

    enriched++;
    if (onProgress) {
      const cont = onProgress({ phase: 'enrich', current: enriched, total: toEnrich.length, message: `Enriching ${enriched}/${toEnrich.length} leads...` });
      if (cont === false) {
        return {
          results: uniqueResults,
          resumeState: { query, mode, pagination, phase: 'enrich', enrichIndex: i, partialResults: uniqueResults },
        };
      }
    }

    console.log(`[${mode}] Fetching details for "${item.title}" (CID: ${item.cid})...`);

    const rawPayload = await fetchExtraDetails(query, item.cid);
    if (!rawPayload) continue;

    try {
      const extraInfo = await extractContactInfoBulletproof(rawPayload);

      if (extraInfo.phoneNumbers && extraInfo.phoneNumbers.length > 0) {
        item.completePhoneNumber = extraInfo.phoneNumbers[0];
      }

      if (mode === 'long' && extraInfo.address) {
        item.address = extraInfo.address;
      } else if (extraInfo.address && !item.address) {
        item.address = extraInfo.address;
      }
    } catch (err) {
      console.error(`Failed to parse extra info for CID ${item.cid}:`, err);
    }
  }

  return { results: uniqueResults, resumeState: null };
}

/** Deduplicates results by CID or title+address composite key. */
function dedup(list) {
  return Array.from(new Map(list.map(item => [item.cid || (item.title + item.address), item])).values());
}

module.exports = {
  extractPhone,
  extractContactInfoBulletproof,
  search
};
