const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const pLimit = require('p-limit').default;

// ---------------- Pomocné funkce ----------------

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

// ---------------- Express Server ----------------

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// Middleware pro autorizaci (Header: Authorization)
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) return res.status(401).json({ error: 'Unauthorized - Chybí Authorization Header' });
  next();
});

// ---------------- Audiolibrix Provider ----------------

class AudiolibrixProvider {
  constructor() {
    this.id = 'audiolibrix';
    this.name = 'Audiolibrix';
    this.baseUrl = 'https://www.audiolibrix.com';
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
      const newLinks = [];
      $('loc').each((i, el) => {
        const url = $(el).text();
        if (url.startsWith(this.bookUrlPrefix)) newLinks.push(url);
      });
      if (newLinks.length > 0) {
        this.cachedLinks = newLinks;
        console.log(`[${new Date().toLocaleTimeString()}] Sitemapa aktualizována: ${this.cachedLinks.length} knih.`);
      }
    } catch (err) {
      console.error('Chyba sitemapy:', err.message);
      setTimeout(() => this.refreshSitemap(), 120000);
    } finally {
      this.isRefreshing = false;
    }
  }

  async searchBooks(query) {
    if (this.cachedLinks.length === 0) await this.refreshSitemap();

    const romanMap = { 'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10' };

    let cleanQuery = query.replace(/\s*\(\d{4}\)\s*/g, " ").trim();
    const normalizedQuery = cleanQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // OPRAVA: Ponecháváme slova od 2 znaků (najde "Akt") a číslice
    let queryWords = normalizedQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 || /^[0-9ivx]+$/.test(w));

    const expandedWords = queryWords.map(word => {
      const variants = [word];
      if (romanMap[word]) variants.push(romanMap[word]);
      const romanVariant = Object.keys(romanMap).find(key => romanMap[key] === word);
      if (romanVariant) variants.push(romanVariant);
      return variants;
    });

    const searchedNumbers = expandedWords.flat().filter(w => /^[0-9]+$/.test(w) || Object.keys(romanMap).includes(w));

    let matches = this.cachedLinks
      .filter(url => {
        const urlLower = url.toLowerCase();
        return expandedWords.every(variants => variants.some(v => urlLower.includes(v)));
      })
      .map(url => {
        const urlLower = url.toLowerCase();
        let score = 0;
        const slug = urlLower.replace(this.bookUrlPrefix.toLowerCase(), "");
        const slugParts = slug.split('-');

        // 1. MASIVNÍ BONUS pro přesnou shodu (hledám "Akt", slug je "akt")
        const querySlugFormat = normalizedQuery.replace(/\s+/g, "-");
        if (slug === querySlugFormat) score += 2000;

        // 2. BONUS pokud je slovo v URL jako samostatný dílek (odděleno pomlčkami)
        queryWords.forEach(qw => {
          if (slugParts.includes(qw)) score += 500;
        });

        // 3. LOGIKA PRO DÍLY SÉRIE (Husitská epopej 2)
        const lastWordVariants = expandedWords[expandedWords.length - 1];
        if (lastWordVariants.some(v => urlLower.endsWith("-" + v))) {
          score += 1000;
        }

        // 4. PENALIZACE pro jiná čísla (pokud v URL končí jiné číslo, než hledáme)
        const allPossibleNumbers = [...Object.keys(romanMap), ...Object.values(romanMap)];
        allPossibleNumbers.forEach(n => {
          if (urlLower.endsWith("-" + n) && !searchedNumbers.includes(n)) {
            score -= 1500; 
          }
        });

        score -= Math.abs(slug.length - querySlugFormat.length);
        return { url, score };
      });

    matches.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, 15);

    if (matches.length === 0) return [];

    const limit = pLimit(5);
    const results = await Promise.all(matches.map(m => limit(() => this.getFullMetadata(m))));
    return results.filter(Boolean);
  }

  async getFullMetadata(match) {
    try {
      const response = await axios.get(match.url, { 
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000 
      });
      const $ = cheerio.load(response.data);

      const rawTitle = $('h1').first().text().trim();
      const title = rawTitle.replace(/^(audiokniha|audioknihy|e-kniha|ekniha|e-book)\s*[:\-\|]*\s*/i, "").trim();
      const subtitle = $('p.lead, .alx-book-subtitle, h1 + p').first().text().trim() || "";

      let description = '';
      $('article.alx-card-clean, .card').each((i, el) => {
        const cardTitle = $(el).find('h2, .card-title').text().trim();
        if (/Anotace|Popis/i.test(cardTitle)) {
          description = $(el).find('.card-body, .alx-book-description').html() || '';
        }
      });
      if (!description) description = $('.alx-book-description').html() || '';
      description = description ? description.trim() : '';

      const getList = (labels) => {
        let items = [];
        $('dt').each((i, el) => {
          const text = $(el).text().trim();
          if (labels.some(l => text.toLowerCase().includes(l.toLowerCase()))) {
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

      let seriesArray = [];
      $('dt').each((i, el) => {
        if ($(el).text().toLowerCase().includes('série')) {
          const dd = $(el).next('dd');
          const fullText = dd.find('a span, a').first().text().trim();
          if (fullText) {
            const parts = fullText.split('#');
            seriesArray.push({
              series: parts[0].trim(),
              sequence: parts[1] ? parts[1].trim() : ""
            });
          }
        }
      });

      const publisherEl = $('dt:contains("Vydavatel")').next('dd');
      const yearMatch = publisherEl.text().match(/\((\d{4})\)/);
      const durationStr = $('dt:contains("Délka")').next('dd').text().trim().replace(' h', ':00');

      return {
        title: title,
        subtitle: subtitle,
        author: getList(['Autor', 'Autoři']).join(', '),
        narrator: getList(['Interpret', 'Interpreti']).join(', '),
        publisher: publisherEl.find('a').first().text().trim() || "",
        publishedYear: yearMatch ? yearMatch[1] : "",
        description: description,
        cover: cleanCoverUrl($('picture img').attr('src')) || "",
        isbn: "",
        asin: "",
        genres: getList(['Žánr', 'Žánry']),
        tags: [],
        series: seriesArray,
        language: $('dt:contains("Jazyk")').next('dd').text().trim() || "",
        duration: parseDuration(durationStr)
      };
    } catch (err) {
      return null;
    }
  }
}

// ---------------- Start ----------------

const provider = new AudiolibrixProvider();
provider.refreshSitemap();
setInterval(() => provider.refreshSitemap(), 24 * 60 * 60 * 1000);

app.get('/search', async (req, res) => {
  const query = req.query.query;
  if (!query) return res.status(400).json({ error: 'Chybí parametr query' });
  const results = await provider.searchBooks(query);
  res.json({ matches: results });
});

app.listen(port, () => {
  console.log(`Audiolibrix Provider běží na portu ${port}`);
});
