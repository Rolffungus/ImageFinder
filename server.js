require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Config ───────────────────────────────────────────────────────────────────
const OPENAI_KEY            = process.env.OPENAI_KEY;
const PEXELS_KEY            = process.env.PEXELS_KEY;
const UNSPLASH_KEY          = process.env.UNSPLASH_KEY;
const SERP_KEY              = process.env.SERP_KEY;
const GOOGLE_CLIENT_ID      = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN  = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_ROOT_FOLDER_ID = process.env.GOOGLE_ROOT_FOLDER_ID;
const APP_SECRET            = process.env.APP_SECRET;

// ─── Pricing (USD) ────────────────────────────────────────────────────────────
const PRICE = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  'gpt-4o':      { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  'dalle3':      0.080,  // standard 1792×1024 per image
  'serp':        0.001   // per search call
};

function calcTokenCost(model, inputTokens, outputTokens) {
  const p = PRICE[model];
  return (inputTokens * p.input) + (outputTokens * p.output);
}

function freshCosts() {
  return {
    keyword_extraction: { model: 'gpt-4o-mini', input_tokens: 0, output_tokens: 0, usd: 0 },
    vision_scoring:     { model: 'gpt-4o', calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 },
    serp_api:           { calls: 0, usd: 0 },
    dalle3:             { calls: 0, usd: 0 },
    total_usd:          0
  };
}

// ─── Load quality guide (system prompt for all AI calls) ──────────────────────
const QUALITY_GUIDE = fs.readFileSync(path.join(__dirname, 'quality.md'), 'utf8');

// ─── Google Drive client ──────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'http://localhost:3000/oauth/callback'
);
oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Security middleware ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (APP_SECRET && req.headers['x-api-key'] !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Step 1: Deep keyword extraction ─────────────────────────────────────────
// Returns: topic, search_queries[3], serp_queries[3], dalle_prompt,
//          visual_theme, visual_style, main_entity, forbidden_brands, min_score
async function extractKeywords(postText, costs) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 700,
      messages: [
        { role: 'system', content: QUALITY_GUIDE },
        {
          role: 'user',
          content: `Analyze this LinkedIn post deeply to extract precise image search intelligence.

Post:
"""
${postText.substring(0, 1000)}
"""

Think step by step:
1. What is the post EXACTLY about? (specific company, product, concept?)
2. What visual would PERFECTLY illustrate this — be specific and creative
3. What Google Image searches would find real photos of this company/topic?
4. What should DALL-E generate if no real photo is good enough?

Respond ONLY in valid JSON (no markdown fences):
{
  "topic": "<3-word summary in snake_case>",
  "search_queries": [
    "<Pexels/Unsplash query: core visual concept + aesthetic, e.g. 'neural network glowing dark blue'>",
    "<Pexels/Unsplash query: broader visual concept, e.g. 'artificial intelligence technology abstract'>",
    "<Pexels/Unsplash query: metaphorical/creative, e.g. 'human robot collaboration future'>
  ],
  "serp_queries": [
    "<Google Images query: company name + specific context, e.g. 'Anthropic AI company Claude'>",
    "<Google Images query: company + product/office/team, e.g. 'Anthropic headquarters San Francisco'>",
    "<Google Images query: company + news/event, e.g. 'Anthropic AI safety research 2025'>"
  ],
  "dalle_prompt": "<Highly detailed DALL-E 3 prompt. Include: specific subject, lighting (cinematic, dramatic), color palette (brand colors if known), mood, composition. NO text, NO logos, NO watermarks, NO people. 16:9 aspect>",
  "visual_theme": "<one sentence: what a perfect image must visually convey>",
  "visual_style": "<company/topic brand aesthetic, e.g. 'Anthropic: warm coral and cream tones, minimalist, human-centered AI' or 'futuristic dark tech with cyan accents'>",
  "main_entity": "<specific company/product/person name, or null if general topic>",
  "forbidden_brands": ["<direct competitor names/products whose logos must NOT appear>"],
  "min_score": <7 for named company/product, 6 for general concept>
}`
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );

  const usage = response.data.usage;
  costs.keyword_extraction.input_tokens  += usage.prompt_tokens;
  costs.keyword_extraction.output_tokens += usage.completion_tokens;
  costs.keyword_extraction.usd = calcTokenCost('gpt-4o-mini',
    costs.keyword_extraction.input_tokens, costs.keyword_extraction.output_tokens);

  const content = response.data.choices[0].message.content.trim();
  const json = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(json);
}

// ─── Image sources ────────────────────────────────────────────────────────────

async function searchPexels(query) {
  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: PEXELS_KEY },
    params: { query, per_page: 8, orientation: 'landscape' }
  });
  return (res.data.photos || []).map(p => ({
    url: p.src.large2x, source: 'pexels', credit: p.photographer
  }));
}

async function searchUnsplash(query) {
  const res = await axios.get('https://api.unsplash.com/search/photos', {
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    params: { query, per_page: 8, orientation: 'landscape' }
  });
  return (res.data.results || []).map(p => ({
    url: p.urls.regular, source: 'unsplash', credit: p.user.name
  }));
}

async function searchSerpApi(query, costs) {
  const res = await axios.get('https://serpapi.com/search', {
    params: { engine: 'google_images', q: query, api_key: SERP_KEY, num: 8, safe: 'active' }
  });
  costs.serp_api.calls += 1;
  costs.serp_api.usd = costs.serp_api.calls * PRICE.serp;
  return (res.data.images_results || []).slice(0, 8).map(img => ({
    url: img.original, source: 'serp_google_images', credit: img.source
  }));
}

async function generateWithDalle(prompt, visualStyle, costs) {
  const styleHint = visualStyle
    ? ` Visual style: ${visualStyle}.`
    : ' Cinematic tech aesthetic, dark background with blue/cyan accent lights.';

  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt: prompt + styleHint + ' NO text, NO logos, NO watermarks, NO visible people, professional LinkedIn post image, 16:9 widescreen format.',
      n: 1, size: '1792x1024', quality: 'standard'
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );
  costs.dalle3.calls += 1;
  costs.dalle3.usd = costs.dalle3.calls * PRICE.dalle3;
  return {
    url: res.data.data[0].url,
    source: 'openai_dalle3',
    credit: 'AI Generated',
    score: 9,
    reason: 'Custom generated for exact topic and brand style'
  };
}

// ─── GPT-4o Vision: score ONE image ──────────────────────────────────────────
async function scoreImage(candidate, context) {
  const { visual_theme, visual_style, main_entity, forbidden_brands } = context;
  const forbiddenStr = (forbidden_brands && forbidden_brands.length)
    ? forbidden_brands.join(', ') : 'none';

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [
        { role: 'system', content: QUALITY_GUIDE },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Visually inspect this image. Score it for a LinkedIn post header.

Post theme: "${visual_theme}"
Expected visual style: "${visual_style || 'professional tech'}"
Main subject: ${main_entity || 'general technology'}
Forbidden brands/logos: ${forbiddenStr}

Score 1–10 (see rubric in your guide). Give extra credit (+1) if this is a real, recognizable photo OF the main company/product.
Respond ONLY in valid JSON:
{"score": <1-10>, "reason": "<one short sentence>", "has_forbidden_brand": <true|false>}`
            },
            { type: 'image_url', image_url: { url: candidate.url, detail: 'low' } }
          ]
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );

  const content = response.data.choices[0].message.content.trim();
  const json = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const result = JSON.parse(json);
  return {
    ...candidate,
    score: result.score,
    reason: result.reason,
    has_forbidden_brand: result.has_forbidden_brand,
    _usage: response.data.usage
  };
}

// ─── Score a batch IN PARALLEL, accumulate costs, return best above threshold ─
async function pickBestFromBatch(candidates, context, minScore, costs) {
  if (!candidates.length) return null;
  console.log(`      Scoring ${candidates.length} candidates in parallel with GPT-4o Vision...`);

  const results = await Promise.allSettled(candidates.map(c => scoreImage(c, context)));

  const scored = [];
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn(`      Vision error: ${r.reason?.message}`);
      continue;
    }
    const result = r.value;
    // Accumulate tokens
    if (result._usage) {
      costs.vision_scoring.calls       += 1;
      costs.vision_scoring.input_tokens  += result._usage.prompt_tokens;
      costs.vision_scoring.output_tokens += result._usage.completion_tokens;
      costs.vision_scoring.usd = calcTokenCost('gpt-4o',
        costs.vision_scoring.input_tokens, costs.vision_scoring.output_tokens);
    }
    const flag = result.has_forbidden_brand ? ' ✗ FORBIDDEN' : '';
    console.log(`      [${result.score}/10] ${result.source} — ${result.reason}${flag}`);
    if (!result.has_forbidden_brand) scored.push(result);
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score >= minScore) {
    console.log(`      ✓ Winner: ${best.score}/10 from ${best.source}`);
    return best;
  }
  console.log(`      Best was ${best.score} < threshold ${minScore}`);
  return null;
}

// ─── Collect candidates from all sources IN PARALLEL ─────────────────────────
async function fetchRound(pexelsQuery, unsplashQuery, serpQuery, costs) {
  const [pexels, unsplash, serp] = await Promise.all([
    pexelsQuery
      ? searchPexels(pexelsQuery).catch(e => { console.warn('Pexels:', e.message); return []; })
      : Promise.resolve([]),
    unsplashQuery
      ? searchUnsplash(unsplashQuery).catch(e => { console.warn('Unsplash:', e.message); return []; })
      : Promise.resolve([]),
    (serpQuery && SERP_KEY)
      ? searchSerpApi(serpQuery, costs).catch(e => { console.warn('SERP:', e.message); return []; })
      : Promise.resolve([])
  ]);

  // Interleave: SERP first (most specific), then Pexels/Unsplash
  const combined = [];
  const maxLen = Math.max(serp.length, pexels.length, unsplash.length);
  for (let i = 0; i < maxLen && combined.length < 15; i++) {
    if (serp[i])    combined.push(serp[i]);
    if (pexels[i])  combined.push(pexels[i]);
    if (unsplash[i]) combined.push(unsplash[i]);
  }
  return combined;
}

// ─── Download & resize to LinkedIn ideal 1200×628 ────────────────────────────
async function downloadImage(url, filepath) {
  const response = await axios({ url, responseType: 'arraybuffer', timeout: 30000 });
  await sharp(Buffer.from(response.data))
    .resize(1200, 628, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filepath);
}

// ─── Drive helpers ────────────────────────────────────────────────────────────
async function getOrCreateFolder(parentId, folderName) {
  const res = await drive.files.list({
    q: `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)'
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return folder.data.id;
}

async function uploadToDrive(filePath, fileName, topic) {
  const date = new Date().toISOString().split('T')[0];
  const folderName = `${date} \u2014 ${topic.replace(/\s+/g, '_').toLowerCase()}`;
  const folderId = await getOrCreateFolder(GOOGLE_ROOT_FOLDER_ID, folderName);
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) },
    fields: 'id, webViewLink'
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return { file_id: res.data.id, drive_link: res.data.webViewLink, folder: folderName };
}

// ─── Main endpoint ────────────────────────────────────────────────────────────
app.post('/api/find-image', async (req, res) => {
  const { linkedin_post } = req.body;
  if (!linkedin_post) {
    return res.status(400).json({ success: false, error: 'linkedin_post is required' });
  }

  let tempPath = null;
  const costs = freshCosts();

  try {
    // 1. Deep keyword extraction
    console.log('[1/4] Analyzing post...');
    const context = await extractKeywords(linkedin_post, costs);
    const { topic, search_queries, serp_queries, dalle_prompt, visual_style,
            main_entity, forbidden_brands, min_score } = context;
    const threshold = min_score || 7;
    console.log(`      topic="${topic}"  entity="${main_entity}"  threshold=${threshold}/10`);
    console.log(`      visual_style="${visual_style}"`);
    console.log(`      forbidden=${JSON.stringify(forbidden_brands)}`);
    console.log(`      stock_queries=${JSON.stringify(search_queries)}`);
    console.log(`      serp_queries=${JSON.stringify(serp_queries)}`);

    // 2. Round 1 — PARALLEL fetch from ALL sources simultaneously
    //    SERP runs from the start for named companies (real photos > generic stock)
    console.log('[2/4] Round 1: fetching from all sources in parallel...');
    let imageResult = null;

    const round1 = await fetchRound(
      search_queries[0],
      search_queries[0],
      serp_queries ? serp_queries[0] : null,
      costs
    );
    console.log(`      Round 1: ${round1.length} candidates`);
    if (round1.length) {
      imageResult = await pickBestFromBatch(round1, context, threshold, costs);
    }

    // Round 2 — broader queries, lower threshold
    if (!imageResult) {
      console.log('      Round 2: trying broader queries...');
      const round2 = await fetchRound(
        search_queries[1],
        search_queries[1],
        serp_queries ? serp_queries[1] : null,
        costs
      );
      console.log(`      Round 2: ${round2.length} candidates`);
      if (round2.length) {
        imageResult = await pickBestFromBatch(round2, context, threshold - 1, costs);
      }
    }

    // Round 3 — creative/abstract queries + second SERP angle, threshold -2
    if (!imageResult) {
      console.log('      Round 3: trying abstract/creative angle...');
      const round3 = await fetchRound(
        search_queries[2],
        search_queries[2],
        serp_queries ? serp_queries[2] : null,
        costs
      );
      console.log(`      Round 3: ${round3.length} candidates`);
      if (round3.length) {
        imageResult = await pickBestFromBatch(round3, context, threshold - 2, costs);
      }
    }

    // Last resort — DALL-E 3 generates a custom image using brand style
    if (!imageResult) {
      console.log('      All rounds exhausted — generating custom image with DALL-E 3...');
      imageResult = await generateWithDalle(dalle_prompt, visual_style, costs).catch(e => {
        console.warn('DALL-E 3 failed:', e.message);
        return null;
      });
      if (imageResult) console.log(`      ✓ DALL-E 3 generated`);
    }

    if (!imageResult) throw new Error('All image sources failed');

    // 3. Download + resize
    console.log('[3/4] Downloading and resizing...');
    const timestamp = Date.now();
    const filename = `${topic.replace(/\s+/g, '_')}_${timestamp}.jpg`;
    tempPath = path.join(os.tmpdir(), filename);
    await downloadImage(imageResult.url, tempPath);

    // 4. Upload to Drive
    console.log('[4/4] Uploading to Google Drive...');
    const { file_id, drive_link, folder } = await uploadToDrive(tempPath, filename, topic);
    console.log(`      ✓ Uploaded: ${drive_link}`);

    fs.unlinkSync(tempPath);
    tempPath = null;

    // Finalize costs
    costs.total_usd =
      costs.keyword_extraction.usd +
      costs.vision_scoring.usd +
      costs.serp_api.usd +
      costs.dalle3.usd;

    console.log(`\n💰 Cost summary:`);
    console.log(`   Keyword extraction (gpt-4o-mini): ${costs.keyword_extraction.input_tokens}in + ${costs.keyword_extraction.output_tokens}out → $${costs.keyword_extraction.usd.toFixed(6)}`);
    console.log(`   Vision scoring (gpt-4o): ${costs.vision_scoring.calls} images, ${costs.vision_scoring.input_tokens}in + ${costs.vision_scoring.output_tokens}out → $${costs.vision_scoring.usd.toFixed(6)}`);
    if (costs.serp_api.calls) console.log(`   SERP API: ${costs.serp_api.calls} call(s) → $${costs.serp_api.usd.toFixed(4)}`);
    if (costs.dalle3.calls)   console.log(`   DALL-E 3: ${costs.dalle3.calls} image(s) → $${costs.dalle3.usd.toFixed(4)}`);
    console.log(`   TOTAL: $${costs.total_usd.toFixed(6)}\n`);

    return res.json({
      success: true,
      file_id,
      drive_link,
      image_url: imageResult.url,
      source: imageResult.source,
      score: imageResult.score || null,
      score_reason: imageResult.reason || null,
      topic,
      main_entity: main_entity || null,
      visual_style: visual_style || null,
      folder,
      cost_breakdown: {
        keyword_extraction: {
          model:         costs.keyword_extraction.model,
          input_tokens:  costs.keyword_extraction.input_tokens,
          output_tokens: costs.keyword_extraction.output_tokens,
          usd:           +costs.keyword_extraction.usd.toFixed(6)
        },
        vision_scoring: {
          model:         costs.vision_scoring.model,
          images_scored: costs.vision_scoring.calls,
          input_tokens:  costs.vision_scoring.input_tokens,
          output_tokens: costs.vision_scoring.output_tokens,
          usd:           +costs.vision_scoring.usd.toFixed(6)
        },
        serp_api: { calls: costs.serp_api.calls, usd: +costs.serp_api.usd.toFixed(6) },
        dalle3:   { calls: costs.dalle3.calls,   usd: +costs.dalle3.usd.toFixed(6) },
        total_usd:     +costs.total_usd.toFixed(6),
        total_display: '$' + costs.total_usd.toFixed(4)
      }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 LinkedIn Image Finder running on http://localhost:${PORT}`);
  console.log(`   POST /api/find-image   — main endpoint`);
  console.log(`   GET  /health           — health check\n`);
});
