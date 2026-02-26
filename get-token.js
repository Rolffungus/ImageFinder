/**
 * get-token.js — Automatically grabs your Google OAuth2 refresh token
 *
 * Usage:  node get-token.js
 *
 * What happens:
 *   1. A temporary server starts on port 3000
 *   2. The auth URL is printed — open it in your browser
 *   3. Sign in and grant Drive access
 *   4. Google redirects back to localhost:3000 automatically
 *   5. The refresh token is printed AND written to your .env file
 */

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/oauth/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // ensures refresh_token is always returned
  scope: ['https://www.googleapis.com/auth/drive.file']
});

// ─── Temporary HTTP server — catches the callback ────────────────────────────
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth/callback')) {
    res.end('Waiting for Google callback...');
    return;
  }

  const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('No authorization code found in the callback URL.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    // ── Success page in browser ───────────────────────────────────────────────
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;background:#0a0e1a;color:#e0e6f0;padding:40px;text-align:center">
        <h2 style="color:#38bdf8">✓ Authorization successful!</h2>
        <p>You can close this tab and return to the terminal.</p>
      </body></html>
    `);

    // ── Print token to console ────────────────────────────────────────────────
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('  ✓ SUCCESS — Refresh token obtained!');
    console.log('─────────────────────────────────────────────────────────────\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\n─────────────────────────────────────────────────────────────');

    // ── Write token directly into .env ────────────────────────────────────────
    const fs = require('fs');
    const envPath = require('path').join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(
        /GOOGLE_REFRESH_TOKEN=.*/,
        `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`
      );
    } else {
      envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log('\n  ✓ Token automatically saved to .env');
    console.log('\n  Next step: set GOOGLE_ROOT_FOLDER_ID in .env');
    console.log('  Open a Drive folder → copy the ID from the URL:');
    console.log('  https://drive.google.com/drive/folders/<THIS_IS_THE_ID>\n');

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:sans-serif;padding:40px">
      <h2 style="color:red">Error</h2><pre>${err.message}</pre>
    </body></html>`);
    console.error('\n[ERROR] Failed to exchange code:', err.message);
  }

  server.close();
});

server.listen(3000, () => {
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  Google OAuth2 — Desktop App Token Setup');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('\n  Open this URL in your browser:\n');
  console.log('  ' + authUrl);
  console.log('\n  (Waiting for Google to redirect back...)\n');
});
