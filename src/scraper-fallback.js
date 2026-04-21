/**
 * @module scraper
 * @description Google Local Search scraper that extracts business listings
 * including title, address, phone, website, ratings, and category.
 */

async function getJSDOM() {
  const mod = await new Function('return import("jsdom")')();
  return mod.JSDOM;
}

async function parseHTML(html) {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(html, 'text/html');
  }
  const JSDOM = await getJSDOM();
  return new JSDOM(html).window.document;
}

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

async function extractContactInfoBulletproof(rawPayload) {
  let document = await parseHTML(rawPayload);
  const result = { address: null, phoneNumbers: [] };

  function getInfoUsingXPath(labelName) {
    const xpath = `//*[normalize-space(text())='${labelName}']`;
    const targetNode = document.evaluate(xpath, document, null, 9, null).singleNodeValue;
    if (!targetNode) return null;

    const parent = targetNode.parentElement;
    const grandparent = parent ? parent.parentElement : null;
    const greatGrandparent = grandparent ? grandparent.parentElement : null;

    function extractAndClean(element) {
      if (!element) return null;
      let text = element.innerText || element.textContent;
      if (text && text.includes(labelName)) {
        let cleanedText = text.replace(labelName, '').replace(/^[\s:,-]+/, '').trim();
        if (cleanedText.length > 0) return cleanedText;
      }
      return null;
    }

    let extractedValue = extractAndClean(grandparent) || extractAndClean(parent) || extractAndClean(greatGrandparent);
    return extractedValue;
  }

  result.address = getInfoUsingXPath('Address');
  const phoneRaw = getInfoUsingXPath('Phone');
  if (phoneRaw) {
    result.phoneNumbers = phoneRaw.split(/(?:\s{2,}|\u00A0{2,}|,|\||\/)/).map(num => num.trim()).filter(num => num.length > 0);
  }
  return result;
}

async function fetchExtraDetails(query, cid) {
  const url = `https://www.google.com/async/lcl_akp?q=${encodeURIComponent(query)}&async=ludocids:${cid},_fmt:prog`;
  const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' };
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error(`Failed to fetch extra details for CID ${cid}:`, error.message);
    return null;
  }
}

async function fetchit(url) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' };
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const htmlText = await response.text();
    const doc = await parseHTML(htmlText);
    const searchEl = doc.querySelector('#search');
    const items = searchEl ? searchEl.querySelectorAll('.VkpGBb') : null;
    if (!items) return []; 
    const scrapedData = [];
    items.forEach((item) => {
      const row = { title: 'N/A', cid: '', stars: 0, reviews: 0, category: '', address: '', completePhoneNumber: '', url: '' };
      const cidElement = item.querySelector('[data-cid]');
      if (cidElement) row.cid = cidElement.getAttribute('data-cid');
      const titleEl = item.querySelector('[role="heading"]');
      if (titleEl) row.title = titleEl.textContent.replace(/\s+/g, ' ').trim();
      const allLinks = Array.from(item.querySelectorAll('a'));
      const directionsLink = allLinks.find(a => a.getAttribute('href')?.startsWith('/maps/dir/'));
      if (directionsLink) {
        const href = directionsLink.getAttribute('href');
        try {
          const destSegment = href.split('/data=')[0].split('/').pop();
          if (destSegment) {
            let fullAddress = decodeURIComponent(destSegment).replace(/\+/g, ' ').trim();
            if (row.title && row.title !== 'N/A') {
              if (fullAddress.startsWith(row.title)) fullAddress = fullAddress.substring(row.title.length).replace(/^[, \-]+/, '').trim();
              else if (fullAddress.endsWith(row.title)) fullAddress = fullAddress.substring(0, fullAddress.length - row.title.length).replace(/[, \-]+$/, '').trim();
            }
            row.address = fullAddress;
          }
        } catch (e) {}
      }
      const websiteLink = allLinks.find(a => {
        const linkText = a.textContent.toLowerCase();
        const href = a.getAttribute('href') || '';
        return linkText.includes('website') && href.startsWith('http');
      });
      if (websiteLink) row.url = websiteLink.getAttribute('href');
      const detailsDiv = item.querySelector('.rllt__details');
      if (detailsDiv) {
        Array.from(detailsDiv.children).forEach(line => {
          if (line.getAttribute('role') === 'heading' || line.querySelector('[role="heading"]')) return;
          const text = line.textContent.replace(/\s+/g, ' ').trim();
          if (!text) return;
          if (line.querySelector('[role="img"]') || text.match(/^\d\.\d/)) {
            const starSpan = line.querySelector('.yi40Hd') || line.querySelector('[aria-hidden="true"]');
            if (starSpan) row.stars = parseFloat(starSpan.textContent) || 0;
            const reviewSpan = line.querySelector('[aria-label*="reviews"]') || line.querySelector('.RDApEe');
            if (reviewSpan) row.reviews = parseInt(reviewSpan.textContent.replace(/\D/g, '')) || 0;
            if (text.includes('·')) row.category = text.split('·').pop().trim();
            return;
          }
          if (text.includes('Opens') || text.includes('Closed') || text.includes('Open 24 hours') || text.includes('Dine-in') || text.includes('Takeout') || text.includes('Delivery') || line.classList.contains('pJ3Ci')) return;
          text.split('·').map(s => s.trim()).forEach(segment => {
            if (segment.includes('years in business')) return;
            const phone = extractPhone(segment);
            if (phone) row.completePhoneNumber = phone;
            else if (!/^[\d\s\-\+\(\)]{8,}$/.test(segment) && segment.length > 3 && !row.address) row.address = segment;
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

async function search(query, mode = 'normal', onProgress = null, resumeState = null) {
  let fullList = resumeState ? [...resumeState.partialResults] : [];
  let pagination = resumeState ? resumeState.pagination : 0;
  let pageNum = resumeState ? Math.floor(resumeState.pagination / 10) : 0;
  const startInEnrich = resumeState?.phase === 'enrich';
  let enrichStartIndex = resumeState?.enrichIndex ?? 0;

  if (!startInEnrich) {
    while (true) {
      pageNum++;
      if (onProgress) {
        const cont = onProgress({ phase: 'search', page: pageNum, found: fullList.length, message: `Searching page ${pageNum}...` });
        if (cont === false) {
          const uniqueResults = dedup(fullList);
          return { results: uniqueResults, resumeState: { query, mode, pagination, phase: 'search', enrichIndex: 0, partialResults: uniqueResults } };
        }
      }
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${pagination}&udm=1`;
      console.log(`[${mode}] Fetching Search Page: ${url}`);
      const result = await fetchit(url);
      if (result?.length > 0) {
        pagination += 10;
        fullList.push(...result);
      } else break;
    }
  }

  const uniqueResults = dedup(fullList);
  if (onProgress) onProgress({ phase: 'search-done', found: uniqueResults.length, message: `Found ${uniqueResults.length} leads` });
  if (mode === 'fast') return { results: uniqueResults, resumeState: null };
  const anyPhoneFound = uniqueResults.some(item => !!item.completePhoneNumber);
  if (mode === 'normal' && anyPhoneFound) return { results: uniqueResults, resumeState: null };

  const toEnrich = uniqueResults.filter(item => !!item.cid);
  let enriched = enrichStartIndex;
  for (let i = enrichStartIndex; i < uniqueResults.length; i++) {
    const item = uniqueResults[i];
    if (!item.cid) continue;
    enriched++;
    if (onProgress) {
      const cont = onProgress({ phase: 'enrich', current: enriched, total: toEnrich.length, message: `Enriching ${enriched}/${toEnrich.length} leads...` });
      if (cont === false) return { results: uniqueResults, resumeState: { query, mode, pagination, phase: 'enrich', enrichIndex: i, partialResults: uniqueResults } };
    }
    console.log(`[${mode}] Fetching details for "${item.title}" (CID: ${item.cid})...`);
    const rawPayload = await fetchExtraDetails(query, item.cid);
    if (!rawPayload) continue;
    try {
      const extraInfo = await extractContactInfoBulletproof(rawPayload);
      if (extraInfo.phoneNumbers?.length > 0) item.completePhoneNumber = extraInfo.phoneNumbers[0];
      if (mode === 'long' && extraInfo.address) item.address = extraInfo.address;
      else if (extraInfo.address && !item.address) item.address = extraInfo.address;
    } catch (err) { console.error(`Failed to parse extra info for CID ${item.cid}:`, err); }
  }
  return { results: uniqueResults, resumeState: null };
}

function dedup(list) {
  return Array.from(new Map(list.map(item => [item.cid || (item.title + item.address), item])).values());
}

const scraper = { extractPhone, extractContactInfoBulletproof, search };
export { extractPhone, extractContactInfoBulletproof, search };
export default scraper;
