// index.js

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────
//          CONFIGURATION
// ────────────────────────────────────────────────

const TMDB_KEY = process.env.TMDB_API_KEY || '54e00466a09676df57ba51c4ca30b1a6';

const NIGERIAN_IP_PREFIXES = [
  [197, 210], [105, 112], [102, 88],  [41, 190],  [41, 78],
  [102, 129], [197, 251], [41, 203],  [45, 112], [102, 91],
  [41, 58],   [105, 235], [102, 67],  [197, 156],[41, 215],
  [102, 176], [197, 210], [41, 139],  [102, 212],[105, 112]
];

function randomNigerianIp() {
  const [a, b] = NIGERIAN_IP_PREFIXES[Math.floor(Math.random() * NIGERIAN_IP_PREFIXES.length)];
  const c = Math.floor(Math.random() * 256);
  const d = Math.floor(Math.random() * 256);
  return `${a}.${b}.${c}.${d}`;
}

const norm = title => (title || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[\[\(].*?[\]\)]/g, '')
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// ────────────────────────────────────────────────
//  TMDB fetch
// ────────────────────────────────────────────────

async function getTmdbInfo(id, kind) {
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
    throw new Error(`TMDB failed: ${err.message}`);
  }
}

// ────────────────────────────────────────────────
//  Search (direct)
// ────────────────────────────────────────────────

async function search(keyword) {
  const url = 'https://moviebox.ph/wefeed-h5-bff/web/subject/search';

  try {
    const { data } = await axios.post(url, {
      keyword,
      page: 1,
      perPage: 30,
      subjectType: 0
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': randomNigerianIp(),
        'Referer': 'https://123movienow.cc/',
        'Origin': 'https://123movienow.cc',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
        'X-Client-Info': JSON.stringify({ timezone: 'Africa/Lagos' })
      },
      timeout: 15000
    });

    return data;
  } catch (err) {
    console.error('[search] failed:', err.message, err?.response?.status);
    throw new Error(`Search request failed: ${err.message}`);
  }
}

function findBestMatch(items, info, isTv) {
  const normalizedTitle = norm(info.title);
  for (const item of (items || [])) {
    if (norm(item.title) !== normalizedTitle) continue;
    if (isTv ? item.subjectType !== 2 : item.subjectType !== 1) continue;
    const year = (item.releaseDate || item.lastReleaseDate || '').slice(0, 4);
    if (year && year === info.year) return item;
  }
  return null;
}

// ────────────────────────────────────────────────
//  Resolve title → subjectId + detailPath
// ────────────────────────────────────────────────

async function resolve(tmdbId, kind) {
  const info = await getTmdbInfo(tmdbId, kind);
  if (!info.title || !info.year) {
    throw new Error('Could not get title/year from TMDB');
  }

  const searchResult = await search(info.title);
  const match = findBestMatch(searchResult?.data?.items, info, kind === 'tv');

  if (!match?.subjectId || !match?.detailPath) {
    throw new Error(`No match found for "${info.title} (${info.year})"`);
  }

  const parsed = new URL(match.detailPath, 'https://123movienow.cc');
  return {
    subjectId: match.subjectId,
    detailPath: parsed.pathname
  };
}

// ────────────────────────────────────────────────
//  URL builders
// ────────────────────────────────────────────────

function buildVideoPlayPage(detailPath, subjectId, kind, season = null, episode = null) {
  const slug = detailPath.replace(/^\/(movies|tv)\//, '');
  const type = kind === 'movie' ? '/movie/detail' : '/tv/detail';
  let url = `https://123movienow.cc/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=${type}&lang=en`;
  if (season != null && episode != null) {
    url += `&se=${season}&ep=${episode}`;
  }
  return url;
}

function buildBackendUrl(endpoint, subjectId, detailPath, season = 0, episode = 0) {
  return `https://123movienow.cc/wefeed-h5-bff/web/subject/${endpoint}?` +
         `subjectId=${subjectId}&se=${season}&ep=${episode}&` +
         `detail_path=${encodeURIComponent(detailPath)}`;
}

// ────────────────────────────────────────────────
//  Extract stream (direct) - tries download → play
// ────────────────────────────────────────────────

async function extractStreamData(tmdbId, kind, season = 0, episode = 0) {
  const { subjectId, detailPath } = await resolve(tmdbId, kind);
  const referer = buildVideoPlayPage(detailPath, subjectId, kind, season || null, episode || null);

  const headers = {
    'Accept': 'application/json',
    'Referer': referer,
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    'X-Client-Info': JSON.stringify({ timezone: 'Africa/Lagos' }),
    'X-Forwarded-For': randomNigerianIp(),
    'Origin': 'https://123movienow.cc'
  };

  const fetchEndpoint = async (epName) => {
    const url = buildBackendUrl(epName, subjectId, detailPath, season, episode);
    const { data } = await axios.get(url, { headers, timeout: 18000 });
    return data;
  };

  let result = null;
  let usedEndpoint = null;

  // Try download first
  try {
    const dlData = await fetchEndpoint('download');
    if (dlData?.data?.hasResource === true) {
      result = dlData;
      usedEndpoint = 'download';
    }
  } catch (err) {
    console.log(`[download failed] ${tmdbId} S${season}E${episode}: ${err.message}`);
  }

  // Fallback to play
  if (!result) {
    try {
      const playData = await fetchEndpoint('play');
      if (playData?.data?.hasResource === true) {
        result = playData;
        usedEndpoint = 'play';
      }
    } catch (err) {
      console.log(`[play failed] ${tmdbId} S${season}E${episode}: ${err.message}`);
    }
  }

  if (!result || result.data?.hasResource !== true) {
    throw new Error('No usable stream found (both endpoints failed or hasResource=false)');
  }

  console.log(`Success via /${usedEndpoint} → TMDB ${tmdbId} S${season}E${episode}`);
  return result;
}

// ────────────────────────────────────────────────
//                  ROUTES
// ────────────────────────────────────────────────

app.get('/movie/:id', async (req, res) => {
  try {
    const { subjectId, detailPath } = await resolve(req.params.id, 'movie');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'movie');
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/tv/:id', async (req, res) => {
  try {
    const { subjectId, detailPath } = await resolve(req.params.id, 'tv');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'tv');
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/tv/:id/:se/:ep', async (req, res) => {
  try {
    const { id, se, ep } = req.params;
    const { subjectId, detailPath } = await resolve(id, 'tv');
    const vpp = buildVideoPlayPage(detailPath, subjectId, 'tv', se, ep);
    res.json({ detailPath, videoPlayPage: vpp });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/movie/:id/extract', async (req, res) => {
  try {
    const data = await extractStreamData(req.params.id, 'movie');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message || 'Stream not currently available' });
  }
});

app.get('/tv/:id/:se/:ep/extract', async (req, res) => {
  try {
    const { id, se, ep } = req.params;
    const data = await extractStreamData(id, 'tv', Number(se), Number(ep));
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message || 'Stream not currently available' });
  }
});

app.get('/tv/:id/extract', (req, res) => {
  res.status(400).send('Use /tv/:tmdbId/:season/:episode/extract');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tmdb_key_set: !!TMDB_KEY,
    timestamp: new Date().toISOString()
  });
});

// ────────────────────────────────────────────────
//  Server start logic (works on Vercel / Render / Cyclic / local / etc.)
// ────────────────────────────────────────────────

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3016;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`TMDB key: ${TMDB_KEY ? 'set' : 'missing (fallback used)'}`);
  });
}
