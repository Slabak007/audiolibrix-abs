const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const pLimit = require('p-limit').default;

// ---------------- 1. Helper Functions ----------------

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Normalizes and cleans image/resource URLs
 */
function cleanUrl(url) {
  if (!url) return undefined;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0];
}

/**
 * Converts various duration string formats into total minutes
 */
function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const str = durationStr.toLowerCase().trim();
  let totalMinutes = 0;

  const timeWithColonAndH = str.match(/(\d+):(\d+)\s*h/);
  if (timeWithColonAndH) {
    totalMinutes += parseInt(timeWithColonAndH[1]) * 60;
    totalMinutes += parseInt(timeWithColonAndH[2]);
    return totalMinutes;
  }

  const hMatch = str.match(/(\d+)\s*h/);
  const mMatch = str.match(/(\d+)\s*(m|min)/);
  if (hMatch || mMatch) {
    if (hMatch) totalMinutes += parseInt(hMatch[1]) * 60;
    if (mMatch) totalMinutes += parseInt(mMatch[1]);
    return totalMinutes;
  }

  if (str.includes(':')) {
    const parts = str.split(':');
    totalMinutes += parseInt(parts[0] || 0) * 60;
    totalMinutes += parseInt(parts[1] || 0);
    return totalMinutes;
  }
  return 0;
}

/**
 * Removes common prefixes from titles
 */
function cleanTitle(title) {
  if (!title) return "";
  return title
    .replace(/^(audiokniha|audioknihy|e-kniha|ekniha|e-book|ebook|kniha)/i, "")
    .replace(/^[\s\u00A0:;\|\-\–\—]*/, "")
    .trim();
}

// ---------------- 2. Shared Search Logic ----------------

async function advancedSearch(query, cachedLinks, bookUrlPrefix, metadataFetcher) {
  const romanMap = { 'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10' };
  let cleanQuery = query.replace(/\s*\(\d{4}\)\s*/g, " ").trim();
  const normalizedQuery = cleanQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let queryWords = normalizedQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 || /^[0-9ivx]+$/.test(w));

  const expandedWords = queryWords.map(word => {
    const variants = [word];
    if (romanMap[word]) variants.push(romanMap[word]);
    const romanVariant = Object.keys(romanMap).find(key => romanMap[key] === word);
    if (romanVariant) variants.push(romanVariant);
    return variants;
  });

  const searchedNumbers = expandedWords.flat().filter(w => /^[0-9]+$/.test(w) || Object.keys(romanMap).includes(w));

  let matches = cachedLinks
    .filter(url => {
      const urlLower = url.toLowerCase();
      return expandedWords.every(variants => variants.some(v => urlLower.includes(v)));
    })
    .map(url => {
      const urlLower = url.toLowerCase();
      let score = 0;
      const slug = urlLower.replace(bookUrlPrefix.toLowerCase(), "").replace(/\/$/, "");
      const slugParts = slug.split('-');
      const querySlugFormat = normalizedQuery.replace(/\s+/g, "-");

      if (slug === querySlugFormat) score += 2000;
      queryWords.forEach(qw => { if (slugParts.includes(qw)) score += 500; });
      const lastWordVariants = expandedWords[expandedWords.length - 1];
      if (lastWordVariants.some(v => urlLower.endsWith("-" + v))) score += 1000;

      const allPossibleNumbers = [...Object.keys(romanMap), ...Object.values(romanMap)];
      allPossibleNumbers.forEach(n => {
        if (urlLower.endsWith("-" + n) && !searchedNumbers.includes(n)) score -= 1500;
      });

      score -= Math.abs(slug.length - querySlugFormat.length);
      return { url, score };
    });

  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, 15);

  const limit = pLimit(5);
  return await Promise.all(topMatches.map(m => limit(() => metadataFetcher(m))));
}

// ---------------- 3. Audiolibrix Provider ----------------

class AudiolibrixProvider {
  constructor() {
    this.id = 'audiolibrix';
    this.name = 'Audiolibrix';
    this.sitemapUrl = 'https://www.audiolibrix.com/sitemap.0.xml';
    this.bookUrlPrefix = 'https://www.audiolibrix.com/cs/Directory/Book/';
    this.cachedLinks = [];
    this.isRefreshing = false;
  }

  async refreshSitemap() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const response = await axios.get(this.sitemapUrl, { timeout: 30000 });
      const $ = cheerio.load(response.data, { xmlMode: true });
      let links = [];
      $('loc').each((i, el) => {
        const url = cheerio.load(el).text();
        if (url.startsWith(this.bookUrlPrefix)) links.push(url);
      });
      this.cachedLinks = links;
      console.log(`[Audiolibrix] Sitemap indexed successfully: ${this.cachedLinks.length} books found.`);
    } catch (e) { 
      console.error('[Audiolibrix] Sitemap indexing failed:', e.message); 
    } finally { 
      this.isRefreshing = false; 
    }
  }

  async fetchMetadata(match) {
    try {
      const res = await axios.get(match.url, { timeout: 10000 });
      const $ = cheerio.load(res.data);

      const rawTitle = $('h1').first().text().trim();
      const title = cleanTitle(rawTitle);
      const coverUrl = $('.alx-audiobook-detail img').attr('src');
      
      const getList = (labels) => {
        let items = [];
        $('dt').each((i, el) => {
          if (labels.some(l => $(el).text().toLowerCase().includes(l.toLowerCase()))) {
            $(el).next('dd').find('a').each((j, a) => {
              const name = $(a).text().trim();
              if (name && !$(a).hasClass('alx-collapse-exit') && !name.includes('...')) {
                items.push(name);
              }
            });
          }
        });
        return [...new Set(items)];
      };

      // FIXED: Using .html() to keep tags in description
      let description = '';
      $('article.alx-card-clean, .card').each((i, el) => {
        const cardTitle = $(el).find('h2, .card-title').text().trim();
        if (/Anotace|Popis/i.test(cardTitle)) {
          description = $(el).find('.card-body, .alx-book-description').html() || '';
        }
      });
      if (!description) description = $('.alx-book-description').html() || '';

      const seriesArray = [];
      $('dt').each((i, el) => {
        if ($(el).text().toLowerCase().includes('série')) {
          const dd = $(el).next('dd');
          const fullText = dd.find('a span, a').first().text().trim();
          if (fullText) {
            const parts = fullText.split('#');
            seriesArray.push({ series: parts[0].trim(), sequence: parts[1] ? parts[1].trim() : "" });
          }
        }
      });

      const publisherEl = $('dt:contains("Vydavatel")').next('dd');
      const yearMatch = publisherEl.text().match(/\((\d{4})\)/);

      return {
        provider: this.name,
        title: title,
        subtitle: $('p.lead, .alx-book-subtitle, h1 + p').first().text().trim() || "",
        author: getList(['Autor', 'Autoři']).join(', '),
        narrator: getList(['Interpret', 'Interpreti']).join(', '),
        publisher: publisherEl.find('a').first().text().trim() || "",
        publishedYear: yearMatch ? yearMatch[1] : "",
        description: description.trim(),
        cover: cleanUrl(coverUrl),
        genres: getList(['Žánr', 'Žánry']),
        series: seriesArray,
        language: $('dt:contains("Jazyk")').next('dd').text().trim() || "Czech",
        tags: ["Audiolibrix"],
        duration: parseDuration($('dt:contains("Délka")').next('dd').text().trim()),
        url: match.url
      };
    } catch (err) { return null; }
  }
}

// ---------------- 4. Audioteka Provider ----------------

class AudiotekaProvider {
  constructor() {
    this.id = 'audioteka';
    this.name = 'Audioteka';
    this.indexSitemapUrl = 'https://audioteka.com/cz/sitemap/audiobooks.xml';
    this.bookUrlPrefix = 'https://audioteka.com/cz/audiokniha/';
    this.cachedLinks = [];
    this.isRefreshing = false;
  }

  async refreshSitemap() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const response = await axios.get(this.indexSitemapUrl, { timeout: 30000 });
      const $index = cheerio.load(response.data, { xmlMode: true });
      const sitemapUrls = [];
      $index('loc').each((i, el) => sitemapUrls.push(cheerio.load(el).text()));

      const allLinks = [];
      for (const url of sitemapUrls) {
        try {
          await delay(400); 
          const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const $sub = cheerio.load(res.data, { xmlMode: true });
          $sub('loc').each((i, el) => {
            const link = cheerio.load(el).text();
            if (link.includes('/audiokniha/')) allLinks.push(link);
          });
        } catch (e) { }
      }
      this.cachedLinks = [...new Set(allLinks)];
      console.log(`[Audioteka] Sitemap indexed successfully: ${this.cachedLinks.length} books found.`);
    } catch (err) { 
      console.error('[Audioteka] Indexing failed:', err.message); 
    } finally { 
      this.isRefreshing = false; 
    }
  }

async fetchMetadata(match) {
  try {
    const res = await axios.get(match.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = res.data;
    const $ = cheerio.load(html);

    // --- METADATA EXTRACTION LOGIC ---
    let publishedYear = "";
    
    // Pattern to find the internal audiobook data payload
    const detailMatch = html.match(/\\"audiobook\\":(?<payload>\{\\"name\\":.*?\})\s*,\\"currency\\":/);
    
    if (detailMatch && detailMatch.groups.payload) {
      try {
        // Decode escaped quotes to get a valid JSON string
        const cleanJsonString = detailMatch.groups.payload.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const audiobookData = JSON.parse(cleanJsonString);
        
        // Priority: External Release -> Digital Release -> System Creation
        const rawDate = audiobookData.external_published_at || 
                        audiobookData.published_at || 
                        audiobookData.created_at;
        
        if (rawDate) {
          const yearMatch = rawDate.match(/\d{4}/);
          if (yearMatch) publishedYear = yearMatch[0];
        }
      } catch (e) {
        console.error("Error parsing Audioteka JSON payload:", e.message);
      }
    }

    // Helper to get metadata from the definition list (labels in Czech, values to English-friendly structure)
    const getMetadata = (labels) => {
      let results = [];
      $('dt').each((i, el) => {
        const text = $(el).text().toLowerCase();
        if (labels.some(label => text.includes(label.toLowerCase()))) {
          const dd = $(el).next('dd');
          dd.find('li, a').each((_, item) => results.push($(item).text().trim()));
          if (results.length === 0) results.push(dd.text().trim());
        }
      });
      return [...new Set(results)].filter(Boolean);
    };

    let authors = [];
    $('a.product-top_author__BPJgI').each((i, el) => {
      authors.push($(el).text().trim());
    });
    // Fallback to table if author link is missing
    if (authors.length === 0) authors = getMetadata(['Autor']);

    const seriesRaw = getMetadata(['Série']);
    const seriesInfo = seriesRaw.map(s => {
      const parts = s.split(/\s+#/);
      return { 
        series: parts[0].trim(), 
        sequence: parts[1] ? parts[1].trim() : "" 
      };
    });

    const descriptionHtml = $('.description_description__6gcfq').html() || $('meta[name="description"]').attr('content');

    return {
      provider: this.name,
      title: cleanTitle($('h1').first().text()),
      subtitle: "",
      author: authors.join(', '),
      narrator: getMetadata(['Interpret', 'Účinkující']).join(', '),
      publisher: getMetadata(['Vydavatel'])[0] || "",
      publishedYear: publishedYear || getMetadata(['Rok vydání'])[0]?.match(/\d{4}/)?.[0] || "",
      description: descriptionHtml ? descriptionHtml.trim() : "",
      cover: cleanUrl($('meta[property="og:image"]').attr('content')),
      genres: getMetadata(['Kategorie', 'Žánr']),
      series: seriesInfo,
      language: getMetadata(['Jazyk'])[0] || "Czech",
      tags: ["Audioteka"],
      duration: parseDuration(getMetadata(['Délka'])[0]),
      url: match.url
    };
  } catch (err) { 
    return null; 
  }
}
}

// ---------------- 5. Express Server ----------------

const app = express();
const port = 3001;
const providers = [new AudiolibrixProvider(), new AudiotekaProvider()];

app.use(cors());

// Log every incoming request to the console
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use((req, res, next) => {
  if (!req.headers['authorization']) {
    return res.status(401).json({ error: 'Unauthorized: Missing authorization header' });
  }
  next();
});

async function refreshAllSitemaps() {
  console.log(`[${new Date().toISOString()}] Starting scheduled sitemap update...`);
  for (const p of providers) {
    await p.refreshSitemap();
  }
  console.log(`[${new Date().toISOString()}] Sitemap update completed.`);
}

app.get('/search', async (req, res) => {
  const query = req.query.query;
  const authorQuery = req.query.author; // Get author from the request query

  if (!query) return res.status(400).json({ error: 'Missing search query' });

  // 1. Logic for direct URLs remains the same
  if (query.startsWith('http')) {
    const provider = providers.find(p => query.includes(p.id));
    if (provider) {
      const metadata = await provider.fetchMetadata({ url: query });
      return res.json({ matches: metadata ? [metadata] : [] });
    }
    return res.json({ matches: [] });
  }

  // 2. Perform basic search across all providers
  const searchPromises = providers.map(p => 
    advancedSearch(query, p.cachedLinks, p.bookUrlPrefix, (m) => p.fetchMetadata(m))
  );

  const results = await Promise.all(searchPromises);
  let allMatches = results.flat().filter(Boolean);

  // 3. --- SORTING LOGIC BY AUTHOR ---
  if (authorQuery && allMatches.length > 0) {
    // Normalize target author (lowercase, remove diacritics)
    const normalizedTarget = authorQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    allMatches.sort((a, b) => {
      // Normalize authors in found metadata
      const authA = (a.author || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const authB = (b.author || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      // Check if the name in the data matches the query
      const matchA = authA.includes(normalizedTarget) || normalizedTarget.includes(authA);
      const matchB = authB.includes(normalizedTarget) || normalizedTarget.includes(authB);

      // If A matches the author and B does not, move A up (-1)
      if (matchA && !matchB) return -1;
      // If B matches the author and A does not, move B up (1)
      if (!matchA && matchB) return 1;

      // If both match or both don't match, keep original order from advancedSearch
      return 0;
    });
  }

  res.json({ matches: allMatches });
});

app.get('/lookup', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing URL parameter' });
  
  const provider = providers.find(p => url.includes(p.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found for the given URL' });
  
  const metadata = await provider.fetchMetadata({ url: url });
  if (!metadata) return res.status(404).json({ error: 'Metadata not found' });
  
  res.json(metadata);
});

app.listen(port, async () => {
  console.log(`Server successfully started and listening on port ${port}`);
  await refreshAllSitemaps();
  setInterval(async () => {
    await refreshAllSitemaps();
  }, 24 * 60 * 60 * 1000);
});
