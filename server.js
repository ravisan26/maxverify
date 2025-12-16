// server.js - FIXED VERSION with working analytics endpoint
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ CHANGE THIS PASSWORD! Set it in Render Environment Variables
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Trust proxy - IMPORTANT for getting real IP on Render
app.set('trust proxy', true);

// Initialize database tables and schema changes
async function initDB() {
  try {
    // Create urls table (with partner_id and expires_at)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS urls (
        code VARCHAR(50) PRIMARY KEY,
        url TEXT NOT NULL,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        clicks INTEGER DEFAULT 0,
        partner_id INTEGER,
        expires_at TIMESTAMP
      )
    `);

    // Create clicks table for analytics
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) REFERENCES urls(code) ON DELETE CASCADE,
        ip_address VARCHAR(100),
        country VARCHAR(100),
        city VARCHAR(100),
        region VARCHAR(100),
        user_agent TEXT,
        device VARCHAR(50),
        browser VARCHAR(50),
        os VARCHAR(50),
        referrer TEXT,
        clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create partners table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        domain TEXT NOT NULL
      )
    `);

    // Create bypass_logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bypass_logs (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) REFERENCES urls(code) ON DELETE CASCADE,
        referrer TEXT,
        ip_address VARCHAR(100),
        user_agent TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database initialized & migrations applied');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

initDB();

// Get real IP address from request
function getRealIP(req) {
  // Check various headers in order of reliability
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, get the first (original client)
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0];
  }
  
  const realIP = req.headers['x-real-ip'];
  if (realIP) return realIP;
  
  const cfConnectingIP = req.headers['cf-connecting-ip'];
  if (cfConnectingIP) return cfConnectingIP;
  
  return req.ip || req.connection.remoteAddress || 'Unknown';
}

// Get location from IP address using free API
async function getLocationFromIP(ip) {
  try {
    // Skip local IPs
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'Unknown' ||
        ip.startsWith('192.168') || ip.startsWith('10.') || 
        ip.startsWith('172.16') || ip.startsWith('172.31') ||
        ip.includes('::ffff:127.0.0.1') || ip.includes('::1')) {
      return { country: 'Local', city: 'Local', region: 'Local' };
    }

    // Clean IPv6 wrapper if present
    const cleanIP = ip.replace('::ffff:', '');

    console.log(`🌍 Fetching location for IP: ${cleanIP}`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(`http://ip-api.com/json/${cleanIP}?fields=status,message,country,city,regionName,lat,lon,timezone`, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();

    if (data && data.status === 'success') {
      console.log(`✅ Location found: ${data.city}, ${data.country}`);
      return {
        country: data.country || 'Unknown',
        city: data.city || 'Unknown',
        region: data.regionName || 'Unknown'
      };
    } else {
      console.log(`⚠️ IP-API returned: ${data.message || 'Unknown error'}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⚠️ Location fetch timeout');
    } else {
      console.error('⚠️ Error fetching location:', err.message);
    }
  }

  return { country: 'Unknown', city: 'Unknown', region: 'Unknown' };
}

// Parse user agent to get device/browser info
function parseUserAgent(userAgent) {
  const ua = (userAgent || '').toLowerCase();

  // Detect device
  let device = 'Desktop';
  if (ua.includes('mobile')) device = 'Mobile';
  else if (ua.includes('tablet')) device = 'Tablet';

  // Detect browser
  let browser = 'Unknown';
  if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('edg')) browser = 'Edge';
  else if (ua.includes('opera') || ua.includes('opr')) browser = 'Opera';

  // Detect OS
  let os = 'Unknown';
  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';

  return { device, browser, os };
}

// Password verification middleware
function requireAuth(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }

  next();
}

// Generate random short code
function generateCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Serve login page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve admin dashboard (protected)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----- Partner endpoints -----
// Get partners
app.get('/api/partners', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM partners ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching partners:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create partner
app.post('/api/partners', requireAuth, async (req, res) => {
  const { name, domain } = req.body;
  if (!name || !domain) {
    return res.status(400).json({ error: 'Name and domain are required' });
  }

  try {
    const inserted = await pool.query(
      'INSERT INTO partners (name, domain) VALUES ($1, $2) RETURNING *',
      [name, domain]
    );
    res.json(inserted.rows[0]);
  } catch (err) {
    console.error('Error creating partner:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all URLs (admin)
app.get('/api/urls', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, p.name as partner_name, p.domain as partner_domain
      FROM urls u
      LEFT JOIN partners p ON u.partner_id = p.id
      ORDER BY created DESC
    `);
    const urls = {};
    result.rows.forEach(row => {
      urls[row.code] = {
        url: row.url,
        created: row.created,
        clicks: row.clicks,
        partnerId: row.partner_id,
        partnerName: row.partner_name,
        partnerDomain: row.partner_domain,
        expiresAt: row.expires_at
      };
    });
    res.json(urls);
  } catch (err) {
    console.error('Error fetching URLs:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get analytics for a specific URL (FIXED VERSION)
app.get('/api/analytics/:code', requireAuth, async (req, res) => {
  const { code } = req.params;

  try {
    console.log(`📊 Fetching analytics for code: ${code}`);

    // First verify the URL exists
    const urlCheck = await pool.query('SELECT code FROM urls WHERE code = $1', [code]);
    if (urlCheck.rows.length === 0) {
      console.log(`❌ URL not found: ${code}`);
      return res.status(404).json({ error: 'URL not found' });
    }

    // Get click details
    let clicks = { rows: [] };
    try {
      clicks = await pool.query(
        'SELECT * FROM clicks WHERE code = $1 ORDER BY clicked_at DESC LIMIT 100',
        [code]
      );
      console.log(`✅ Found ${clicks.rows.length} clicks for ${code}`);
    } catch (err) {
      console.error('Error fetching clicks:', err);
      // Continue anyway
    }

    // Get country stats
    let countryStats = { rows: [] };
    try {
      countryStats = await pool.query(
        'SELECT country, COUNT(*) as count FROM clicks WHERE code = $1 GROUP BY country ORDER BY count DESC',
        [code]
      );
    } catch (err) {
      console.error('Error fetching country stats:', err);
      // Continue anyway
    }

    // Get device stats
    let deviceStats = { rows: [] };
    try {
      deviceStats = await pool.query(
        'SELECT device, COUNT(*) as count FROM clicks WHERE code = $1 GROUP BY device ORDER BY count DESC',
        [code]
      );
    } catch (err) {
      console.error('Error fetching device stats:', err);
      // Continue anyway
    }

    // Get bypass logs
    let bypasses = { rows: [] };
    try {
      bypasses = await pool.query(
        'SELECT * FROM bypass_logs WHERE code = $1 ORDER BY detected_at DESC LIMIT 100',
        [code]
      );
      console.log(`✅ Found ${bypasses.rows.length} bypass attempts for ${code}`);
    } catch (err) {
      console.error('Error fetching bypass logs:', err);
      // Continue anyway
    }

    // Return the data
    const response = {
      recentClicks: clicks.rows || [],
      countryStats: countryStats.rows || [],
      deviceStats: deviceStats.rows || [],
      bypassAttempts: bypasses.rows || []
    };

    console.log(`✅ Returning analytics for ${code}:`, {
      clicks: response.recentClicks.length,
      bypasses: response.bypassAttempts.length
    });

    res.json(response);
  } catch (err) {
    console.error('❌ Error fetching analytics:', err);
    console.error('Error details:', err.message);
    console.error('Stack trace:', err.stack);
    res.status(500).json({ 
      error: 'Database error', 
      message: err.message,
      code: code 
    });
  }
});

// Create short URL (admin)
app.post('/api/shorten', requireAuth, async (req, res) => {
  const { url, customCode, partnerId, expiresAt } = req.body;

  if (!url || !url.match(/^https?:\/\/.+/)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    let code = customCode || generateCode();

    // Check uniqueness
    const existing = await pool.query('SELECT code FROM urls WHERE code = $1', [code]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Code already exists' });
    }

    // Ensure generated code is unique
    while (!customCode) {
      const check = await pool.query('SELECT code FROM urls WHERE code = $1', [code]);
      if (check.rows.length === 0) break;
      code = generateCode();
    }

    // Insert new URL
    await pool.query(
      'INSERT INTO urls (code, url, created, clicks, partner_id, expires_at) VALUES ($1, $2, NOW(), 0, $3, $4)',
      [code, url, partnerId || null, expiresAt || null]
    );

    res.json({ code, shortUrl: `${req.protocol}://${req.get('host')}/${code}` });
  } catch (err) {
    console.error('Error creating short URL:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete URL
app.delete('/api/urls/:code', requireAuth, async (req, res) => {
  const { code } = req.params;

  try {
    const result = await pool.query('DELETE FROM urls WHERE code = $1 RETURNING code', [code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'URL not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting URL:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Public redirect route with analytics tracking and bypass detection
app.get('/:code', async (req, res) => {
  const { code } = req.params;

  try {
    // fetch url + partner
    const result = await pool.query(`
      SELECT u.*, p.name as partner_name, p.domain as partner_domain
      FROM urls u
      LEFT JOIN partners p ON u.partner_id = p.id
      WHERE u.code = $1
    `, [code]);

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>404 - Link Not Found</title>
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display:flex;
              align-items:center;
              justify-content:center;
              min-height:100vh;
              margin:0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .box {
              background: rgba(255,255,255,0.1);
              backdrop-filter: blur(20px);
              padding:40px;
              border-radius:20px;
              box-shadow:0 20px 60px rgba(0,0,0,0.3);
              text-align:center;
              color: white;
              border: 1px solid rgba(255,255,255,0.2);
            }
            h1 { margin:0 0 12px 0; font-size:2rem; }
            p { margin:0; opacity:0.9; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>🔍 404 - Link Not Found</h1>
            <p>This short link doesn't exist or has been deleted.</p>
          </div>
        </body>
        </html>
      `);
    }

    const urlData = result.rows[0];
    const targetUrl = urlData.url;
    const partnerDomain = urlData.partner_domain;
    const expiresAt = urlData.expires_at;

    // Check expiry
    if (expiresAt && new Date(expiresAt) < new Date()) {
      return res.status(410).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Link Expired</title>
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display:flex;
              align-items:center;
              justify-content:center;
              min-height:100vh;
              margin:0;
              background: #0a0a0a;
              color:white;
            }
            .box {
              background: rgba(255,255,255,0.05);
              backdrop-filter: blur(20px);
              padding:40px;
              border-radius:20px;
              text-align:center;
              border: 1px solid rgba(255,255,255,0.1);
            }
            h1 { margin:0 0 12px 0; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>🔒 Link Expired</h1>
            <p>This link has expired and can no longer be used.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Get visitor info - FIXED IP DETECTION
    const ip = getRealIP(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const referrer = (req.headers['referer'] || req.headers['referrer'] || 'Direct').toString();

    console.log(`📊 Visitor IP: ${ip}, Referrer: ${referrer}`);

    // If partner is configured, enforce referrer contains partner domain
    if (partnerDomain) {
      const normalize = str => str.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();

      const normalizedPartner = normalize(partnerDomain);
      const normalizedRef = normalize(referrer || '');

      const isAllowed =
        normalizedRef === normalizedPartner ||
        normalizedRef.startsWith(normalizedPartner + '/') ||
        normalizedRef.includes(normalizedPartner);

      if (!isAllowed) {
        // Log bypass attempt
        try {
          await pool.query(
            'INSERT INTO bypass_logs (code, referrer, ip_address, user_agent) VALUES ($1, $2, $3, $4)',
            [code, referrer, ip, userAgent]
          );
          console.log(`🚨 Bypass attempt logged for ${code} from IP ${ip}`);
        } catch (err) {
          console.error('Error logging bypass attempt:', err);
        }

        // Show bypass detected page
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Bypass Detected</title>
              <style>
                  * { margin:0; padding:0; box-sizing:border-box; }
                  body {
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                      color: white;
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      height: 100vh;
                      margin: 0;
                      padding: 20px;
                  }
                  .warning-box {
                      max-width: 640px;
                      padding: 48px;
                      border-radius: 24px;
                      background: rgba(255, 255, 255, 0.1);
                      backdrop-filter: blur(20px);
                      border: 1px solid rgba(255, 255, 255, 0.2);
                      text-align: center;
                      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
                  }
                  h1 { 
                      font-size: 3rem; 
                      margin: 0 0 1.5rem 0; 
                  }
                  p { 
                      font-size: 1.2rem; 
                      opacity: 0.95; 
                      line-height: 1.7;
                      margin: 0 0 2rem 0;
                  }
                  .credit {
                      margin-top: 2.5rem;
                      padding-top: 2rem;
                      border-top: 1px solid rgba(255, 255, 255, 0.2);
                      font-weight: 700;
                      font-size: 1rem;
                  }
                  .credit a {
                      color: white;
                      text-decoration: none;
                      transition: opacity 0.3s;
                  }
                  .credit a:hover {
                      opacity: 0.7;
                  }
              </style>
          </head>
          <body>
              <div class="warning-box">
                  <h1>⚠️ Bypass Detected</h1>
                  <p>
                      Access denied. Please don't bypass the link.<br>
                      <strong>X</strong><br>
                      
                  </p>
                  <div class="credit">
                      Developed by <a href="https://t.me/RSCBots" target="_blank" rel="noopener noreferrer">@RSCBots</a>
                  </div>
              </div>
          </body>
          </html>
        `);
      }
    }

    // Parse user agent
    const { device, browser, os } = parseUserAgent(userAgent);

    // Record click (async location) - IMPROVED ERROR HANDLING
    getLocationFromIP(ip).then(async (location) => {
      try {
        await pool.query(
          `INSERT INTO clicks (code, ip_address, country, city, region, user_agent, device, browser, os, referrer, clicked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [code, ip, location.country, location.city, location.region, userAgent, device, browser, os, referrer]
        );

        await pool.query('UPDATE urls SET clicks = clicks + 1 WHERE code = $1', [code]);
        console.log(`✅ Click recorded for ${code} from ${location.city}, ${location.country}`);
      } catch (err) {
        console.error('❌ Error recording click:', err);
      }
    }).catch(err => {
      console.error('❌ Location fetch failed:', err);
      // Still record click without location
      pool.query(
        `INSERT INTO clicks (code, ip_address, country, city, region, user_agent, device, browser, os, referrer, clicked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [code, ip, 'Unknown', 'Unknown', 'Unknown', userAgent, device, browser, os, referrer]
      ).catch(e => console.error('Failed to record click without location:', e));
    });

// Send redirect countdown page
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>verifying...</title>
          <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                  background: #0a0a0a; 
                  min-height: 100vh; 
                  display: flex; 
                  align-items: center; 
                  justify-content: center; 
                  padding: 2rem; 
                  overflow: hidden;
                  position: relative;
              }
              body::before {
                  content: '';
                  position: absolute;
                  inset: 0;
                  background: linear-gradient(45deg, #667eea, #764ba2, #f5576c);
                  background-size: 400% 400%;
                  animation: gradient 15s ease infinite;
                  opacity: 0.2;
              }
              @keyframes gradient {
                  0% { background-position: 0% 50%; }
                  50% { background-position: 100% 50%; }
                  100% { background-position: 0% 50%; }
              }
              .redirect-card { 
                  position: relative;
                  z-index: 1;
                  background: rgba(255, 255, 255, 0.05); 
                  backdrop-filter: blur(20px); 
                  border-radius: 24px; 
                  padding: 48px; 
                  max-width: 560px;
                  width: 100%;
                  text-align: center; 
                  color: #fff;
                  border: 1px solid rgba(255, 255, 255, 0.1);
                  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              }
              h1 {
                  font-size: 1.8rem;
                  margin-bottom: 1.5rem;
                  font-weight: 700;
              }
              .countdown { 
                  font-size: 5rem; 
                  font-weight: 700; 
                  margin: 2rem 0; 
                  background: linear-gradient(135deg, #667eea, #764ba2, #f5576c); 
                  -webkit-background-clip: text; 
                  -webkit-text-fill-color: transparent; 
                  background-clip: text;
                  animation: pulse 1s ease-in-out infinite;
              }
              @keyframes pulse {
                  0%, 100% { transform: scale(1); }
                  50% { transform: scale(1.05); }
              }
              p {
                  opacity: 0.8;
                  margin-bottom: 2rem;
                  font-size: 1.1rem;
              }
              .skip-btn { 
                  padding: 16px 40px; 
                  border-radius: 12px; 
                  border: none; 
                  background: linear-gradient(135deg, #667eea, #764ba2); 
                  color: white; 
                  cursor: pointer; 
                  font-weight: 700; 
                  font-size: 1rem;
                  transition: all 0.3s ease;
                  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
              }
              .skip-btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
              }
              .skip-btn:active {
                  transform: translateY(0);
              }
          </style>
      </head>
      <body>
        <div class="redirect-card">
          <h1>verifying You...</h1>
          <div class="countdown" id="countdown">3</div>
          <p>Please wait while we are verifying you</p>
          <button class="skip-btn" onclick="redirect()">This will take 3-5 Seconds...</button>
        </div>

        <script>
          let count = 3;
          const targetUrl = ${JSON.stringify(targetUrl)};
          function redirect() { window.location.href = targetUrl; }
          const timer = setInterval(() => {
            count--;
            document.getElementById('countdown').textContent = count;
            if (count <= 0) { clearInterval(timer); redirect(); }
          }, 1000);
        </script>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('Error handling redirect:', err);
    res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
  console.log(`📊 Trust proxy enabled for accurate IP detection`);
});
