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
const OPENAI_KEY           = process.env.OPENAI_KEY;
const PEXELS_KEY           = process.env.PEXELS_KEY;
const UNSPLASH_KEY         = process.env.UNSPLASH_KEY;
const SERP_KEY             = process.env.SERP_KEY;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_ROOT_FOLDER_ID = process.env.GOOGLE_ROOT_FOLDER_ID;
const APP_SECRET           = process.env.APP_SECRET;

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

// ─── Security middleware (applied to all routes below) ───────────────────────
app.use((req, res, next) => {
  if (APP_SECRET && req.headers['x-api-key'] !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Step 1: Keyword extraction (GPT-4o-mini — ~$0.0001/call) ────────────────
async function extractKeywords(postText) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `Extract from this LinkedIn post:
1. topic: 3-word topic summary (snake_case)
2. search_query: best image search query for a tech/futuristic photo matching this post
3. dalle_prompt: a DALL-E image generation prompt (tech/futuristic style, no text in image, professional LinkedIn)

Post: "${postText.substring(0, 500)}"

Respond ONLY in JSON: { "topic": "...", "search_query": "...", "dalle_prompt": "..." }`
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );

  const content = response.data.choices[0].message.content.trim();
  // Strip markdown code fences if GPT wraps the JSON
  const json = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(json);
}

// ─── Step 2a: Pexels (FREE) ───────────────────────────────────────────────────
async function searchPexels(query) {
  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: PEXELS_KEY },
    params: {
      query: query + ' technology futuristic',
      per_page: 5,
      orientation: 'landscape'
    }
  });
  const photos = res.data.photos;
  if (!photos || !photos.length) return null;
  const best = photos[0];
  return {
    url: best.src.large2x,
    source: 'pexels',
    credit: best.photographer
  };
}

// ─── Step 2b: Unsplash (FREE) ─────────────────────────────────────────────────
async function searchUnsplash(query) {
  const res = await axios.get('https://api.unsplash.com/search/photos', {
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    params: {
      query: query + ' tech AI digital',
      per_page: 5,
      orientation: 'landscape'
    }
  });
  const results = res.data.results;
  if (!results || !results.length) return null;
  const best = results[0];
  return {
    url: best.urls.regular,
    source: 'unsplash',
    credit: best.user.name
  };
}

// ─── Step 2c: SERP API Google Images (paid ~$0.001/call) ─────────────────────
async function searchSerpApi(query) {
  const res = await axios.get('https://serpapi.com/search', {
    params: {
      engine: 'google_images',
      q: query + ' technology futuristic professional',
      api_key: SERP_KEY,
      num: 5,
      safe: 'active'
    }
  });
  const images = res.data.images_results;
  if (!images || !images.length) return null;
  return {
    url: images[0].original,
    source: 'serp_google_images',
    credit: images[0].source
  };
}

// ─── Step 2d: DALL-E 3 (last resort ~$0.04/image) ────────────────────────────
async function generateWithDalle(prompt) {
  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt:
        prompt +
        '. Style: cinematic tech aesthetic, dark background with blue/cyan accent lights, futuristic office or data center, no people, no text, no watermarks, professional LinkedIn post image, 16:9 ratio',
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
  );
  return {
    url: res.data.data[0].url,
    source: 'openai_dalle3',
    credit: 'AI Generated'
  };
}

// ─── Step 3: Download & resize to 1200×628 (LinkedIn ideal) ──────────────────
async function downloadImage(url, filepath) {
  const response = await axios({ url, responseType: 'arraybuffer', timeout: 30000 });
  await sharp(Buffer.from(response.data))
    .resize(1200, 628, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filepath);
}

// ─── Step 4a: Get or create folder in Drive ───────────────────────────────────
async function getOrCreateFolder(parentId, folderName) {
  const res = await drive.files.list({
    q: `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)'
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });
  return folder.data.id;
}

// ─── Step 4b: Upload file to Drive and make it public ────────────────────────
async function uploadToDrive(filePath, fileName, topic) {
  const date = new Date().toISOString().split('T')[0];
  // e.g. "2026-02-26 — ai_automation"
  const folderName = `${date} \u2014 ${topic.replace(/\s+/g, '_').toLowerCase()}`;

  const folderId = await getOrCreateFolder(GOOGLE_ROOT_FOLDER_ID, folderName);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: 'image/jpeg',
      body: fs.createReadStream(filePath)
    },
    fields: 'id, webViewLink'
  });

  // Make publicly viewable so n8n / LinkedIn can read it
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return {
    file_id: res.data.id,
    drive_link: res.data.webViewLink,
    folder: folderName
  };
}

// ─── Main endpoint ────────────────────────────────────────────────────────────
app.post('/api/find-image', async (req, res) => {
  const { linkedin_post } = req.body;
  if (!linkedin_post) {
    return res.status(400).json({ success: false, error: 'linkedin_post is required' });
  }

  let tempPath = null;

  try {
    // 1. Extract keywords (cheap GPT-4o-mini call)
    console.log('[1/4] Extracting keywords...');
    const { topic, search_query, dalle_prompt } = await extractKeywords(linkedin_post);
    console.log(`      topic="${topic}"  query="${search_query}"`);

    // 2. Image waterfall
    console.log('[2/4] Searching for image...');
    let imageResult = null;

    imageResult = await searchPexels(search_query).catch(e => {
      console.warn('      Pexels failed:', e.message);
      return null;
    });
    if (imageResult) console.log('      ✓ Found on Pexels');

    if (!imageResult) {
      imageResult = await searchUnsplash(search_query).catch(e => {
        console.warn('      Unsplash failed:', e.message);
        return null;
      });
      if (imageResult) console.log('      ✓ Found on Unsplash');
    }

    if (!imageResult) {
      imageResult = await searchSerpApi(search_query).catch(e => {
        console.warn('      SERP API failed:', e.message);
        return null;
      });
      if (imageResult) console.log('      ✓ Found via SERP API');
    }

    if (!imageResult) {
      console.log('      Falling back to DALL-E 3 (costs ~$0.04)...');
      imageResult = await generateWithDalle(dalle_prompt).catch(e => {
        console.warn('      DALL-E 3 failed:', e.message);
        return null;
      });
      if (imageResult) console.log('      ✓ Generated with DALL-E 3');
    }

    if (!imageResult) throw new Error('All image sources failed');

    // 3. Download + resize
    console.log('[3/4] Downloading and resizing image...');
    const timestamp = Date.now();
    const filename = `${topic.replace(/\s+/g, '_')}_${timestamp}.jpg`;
    tempPath = path.join(os.tmpdir(), filename);
    await downloadImage(imageResult.url, tempPath);

    // 4. Upload to Google Drive
    console.log('[4/4] Uploading to Google Drive...');
    const { file_id, drive_link, folder } = await uploadToDrive(tempPath, filename, topic);
    console.log(`      ✓ Uploaded: ${drive_link}`);

    // 5. Cleanup
    fs.unlinkSync(tempPath);
    tempPath = null;

    // 6. Return result to n8n
    return res.json({
      success: true,
      file_id,
      drive_link,
      source: imageResult.source,
      topic,
      folder,
      image_url: imageResult.url
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
    // Clean up temp file on error
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
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
