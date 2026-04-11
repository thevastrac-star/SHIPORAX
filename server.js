require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();

// ─── ENVIRONMENT CONFIG ───────────────────────────────────────────────────────
// MODE controls what this server instance serves at /
// MODE=admin  → serves admin panel at /
// MODE=client → serves client panel at /
// MODE=both   → serves login page with both panels (default, old behaviour)
const MODE = (process.env.MODE || 'both').toLowerCase();

// BACKEND_URL is the URL of the API server (this same server if MODE=both,
// or the shared API server URL if admin/client are deployed separately)
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
const API_URL = process.env.API_URL || BACKEND_URL; // URL frontend uses to reach /api

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
const uploadDirs = ['uploads/kyc', 'uploads/bulk'];
uploadDirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── HTML INJECTION HELPER ────────────────────────────────────────────────────
// Injects window.__API_URL so frontend JS knows where the API lives.
// This is the KEY FIX: frontend no longer uses relative '/api' paths —
// it uses the actual API server URL injected at serve time.
function serveWithInjection(res, filePath) {
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    const injection = `<script>window.__API_URL = '${API_URL}';</script>`;
    // Inject right before closing </head> tag
    html = html.replace('</head>', injection + '\n</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Error loading page: ' + err.message);
  }
}

// ─── FRONTEND ROUTES ──────────────────────────────────────────────────────────

if (MODE === 'admin') {
  // ── ADMIN-ONLY SERVER ──
  // Everything at / serves admin panel
  app.get('/', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'index.html')));
  app.get('/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'login.html')));
  app.get('/admin', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'index.html')));
  app.get('/admin/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'login.html')));
  // Redirect anything else to admin login
  app.get('/client', (req, res) => res.redirect('/'));
  app.get('/client/login', (req, res) => res.redirect('/login'));

} else if (MODE === 'client') {
  // ── CLIENT-ONLY SERVER ──
  // Everything at / serves client panel
  app.get('/', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'index.html')));
  app.get('/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'login.html')));
  app.get('/client', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'index.html')));
  app.get('/client/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'login.html')));
  // Redirect admin URLs to client
  app.get('/admin', (req, res) => res.redirect('/'));
  app.get('/admin/login', (req, res) => res.redirect('/login'));

} else {
  // ── BOTH (default, single server) ──
  app.get('/', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'login.html')));
  app.get('/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'login.html')));
  app.get('/admin/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'login.html')));
  app.get('/client/login', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'login.html')));
  app.get('/admin', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'admin', 'index.html')));
  app.get('/client', (req, res) => serveWithInjection(res, path.join(__dirname, 'public', 'client', 'index.html')));
}

// Static files (CSS, JS, images if any) — served after route handlers
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/wallet',        require('./routes/wallet'));
app.use('/api/kyc',           require('./routes/kyc'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/ndr',           require('./routes/ndr'));
app.use('/api/cod',           require('./routes/cod'));
app.use('/api/couriers',      require('./routes/couriers'));
app.use('/api/tickets',       require('./routes/tickets'));
app.use('/api/warehouses',    require('./routes/warehouses'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/notifications', require('./routes/notifications'));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', mode: MODE, time: new Date() }));

// ─── 404 FALLBACK ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: `API route ${req.originalUrl} not found` });
  }
  // For non-API 404s, redirect to appropriate home
  res.redirect('/');
});

// ─── DATABASE + AUTO-SEED ─────────────────────────────────────────────────────
const autoSeed = require('./config/autoSeed');

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log('✅ MongoDB connected');
  await autoSeed();
})
.catch(err => console.error('❌ MongoDB error:', err));

// ─── KEEP-ALIVE PING ──────────────────────────────────────────────────────────
const PING_INTERVAL = 7 * 60 * 1000;
const keepAlive = () => {
  try {
    const url = new URL(BACKEND_URL + '/health');
    const lib = url.protocol === 'https:' ? https : http;
    lib.get(url.href, (r) => {
      console.log(`[Keep-Alive] ${new Date().toISOString()} – ${r.statusCode}`);
    }).on('error', (e) => console.warn('[Keep-Alive] Ping failed:', e.message));
  } catch(e) {}
};
setTimeout(() => { setInterval(keepAlive, PING_INTERVAL); console.log('🔔 Keep-alive started'); }, 15000);

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 SHIPORAX Server — PORT ${PORT} — MODE: ${MODE.toUpperCase()}`);
  console.log(`📡 API URL injected into frontend: ${API_URL}`);
  if (MODE === 'admin')  console.log(`🛠  Admin Panel → ${BACKEND_URL}/`);
  if (MODE === 'client') console.log(`👤 Client Panel → ${BACKEND_URL}/`);
  if (MODE === 'both') {
    console.log(`🌐 Login    → ${BACKEND_URL}/login`);
    console.log(`🛠  Admin   → ${BACKEND_URL}/admin`);
    console.log(`👤 Client  → ${BACKEND_URL}/client`);
  }
  console.log('');
});

module.exports = app;
