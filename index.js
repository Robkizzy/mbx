// index.js    ← place this file in the ROOT of your repository

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────
//   CONFIGURATION – preferably use environment variables
// ────────────────────────────────────────────────
const WORKER_URLS = (process.env.WORKER_URLS || 'https://your-worker-1.example.dev')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

if (WORKER_URLS.length === 0) {
  console.warn('⚠️  No WORKER_URLS defined in environment → requests will fail');
}

let workerIdx = 0;
const nextWorker = () => {
  if (WORKER_URLS.length === 0) {
    throw new Error('No proxy workers available. Set WORKER_URLS env var.');
  }
  const url = WORKER_URLS[workerIdx];
  workerIdx = (workerIdx + 1) % WORKER_URLS.length;
  return url;
};

const nigerianIpPrefixes = [
  [197, 210], [105, 112], [102, 88], [41, 190], [41, 78],
  [102, 129], [197, 251], [41, 203], [45, 112], [102, 91],
  [41, 58], [105, 235], [102, 67], [197, 156], [41, 215],
  [102, 176], [197, 210], [41, 139], [102, 212], [105, 112]
];

const randomNigerianIp = () => {
  const [a, b] = nigerianIpPrefixes[Math.floor(Math.random() * nigerianIpPrefixes.length)];
  const c = Math.floor(Math.random() * 256);
  const d = Math.floor(Math.random() * 256);
  return `${a}.${b}.${c}.${d}`;
};

const TMDB_KEY = process.env.TMDB_API_KEY || '54e00466a09676df57ba51c4ca30b1a6';

const norm = t => (t || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\[\(].*?[\]\)]/g, '').replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const tmdbInfo = async (id, kind) => {
  try {
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/${kind}/${id}?api_key=${TMDB_KEY}`,
      {
        headers: { 'X-Forwarded-For': randomNigerianIp() },
        timeout: 10000,
      }
    );
    return kind === 'tv'
      ? { title: data.name, year: data.first_air_date?.slice(0, 4) ?? '' }
      : { title: data.title, year: data.release_date?.slice(0, 4) ?? '' };
  } catch (err) {
    throw new Error(`TMDB fetch failed: ${err.message}`);
  }
};

const search = async (keyword) => {
  const worker = nextWorker();
  const target = 'https://moviebox.ph/wefeed-h5-bff/web/subject/search';
  try {
    const { data } = await axios.post(
      `${worker}/?url=${encodeURIComponent(target)}`,
      { keyword, page: 1, perPage: 30, subjectType: 0 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': randomNigerianIp(),
        },
        timeout: 15000,
      }
    );
    return data;
  } catch (err) {
    throw new Error(`Search failed via proxy: ${err.message}`);
  }
};

const findMatch = (items, info, isTv) => {
  const n = norm(info.title);
  for (const item of (items || [])) {
    if (norm(item.title) !== n) continue;
    if (isTv ? item.subjectType !== 2 : item.subjectType !== 1) continue;
    const y = (item.releaseDate || item.lastReleaseDate || '').slice(0, 4);
    if (y && y === info.year) return item;
  }
  return null;
};

const resolve = async (tmdbId, kind) => {
  const info = await tmdbInfo(tmdbId, kind);
  if (!info.title || !info.year) {
    throw new Error('Invalid TMDB response – missing title or year');
  }

  const searchResult = await search(info.title);
  const match = findMatch(searchResult?.data?.items, info, kind === 'tv');

  if (!match?.subjectId || !match?.detailPath) {
    throw new Error(`No match found for "${info.title} (${info.year})"`);
  }

  const url = new URL(match.detailPath, 'https://123movienow.cc');
  return {
    subjectId: match.subjectId,
    detailPath: url.pathname,
  };
};

const buildVideoPlayPage = (detailPath, subjectId, kind, se = null, ep = null) => {
  const slug = detailPath.replace(/^\/(movies|tv)\//, '');
  const type = kind === 'movie' ? '/movie/detail' : '/tv/detail';
  let url = `https://123movienow.cc/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=${type}&lang=en`;
  if (se != null && ep != null) url += `&se=${se}&ep=${ep}`;
  return url;
};

const buildUrl = (endpoint, subjectId, detailPath, se = 0, ep = 0) => {
  return `https://123movienow.cc/wefeed-h5-bff/web/subject/${endpoint}?subjectId=${subjectId}&se=${se}&ep=${ep}&detail_path=${encodeURIComponent(detailPath)}`;
};

const extractStreamData = async (tmdbId, kind, se = 0, ep = 0) => {
  const { subjectId, detailPath } = await resolve(tmdbId, kind);
  const referer = buildVideoPlayPage(detailPath, subjectId, kind, se || null, ep || null);
  const worker = nextWorker();

  const fetchEndpoint = async (epName) => {
    const target = buildUrl(epName, subjectId, detailPath, se, ep);
    const proxyUrl = `${worker}/?url=${encodeURIComponent(target)}`;
    const { data } = await axios.get(proxyUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'X-Client-Info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'X-Forwarded-For': randomNigerianIp(),
      },
      timeout: 18000,
    });
    return data;
  };

  let result = null;
  let used = null;

  try {
    const dl = await fetchEndpoint('download');
    if (dl?.data?.hasResource === true) {
      result = dl;
      used = 'download';
    }
  } catch {}

  if (!result) {
    try {
      const pl = await fetchEndpoint('play');
      if (pl?.data?.hasResource === true) {
        result = pl;
        used = 'play';
      }
    } catch {}
  }

  if (!result || result.data?.hasResource !== true) {
    throw new Error('No usable stream found (both endpoints failed or no resource)');
  }

  console.log(`Success via /${used} → TMDB ${tmdbId} S${se}E${ep}`);
  return result;
};

// ────────────────────────────────────────────────
//                  ROUTES
// ────────────────────────────────────────────────

app.get('/movie/:id', async (req, res) => {
  try {
    const { subjectId, detailPath } = await resolve(req.params.id, 'movie');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'movie');
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/tv/:id', async (req, res) => {
  try {
    const { subjectId, detailPath } = await resolve(req.params.id, 'tv');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'tv');
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/tv/:id/:se/:ep', async (req, res) => {
  try {
    const { id, se, ep } = req.params;
    const { subjectId, detailPath } = await resolve(id, 'tv');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'tv', se, ep);
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/movie/:id/extract', async (req, res) => {
  try {
    const data = await extractStreamData(req.params.id, 'movie');
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message || 'Stream not available' });
  }
});

app.get('/tv/:id/:se/:ep/extract', async (req, res) => {
  try {
    const { id, se, ep } = req.params;
    const data = await extractStreamData(id, 'tv', Number(se), Number(ep));
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message || 'Stream not available' });
  }
});

app.get('/tv/:id/extract', (req, res) =>
  res.status(400).send('Use /tv/:tmdbId/:season/:episode/extract')
);

app.get('/health', (req, res) => res.json({
  status: 'ok',
  workers: WORKER_URLS.length,
  env: process.env.NODE_ENV || 'development'
}));

// ────────────────────────────────────────────────
//  Make it work EVERYWHERE
// ────────────────────────────────────────────────
module.exports = app;

// Only start server if file is run directly (Render, Cyclic, local, Railway, etc.)
// Vercel imports this file → skips listen()
if (require.main === module) {
  const port = process.env.PORT || 3016;
  app.listen(port, () => {
    console.log(`Loklok Smart Extractor running on port ${port}`);
    console.log(`Workers: ${WORKER_URLS.length || 'NONE (set WORKER_URLS env)'}`);
  });
}
