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

// ─── Pricing (USD per token, as of 2026) ──────────────────────────────────────
const PRICE = {
  'gpt-4o-mini': { input: 0.15  / 1_000_000, output: 0.60  / 1_000_000 },
  'gpt-4o':      { input: 2.50  / 1_000_000, output: 10.00 / 1_000_000 },
  'dalle3':      0.080,   // standard 1792×1024 per image
  'serp':        0.001    // per search call
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
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/oauth/callback'
);
oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ─── Health check (no auth required) ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Security middleware ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (APP_SECRET && req.headers['x-api-key'] !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Step 1: Deep keyword extraction ─────────────────────────────────────────
async function extractKeywords(postText, costs) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: QUALITY_GUIDE },
        {
          role: 'user',
          content: `Analyze this LinkedIn post and extract image search intelligence.

Post:
"""
${postText.substring(0, 800)}
"""

Respond ONLY in valid JSON (no markdown fences):
{
  "topic": "<3-word summary in snake_case>",
  "search_queries": [
    "<specific: main entity + core visual concept>",
    "<broader: core concept without entity name>",
    "<abstract: visual metaphor for the feeling/theme>"
  ],
  "dalle_prompt": "<detailed DALL-E 3 prompt — cinematic tech style, dark background, blue/cyan accent light, no people, NO text, NO logos, NO watermarks, 16:9>",
  "visual_theme": "<one sentence: what a perfect image should visually convey>",
  "main_entity": "<primary company/person/technology this post is about, or null>",
  "forbidden_brands": ["<competitor brand names/logos that must NOT appear>"],
  "min_score": <7 if post is about a specific named company, 6 if general tech>
}`
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );

  // Track tokens
  const usage = response.data.usage;
  costs.keyword_extraction.input_tokens  += usage.prompt_tokens;
  costs.keyword_extraction.output_tokens += usage.completion_tokens;
  costs.keyword_extraction.usd = calcTokenCost('gpt-4o-mini',
    costs.keyword_extraction.input_tokens,
    costs.keyword_extraction.output_tokens
  );

  const content = response.data.choices[0].message.content.trim();
  const json = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(json);
}

// ─── Step 2a: Pexels ──────────────────────────────────────────────────────────
async function searchPexels(query) {
  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: PEXELS_KEY },
    params: { query, per_page: 8, orientation: 'landscape' }
  });
  return (res.data.photos || []).map(p => ({
    url: p.src.large2x,
    source: 'pexels',
    credit: p.photographer
  }));
}

// ─── Step 2b: Unsplash ────────────────────────────────────────────────────────
async function searchUnsplash(query) {
  const res = await axios.get('https://api.unsplash.com/search/photos', {
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    params: { query, per_page: 8, orientation: 'landscape' }
  });
  return (res.data.results || []).map(p => ({
    url: p.urls.regular,
    source: 'unsplash',
    credit: p.user.name
  }));
}

// ─── Step 2c: SERP API ────────────────────────────────────────────────────────
async function searchSerpApi(query, costs) {
  const res = await axios.get('https://serpapi.com/search', {
    params: { engine: 'google_images', q: query, api_key: SERP_KEY, num: 5, safe: 'active' }
  });
  costs.serp_api.calls += 1;
  costs.serp_api.usd = costs.serp_api.calls * PRICE.serp;
  return (res.data.images_results || []).slice(0, 5).map(img => ({
    url: img.original,
    source: 'serp_google_images',
    credit: img.source
  }));
}

// ─── Step 2d: DALL-E 3 ────────────────────────────────────────────────────────
async function generateWithDalle(prompt, costs) {
  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt: prompt + '. Cinematic tech aesthetic, dark background with blue/cyan accent lights, NO text, NO logos, NO watermarks, NO people, professional LinkedIn post image, 16:9.',
      n: 1,
      size: '1792x1024',
      quality: 'standard'
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
    reason: 'Custom generated to exactly match post topic'
  };
}

// ─── Step 3: GPT-4o Vision — visually inspect and score one candidate ─────────
async function scoreImage(candidate, context, costs) {
  const { visual_theme, main_entity, forbidden_brands } = context;
  const forbiddenStr = (forbidden_brands && forbidden_brands.length)
    ? forbidden_brands.join(', ')
    : 'none';

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
              text: `Visually inspect this image and score it for use as a LinkedIn post header.

Post theme: "${visual_theme}"
Main subject: ${main_entity || 'general technology'}
Forbidden brands/logos that must NOT appear: ${forbiddenStr}

Use the scoring rubric from your quality guide (1–10).
Respond ONLY in valid JSON (no markdown):
{"score": <number 1-10>, "reason": "<one short sentence>", "has_forbidden_brand": <true or false>}`
            },
            { type: 'image_url', image_url: { url: candidate.url, detail: 'low' } }
          ]
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );

  // Track tokens
  const usage = response.data.usage;
  costs.vision_scoring.calls       += 1;
  costs.vision_scoring.input_tokens  += usage.prompt_tokens;
  costs.vision_scoring.output_tokens += usage.completion_tokens;
  costs.vision_scoring.usd = calcTokenCost('gpt-4o',
    costs.vision_scoring.input_tokens,
    costs.vision_scoring.output_tokens
  );

  const content = response.data.choices[0].message.content.trim();
  const json = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const result = JSON.parse(json);
  return { ...candidate, score: result.score, reason: result.reason, has_forbidden_brand: result.has_forbidden_brand };
}

// ─── Step 4: Score a batch and return the best above threshold ────────────────
async function pickBestFromBatch(candidates, context, minScore, costs) {
  const scored = [];
  console.log(`      Inspecting ${candidates.length} candidates with GPT-4o Vision...`);

  for (const candidate of candidates) {
    try {
      const result = await scoreImage(candidate, context, costs);
      const flag = result.has_forbidden_brand ? ' ✗ FORBIDDEN BRAND' : '';
      console.log(`      [${result.score}/10] ${result.source} — ${result.reason}${flag}`);
      if (!result.has_forbidden_brand) scored.push(result);
    } catch (e) {
      console.warn(`      Vision scoring error: ${e.message}`);
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score >= minScore) {
    console.log(`      ✓ Winner: score ${best.score}/10 from ${best.source}`);
    return best;
  }
  console.log(`      Best score ${best.score} < threshold ${minScore}, continuing...`);
  return null;
}

// ─── Step 5: Download & resize to LinkedIn ideal 1200×628 ────────────────────
async function downloadImage(url, filepath) {
  const response = await axios({ url, responseType: 'arraybuffer', timeout: 30000 });
  await sharp(Buffer.from(response.data))
    .resize(1200, 628, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filepath);
}

// ─── Step 6a: Get or create Drive folder ─────────────────────────────────────
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

// ─── Step 6b: Upload to Drive and make public ─────────────────────────────────
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
    console.log('[1/4] Analyzing post with quality guide...');
    const context = await extractKeywords(linkedin_post, costs);
    const { topic, search_queries, dalle_prompt, main_entity, forbidden_brands, min_score } = context;
    const threshold = min_score || 7;
    console.log(`      topic="${topic}"  entity="${main_entity}"  threshold=${threshold}/10`);
    console.log(`      forbidden=${JSON.stringify(forbidden_brands)}`);
    console.log(`      queries=${JSON.stringify(search_queries)}`);

    // 2. Collect candidates from free sources (query[0] = most specific)
    console.log('[2/4] Fetching candidates from free sources...');
    let imageResult = null;

    const [pexels0, unsplash0] = await Promise.all([
      searchPexels(search_queries[0]).catch(e => { console.warn('Pexels q0 failed:', e.message); return []; }),
      searchUnsplash(search_queries[0]).catch(e => { console.warn('Unsplash q0 failed:', e.message); return []; })
    ]);

    // Interleave for diversity, cap at 10
    const freeCandidates = [];
    const maxLen = Math.max(pexels0.length, unsplash0.length);
    for (let i = 0; i < maxLen && freeCandidates.length < 10; i++) {
      if (pexels0[i]) freeCandidates.push(pexels0[i]);
      if (unsplash0[i]) freeCandidates.push(unsplash0[i]);
    }

    if (freeCandidates.length > 0) {
      imageResult = await pickBestFromBatch(freeCandidates, context, threshold, costs);
    }

    // Retry with broader query[1] if no winner
    if (!imageResult && search_queries[1]) {
      console.log('      No winner — retrying with broader query...');
      const [pexels1, unsplash1] = await Promise.all([
        searchPexels(search_queries[1]).catch(() => []),
        searchUnsplash(search_queries[1]).catch(() => [])
      ]);
      const broader = [];
      const bLen = Math.max(pexels1.length, unsplash1.length);
      for (let i = 0; i < bLen && broader.length < 8; i++) {
        if (pexels1[i]) broader.push(pexels1[i]);
        if (unsplash1[i]) broader.push(unsplash1[i]);
      }
      if (broader.length > 0) {
        imageResult = await pickBestFromBatch(broader, context, threshold - 1, costs);
      }
    }

    // SERP fallback (~$0.001/call)
    if (!imageResult && SERP_KEY) {
      console.log('      Trying SERP API...');
      const serpCandidates = await searchSerpApi(search_queries[1] || search_queries[0], costs)
        .catch(e => { console.warn('SERP failed:', e.message); return []; });
      if (serpCandidates.length > 0) {
        imageResult = await pickBestFromBatch(serpCandidates, context, threshold - 1, costs);
      }
    }

    // DALL-E 3 last resort (~$0.08/image at 1792×1024)
    if (!imageResult) {
      console.log('      All sources exhausted — generating with DALL-E 3 (~$0.08)...');
      imageResult = await generateWithDalle(dalle_prompt, costs).catch(e => {
        console.warn('DALL-E 3 failed:', e.message);
        return null;
      });
      if (imageResult) console.log('      ✓ Generated with DALL-E 3');
    }

    if (!imageResult) throw new Error('All image sources failed');

    // 3. Download + resize
    console.log('[3/4] Downloading and resizing...');
    const timestamp = Date.now();
    const filename = `${topic.replace(/\s+/g, '_')}_${timestamp}.jpg`;
    tempPath = path.join(os.tmpdir(), filename);
    await downloadImage(imageResult.url, tempPath);

    // 4. Upload to Google Drive
    console.log('[4/4] Uploading to Google Drive...');
    const { file_id, drive_link, folder } = await uploadToDrive(tempPath, filename, topic);
    console.log(`      ✓ Uploaded: ${drive_link}`);

    fs.unlinkSync(tempPath);
    tempPath = null;

    // Compute grand total
    costs.total_usd = (
      costs.keyword_extraction.usd +
      costs.vision_scoring.usd +
      costs.serp_api.usd +
      costs.dalle3.usd
    );

    // Log cost summary
    console.log(`\n💰 Cost breakdown:`);
    console.log(`   Keyword extraction (gpt-4o-mini): ${costs.keyword_extraction.input_tokens} in + ${costs.keyword_extraction.output_tokens} out → $${costs.keyword_extraction.usd.toFixed(6)}`);
    console.log(`   Vision scoring (gpt-4o): ${costs.vision_scoring.calls} images, ${costs.vision_scoring.input_tokens} in + ${costs.vision_scoring.output_tokens} out → $${costs.vision_scoring.usd.toFixed(6)}`);
    if (costs.serp_api.calls) console.log(`   SERP API: ${costs.serp_api.calls} call(s) → $${costs.serp_api.usd.toFixed(4)}`);
    if (costs.dalle3.calls)   console.log(`   DALL-E 3: ${costs.dalle3.calls} image(s) → $${costs.dalle3.usd.toFixed(4)}`);
    console.log(`   ─────────────────────────────────────────`);
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
        serp_api: {
          calls: costs.serp_api.calls,
          usd:   +costs.serp_api.usd.toFixed(6)
        },
        dalle3: {
          calls: costs.dalle3.calls,
          usd:   +costs.dalle3.usd.toFixed(6)
        },
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
