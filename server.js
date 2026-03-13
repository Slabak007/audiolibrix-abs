const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const pLimit = require('p-limit').default;

// ---------------- Utility functions ----------------
function cleanCoverUrl(url) {
  if (url) return url.split('?')[0];
  return url;
}

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const match = durationStr.match(/(\d+):(\d+)/);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    return hours * 60 + minutes;
  }
  return 0;
}

// ---------------- Express setup ----------------
const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    console.log('Unauthorized request:', req.method, req.url);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('Authorized request:', req.method, req.url);
  next();
});

// ---------------- Audiolibrix Provider ----------------
class AudiolibrixProvider {
  constructor() {
    this.id = 'audiolibrix';
    this.name = 'Audiolibrix';
    this.baseUrl = 'https://www.audiolibrix.com';
    this.searchUrl = 'https://www.audiolibrix.com/cs/Search/Results';
  }

  async searchBooks(query) {
    console.log('Starting search for query:', query);
    try {
      const response = await axios.get(this.searchUrl, {
        params: { query },
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      console.log('Search page fetched, parsing results...');
      const $ = cheerio.load(response.data);
      const matches = [];

      $('.alx-audiobook-list-item').slice(0, 15).each((i, el) => {
        const $el = $(el);
        const title = $el.find('h2 a').attr('data-book-name');
        const url = this.baseUrl + $el.find('h2 a').attr('href');
        const cover = cleanCoverUrl($el.find('picture img').attr('src'));

        if (title && url) {
          matches.push({ title, url, cover });
          console.log(`Found book: ${title}`);
        }
      });

      console.log(`Found ${matches.length} matches, fetching full metadata...`);
      const limit = pLimit(5); // maximálně 5 současně
      const fullMetadata = await Promise.all(
        matches.map(m => limit(() => this.getFullMetadata(m)))
      );
      console.log('All metadata fetched');
      return fullMetadata;
    } catch (err) {
      console.error('Search error:', err.message);
      return [];
    }
  }

  async getFullMetadata(match) {
    console.log('Fetching metadata for:', match.title);
    try {
      const response = await axios.get(match.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = cheerio.load(response.data);

      // ---------------- Subtitle ----------------
      const subtitle = $('p.lead.mt-3').first().text().trim();

      // ---------------- Description ----------------
      let description = '';
      $('article.alx-card-clean').each((i, el) => {
        const header = $(el).find('h2.card-title').text().trim();
        if (header === 'Anotace') {
          description = $(el).find('div.card-body').html() || '';
          description = description.trim();
        }
      });

      // ---------------- Duration ----------------
      const durationStr = $('dt:contains("Délka")').next('dd').text().trim() || '';
      const duration = parseDuration(durationStr.replace(' h', ':00'));

      // ---------------- Publisher & Language ----------------
      let publisher = $('dt:contains("Vydavatel")').next('dd').find('a').first().text().trim();
      let publishedYear = '';
      const publisherText = $('dt:contains("Vydavatel")').next('dd').text();
      const yearMatch = publisherText.match(/\((\d{4})\)/);
      if (yearMatch) publishedYear = yearMatch[1];
      const language = $('dt:contains("Jazyk")').next('dd').text().trim();

      // ---------------- Genres ----------------
      let genres = [];
      $('dt').each((i, el) => {
        const text = $(el).text().trim();
        if (text === 'Žánr:' || text === 'Žánry:') {
          genres = $(el).next('dd').find('a')
            .map((i, el) => $(el).text().trim())
            .get()
            .filter(Boolean);
        }
      });

      // ---------------- Series ----------------
      const series = $('dt:contains("Série")').next('dd').find('a span')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);

      // ---------------- Authors ----------------
      let authors = [];
      $('dt').each((i, el) => {
        const text = $(el).text().trim();
        if (text === 'Autor:' || text === 'Autoři:') {
          authors = $(el).next('dd').find('a')
            .not('.d-block.small.alx-collapse-exit')
            .map((i, el) => $(el).text().trim())
            .get()
            .filter(Boolean);
        }
      });

      // ---------------- Narrators ----------------
      let narrators = [];
      $('dt').each((i, el) => {
        const text = $(el).text().trim();
        if (text === 'Interpret:' || text === 'Interpreti:') {
          narrators = $(el).next('dd').find('a')
            .not('.d-block.small.alx-collapse-exit')
            .map((i, el) => $(el).text().trim())
            .get()
            .filter(Boolean);
        }
      });

      console.log(`Metadata fetched for: ${match.title}`);
      return {
        title: match.title || '',
        subtitle: subtitle || '',
        author: authors,
        narrator: narrators,
        publisher: publisher || '',
        publishedYear: publishedYear || '',
        description: description || '',
        cover: match.cover || '',
        genres: genres,
        series: series,
        language: language || '',
        duration: duration || 0,
      };
    } catch (err) {
      console.error('Metadata fetch error for', match.title, err.message);
      return {
        title: match.title || '',
        subtitle: '',
        author: [],
        narrator: [],
        publisher: '',
        publishedYear: '',
        description: '',
        cover: match.cover || '',
        genres: [],
        series: [],
        language: '',
        duration: 0,
      };
    }
  }
}

// ---------------- Initialize provider ----------------
const provider = new AudiolibrixProvider();

// ---------------- Routes ----------------
app.get('/search', async (req, res) => {
  const query = req.query.query;
  if (!query) {
    console.log('Missing query parameter');
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  console.log('Received /search request for query:', query);
  const results = await provider.searchBooks(query);
  console.log('Returning', results.length, 'results');
  res.json({ matches: results });
});

// ---------------- Start server ----------------
app.listen(port, () => {
  console.log(`Audiolibrix provider running on port ${port}`);
});

