// Force timezone to Europe/Kyiv so local Date operations match the target audience's timezone
process.env.TZ = 'Europe/Kyiv';

const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Helper to get local date string in YYYY-MM-DD format (respecting process.env.TZ)
function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const camelCaseMap = {
  userid: 'userId',
  requestedamount: 'requestedAmount',
  actualamount: 'actualAmount',
  paymentkey: 'paymentKey',
  expiresat: 'expiresAt',
  washesadded: 'washesAdded',
  createdat: 'createdAt',
  updatedat: 'updatedAt',
  monobanktransactionid: 'monobankTransactionId',
  sendername: 'senderName',
  receivedat: 'receivedAt'
};

function normalizeRow(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const [lower, camel] of Object.entries(camelCaseMap)) {
    if (lower in normalized) {
      normalized[camel] = normalized[lower];
    }
  }
  return normalized;
}

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MONOBANK_JAR_ID = process.env.MONOBANK_JAR_ID;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'laundry_admin_2024';
const DEV_MODE = process.env.DEV_MODE === 'true';
const { randomUUID } = crypto;

if (!BOT_TOKEN || BOT_TOKEN === 'REPLACE_WITH_REAL_TOKEN') {
  if (!DEV_MODE) {
    console.warn('⚠️  BOT_TOKEN not set! Set DEV_MODE=true in .env to run without a real token, or add a real BOT_TOKEN.');
  }
}

if (!WEBAPP_URL) {
  console.warn('⚠️  Missing WEBAPP_URL in .env');
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'db');
const DB_PATH = path.join(DATA_DIR, 'laundry.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const usePostgres = !!process.env.DATABASE_URL;
let db = null;
let pgPool = null;

function prepareQuery(sql, params) {
  if (!usePostgres) {
    return { sql, params };
  }

  let pgSql = sql;

  // Cast text comparison for expiresAt and receivedAt in PostgreSQL to prevent operator text > timestamp mismatch
  pgSql = pgSql.replace(/expiresAt\s*>\s*datetime\(['"]now['"]\)/gi, "CAST(expiresAt AS TIMESTAMPTZ) > CURRENT_TIMESTAMP");
  pgSql = pgSql.replace(/expiresAt\s*<\s*datetime\(['"]now['"]\)/gi, "CAST(expiresAt AS TIMESTAMPTZ) < CURRENT_TIMESTAMP");
  pgSql = pgSql.replace(/receivedAt\s*>=\s*datetime\(['"]now['"]\s*,\s*['"]-2 hours['"]\)/gi, "CAST(receivedAt AS TIMESTAMPTZ) >= (CURRENT_TIMESTAMP - INTERVAL '2 hours')");
  pgSql = pgSql.replace(/receivedAt\s*>=\s*datetime\(['"]now['"]\s*,\s*['"]-24 hours['"]\)/gi, "CAST(receivedAt AS TIMESTAMPTZ) >= (CURRENT_TIMESTAMP - INTERVAL '24 hours')");

  // Replace datetime("now") or datetime('now') with CURRENT_TIMESTAMP
  pgSql = pgSql.replace(/datetime\(['"]now['"]\)/gi, 'CURRENT_TIMESTAMP');

  // Replace datetime('now', '-2 hours') with (CURRENT_TIMESTAMP - INTERVAL '2 hours')
  pgSql = pgSql.replace(/datetime\(['"]now['"]\s*,\s*['"]-2 hours['"]\)/gi, "(CURRENT_TIMESTAMP - INTERVAL '2 hours')");

  // Replace INSERT OR IGNORE
  if (pgSql.toUpperCase().includes('INSERT OR IGNORE INTO MACHINES')) {
    pgSql = pgSql.replace(/INSERT OR IGNORE INTO Machines/gi, 'INSERT INTO Machines');
    pgSql += ' ON CONFLICT (id) DO NOTHING';
  } else if (pgSql.toUpperCase().includes('INSERT OR IGNORE INTO SETTINGS')) {
    pgSql = pgSql.replace(/INSERT OR IGNORE INTO Settings/gi, 'INSERT INTO Settings');
    pgSql += ' ON CONFLICT (key) DO NOTHING';
  }

  // Replace MAX(a, b) with GREATEST(a, b) for PostgreSQL
  pgSql = pgSql.replace(/MAX\(([^,]+),([^)]+)\)/gi, 'GREATEST($1,$2)');

  // Replace ? placeholders with $1, $2, etc.
  let index = 1;
  pgSql = pgSql.replace(/\?/g, () => '$' + (index++));

  return { sql: pgSql, params };
}

if (usePostgres) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  console.log('PostgreSQL: DB connected via URL');
  try {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    let pgSchema = schema
      .replace(/PRAGMA foreign_keys = ON;/gi, '')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/\b(id|user_id|userId)\s+INTEGER\b/g, '$1 BIGINT')
      .replace(/datetime\(['"]now['"]\)/gi, 'CURRENT_TIMESTAMP')
      .replace(/INSERT OR IGNORE INTO Settings/gi, 'INSERT INTO Settings')
      .replace(/VALUES \('monthly_limit', '12'\);/gi, "VALUES ('monthly_limit', '12') ON CONFLICT (key) DO NOTHING;");
    
    pgPool.query(pgSchema)
      .then(() => {
        console.log('PostgreSQL: Schema initialized');
        const machines = [
          { id: 1, name: 'Пральна 1' },
          { id: 2, name: 'Пральна 2' },
          { id: 3, name: 'Пральна 3' }
        ];
        const promises = machines.map(m => {
          return pgPool.query('INSERT INTO Machines (id, name, status) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [m.id, m.name, 'active']);
        });
        return Promise.all(promises);
      })
      .then(() => {
        console.log('PostgreSQL: Machines synchronized (3 machines active).');
      })
      .catch(err => {
        console.error('PostgreSQL Schema init error:', err.message);
      });
  } catch (fsErr) {
    console.error('PostgreSQL: Could not read schema.sql:', fsErr.message);
  }
} else {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('SQLite: DB open error:', err.message);
    } else {
      console.log('SQLite: DB connected');
      try {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        db.exec(schema, (err) => {
          if (err) {
            console.error('SQLite: Schema init error:', err.message);
          } else {
            const machines = [
              { id: 1, name: 'Пральна 1' },
              { id: 2, name: 'Пральна 2' },
              { id: 3, name: 'Пральна 3' }
            ];
            machines.forEach(m => {
              db.run('INSERT OR IGNORE INTO Machines (id, name, status) VALUES (?, ?, ?)', [m.id, m.name, 'active']);
            });
            console.log('SQLite: Machines synchronized (3 machines active).');
          }
        });
      } catch (fsErr) {
        console.error('SQLite: Could not read schema.sql:', fsErr.message);
      }
    }
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

let botUsername = '';

const TIME_SLOTS = [
  '07:00–09:30',
  '09:30–12:00',
  '12:00–14:30',
  '14:30–17:00',
  '17:00–19:30',
  '19:30–22:00'
];

async function dbGet(sql, params = []) {
  if (usePostgres) {
    const prepared = prepareQuery(sql, params);
    const res = await pgPool.query(prepared.sql, prepared.params);
    return normalizeRow(res.rows[0]);
  } else {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
}

async function dbAll(sql, params = []) {
  if (usePostgres) {
    const prepared = prepareQuery(sql, params);
    const res = await pgPool.query(prepared.sql, prepared.params);
    return res.rows.map(normalizeRow);
  } else {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
}

async function dbRun(sql, params = []) {
  if (usePostgres) {
    const prepared = prepareQuery(sql, params);
    const res = await pgPool.query(prepared.sql, prepared.params);
    return {
      lastID: res.oid || (res.rows && res.rows[0] && res.rows[0].id),
      changes: res.rowCount
    };
  } else {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function runCb(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }
}

// Middleware to block API endpoints during maintenance mode (except config & admin)
async function checkMaintenance(req, res, next) {
  if (req.path.startsWith('/admin') || req.path === '/config' || req.path === '/health') {
    return next();
  }
  try {
    const maintModeSetting = await dbGet("SELECT value FROM Settings WHERE key = 'maintenance_mode'");
    const isMaintActive = maintModeSetting ? maintModeSetting.value === 'true' : false;

    if (isMaintActive) {
      const maintPassSetting = await dbGet("SELECT value FROM Settings WHERE key = 'maintenance_password'");
      const correctPass = maintPassSetting ? maintPassSetting.value : '';
      const clientPass = req.headers['x-maintenance-password'];

      if (!clientPass || clientPass.trim() !== correctPass.trim()) {
        return res.json({ ok: false, error: 'maintenance_restricted', error_uk: 'Ведуться технічні роботи. Невірний пароль доступу!' });
      }
    }
    next();
  } catch (err) {
    console.error('Maintenance middleware error:', err);
    next();
  }
}

app.use('/api', checkMaintenance);

function verifyInitData(initData) {
  if (!initData) return false;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckArr = [];
  urlParams.sort();
  urlParams.forEach((value, key) => {
    dataCheckArr.push(`${key}=${value}`);
  });
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return computedHash === hash;
}

async function getOrCreateUser(tgUser) {
  const userId = tgUser.id;
  const username = tgUser.username || null;
  const existing = await dbGet('SELECT * FROM Users WHERE id = ?', [userId]);
  if (existing) {
    if (username && existing.username !== username) {
      await dbRun('UPDATE Users SET username = ? WHERE id = ?', [username, userId]);
    }
    return existing;
  }
  await dbRun('INSERT INTO Users (id, username, role, is_privileged, balance, is_registered) VALUES (?, ?, ?, ?, ?, ?)', [
    userId,
    username,
    'user',
    0,
    0,
    0
  ]);
  return dbGet('SELECT * FROM Users WHERE id = ?', [userId]);
}

function requireTelegram(req, res) {
  const initData = req.headers['x-telegram-init'];
  console.log(`[Telegram Auth] Path: ${req.path}, InitData length: ${initData ? initData.length : 0}, Has initData: ${!!initData}`);
  if (initData) {
    console.log(`[Telegram Auth] Preview: ${initData.substring(0, 60)}...`);
  }

  // DEV_MODE: skip verification, return a mock user
  if (DEV_MODE) {
    if (initData) {
      try {
        const urlParams = new URLSearchParams(initData);
        const userRaw = urlParams.get('user');
        if (userRaw) return JSON.parse(userRaw);
      } catch { }
    }
    return { id: 1, username: 'dev_user', first_name: 'Dev' };
  }

  if (!verifyInitData(initData)) {
    console.log(`[Telegram Auth] ❌ Verification failed for initData!`);
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return null;
  }
  console.log(`[Telegram Auth] ✅ Verification successful!`);
  const urlParams = new URLSearchParams(initData);
  const userRaw = urlParams.get('user');
  if (!userRaw) {
    res.status(401).json({ ok: false, error: 'No user' });
    return null;
  }
  return JSON.parse(userRaw);
}

function requireAdmin(req, res) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }
  return true;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/config', async (req, res) => {
  try {
    const maintModeSetting = await dbGet("SELECT value FROM Settings WHERE key = 'maintenance_mode'");
    const isMaintActive = maintModeSetting ? maintModeSetting.value === 'true' : false;
    res.json({ ok: true, botUsername, maintenanceMode: isMaintActive });
  } catch (err) {
    res.json({ ok: true, botUsername, maintenanceMode: false });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const date = req.query.date;
    if (!date) return res.json({ ok: false, error: 'Missing date' });

    const user = await getOrCreateUser(tgUser);
    const bookings = await dbAll('SELECT * FROM Bookings WHERE date = ? AND status = ?', [date, 'active']);

    const settingsLimit = await dbGet("SELECT value FROM Settings WHERE key = 'monthly_limit'");
    const globalLimit = settingsLimit ? parseInt(settingsLimit.value) : 12;
    const userLimit = user.monthly_limit !== null ? user.monthly_limit : globalLimit;

    const currentMonth = date.substring(0, 7); // YYYY-MM
    const monthlyCount = await dbGet(
      "SELECT COUNT(*) as count FROM Bookings WHERE user_id = ? AND date LIKE ? AND status = 'active'",
      [user.id, `${currentMonth}%`]
    );

    const settings = await dbAll('SELECT * FROM Settings');
    const sMap = {};
    settings.forEach(s => sMap[s.key] = s.value);

    res.json({
      ok: true,
      user: { id: user.id, username: user.username, full_name: user.full_name, is_registered: !!user.is_registered },
      balance: user.balance,
      is_privileged: !!user.is_privileged,
      bookings,
      monthly_usage: monthlyCount.count,
      monthly_limit: userLimit,
      settings: {
        price_per_wash: Number(sMap.price_per_wash || 50),
        price_per_wash_privileged: Number(sMap.price_per_wash_privileged || 30),
        subscription_price: Number(sMap.subscription_price || 150),
        subscription_price_privileged: Number(sMap.subscription_price_privileged || 100),
        subscription_washes_count: Number(sMap.subscription_washes_count || 8)
      }
    });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const { full_name, is_privileged_request } = req.body || {};
    if (!full_name || full_name.trim().length < 3) {
      return res.json({ ok: false, error: 'Введіть коректне ПІБ' });
    }

    const user = await getOrCreateUser(tgUser);
    await dbRun('UPDATE Users SET full_name = ?, is_registered = 1 WHERE id = ?', [full_name.trim(), user.id]);

    // If user claims to have privileges, they still need to send photo to bot
    // but we can mark it or just let them know.

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/profile/request', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const { full_name } = req.body || {};
    if (!full_name || full_name.trim().length < 3) {
      return res.json({ ok: false, error: 'Введіть коректне ПІБ' });
    }

    const user = await getOrCreateUser(tgUser);
    await dbRun('INSERT INTO ProfileChangeRequests (user_id, new_full_name) VALUES (?, ?)', [user.id, full_name.trim()]);
    
    // Notify admin
    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'REPLACE_WITH_YOUR_TELEGRAM_ID') {
      bot.sendMessage(ADMIN_CHAT_ID, `📝 Запит на зміну ПІБ від @${user.username || user.id}: "${full_name.trim()}". Перевірте адмін-панель.`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/guard/bookings', async (req, res) => {
  try {
    const today = getLocalDateString();
    
    const bookings = await dbAll(
      `SELECT b.*, u.full_name, u.username, m.name as machine_name 
       FROM Bookings b
       JOIN Users u ON b.user_id = u.id
       JOIN Machines m ON b.machine_id = m.id
       WHERE b.date = ? AND b.status = 'active'
       ORDER BY b.time_slot ASC`,
      [today]
    );
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/book', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const { date, time_slot, machine_id } = req.body || {};
    if (!date || !time_slot || !machine_id) {
      return res.json({ ok: false, error: 'Missing fields' });
    }
    if (!TIME_SLOTS.includes(time_slot)) {
      return res.json({ ok: false, error: 'Invalid time slot' });
    }

    const today = getLocalDateString();
    if (date < today) {
      return res.json({ ok: false, error: 'Не можна бронювати на минулу дату' });
    }

    // Restrict bookings to the current month only
    const [bookingYear, bookingMonth] = date.split('-').map(Number);
    const now = new Date();
    const currY = now.getFullYear();
    const currM = now.getMonth() + 1; // 1-indexed

    if (bookingYear !== currY || bookingMonth !== currM) {
      return res.json({ ok: false, error: 'Бронювання дозволено тільки на поточний місяць' });
    }

    if (date === today) {
      const now = new Date();
      // time_slot format "07:00–09:30" (note the en-dash or hyphen, check previous view_file)
      // Actually from view_file: '07:00–09:30' (en-dash)
      const startTimeStr = time_slot.split('–')[0]; 
      const [hour, min] = startTimeStr.split(':').map(Number);
      const slotTime = new Date();
      slotTime.setHours(hour, min, 0, 0);
      
      if (now > slotTime) {
        return res.json({ ok: false, error: 'Цей час уже пройшов' });
      }
    }

    const user = await getOrCreateUser(tgUser);
    if (!user.is_registered) {
      return res.json({ ok: false, error: 'Будь ласка, зареєструйтесь спочатку' });
    }

    const currentMonth = date.substring(0, 7); // YYYY-MM
    const monthlyCount = await dbGet(
      "SELECT COUNT(*) as count FROM Bookings WHERE user_id = ? AND date LIKE ? AND status = 'active'",
      [user.id, `${currentMonth}%`]
    );

    const settingsLimit = await dbGet("SELECT value FROM Settings WHERE key = 'monthly_limit'");
    const globalLimit = settingsLimit ? parseInt(settingsLimit.value) : 12;
    const userLimit = user.monthly_limit !== null ? user.monthly_limit : globalLimit;

    if (monthlyCount.count >= userLimit) {
      return res.json({ ok: false, error: `Ви вичерпали ліміт бронювань на цей місяць (макс. ${userLimit})` });
    }

    if (user.balance <= 0) {
      return res.json({ ok: false, error: 'Недостатньо прань' });
    }

    const existing = await dbGet(
      'SELECT * FROM Bookings WHERE date = ? AND time_slot = ? AND machine_id = ? AND status = ?',
      [date, time_slot, machine_id, 'active']
    );
    if (existing) {
      return res.json({ ok: false, error: 'Слот зайнято' });
    }

    await dbRun('INSERT INTO Bookings (user_id, machine_id, date, time_slot, status) VALUES (?, ?, ?, ?, ?)', [
      user.id,
      machine_id,
      date,
      time_slot,
      'active'
    ]);

    await dbRun('UPDATE Users SET balance = balance - 1 WHERE id = ?', [user.id]);
    
    // Notify user via Bot
    const msg = `✅ Бронювання успішне!\n🧺 Пралка: №${machine_id}\n📅 Дата: ${date}\n🕒 Час: ${time_slot}`;
    bot.sendMessage(user.id, msg).catch(e => console.error('Bot notify error:', e.message));

    // Notify all clients to refresh
    io.emit('update');
    
    res.json({ ok: true });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.json({ ok: false, error: 'Слот уже зайнято' });
    }
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/book/cancel', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const { date, time_slot, machine_id } = req.body || {};
    if (!date || !time_slot || !machine_id) {
      return res.json({ ok: false, error: 'Missing fields' });
    }

    const user = await getOrCreateUser(tgUser);
    if (!user.is_registered) {
      return res.json({ ok: false, error: 'Будь ласка, зареєструйтесь спочатку' });
    }

    // Check if the date is in the past
    const today = getLocalDateString();
    if (date < today) {
      return res.json({ ok: false, error: 'Не можна скасувати минулі бронювання' });
    }

    if (date === today) {
      const now = new Date();
      // Use the correct separator for time slot
      const startTimeStr = time_slot.split(/[–-]/)[0].trim(); // Matches both en-dash and hyphen
      const [hour, min] = startTimeStr.split(':').map(Number);
      const bookingTime = new Date();
      bookingTime.setHours(hour, min, 0, 0);
      
      if ((bookingTime - now) / 60000 < 30) {
        return res.json({ ok: false, error: 'Скасування неможливе менше ніж за 30 хв до початку' });
      }
    }

    // Check if the booking exists and belongs to the user
    const existing = await dbGet(
      'SELECT * FROM Bookings WHERE date = ? AND time_slot = ? AND machine_id = ? AND user_id = ? AND status = ?',
      [date, time_slot, machine_id, user.id, 'active']
    );

    if (!existing) {
      return res.json({ ok: false, error: 'Бронювання не знайдено або воно не ваше' });
    }

    // Mark as cancelled
    await dbRun('UPDATE Bookings SET status = ? WHERE id = ?', ['cancelled', existing.id]);

    // Return wash
    await dbRun('UPDATE Users SET balance = balance + 1 WHERE id = ?', [user.id]);

    // Notify user via Bot
    const cancelMsg = `❌ Бронювання скасовано:\n🧺 Пралка: №${machine_id}\n📅 Дата: ${date}\n🕒 Час: ${time_slot}`;
    bot.sendMessage(user.id, cancelMsg).catch(e => console.error('Bot notify error:', e.message));

    // Notify all clients to refresh
    io.emit('update');

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/payments/create', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const user = await getOrCreateUser(tgUser);
    if (!user.is_registered) {
      return res.json({ ok: false, error: 'Будь ласка, зареєструйтесь спочатку' });
    }

    const { washes } = req.body || {};

    const settings = await dbAll('SELECT * FROM Settings');
    const sMap = {};
    settings.forEach(s => sMap[s.key] = s.value);

    const isPriv = !!user.is_privileged;
    const pricePerWash = Number(isPriv ? (sMap.price_per_wash_privileged || 30) : (sMap.price_per_wash || 50));
    const subPrice = Number(isPriv ? (sMap.subscription_price_privileged || 100) : (sMap.subscription_price || 150));
    const subWashes = Number(sMap.subscription_washes_count || 8);

    if (![1, subWashes].includes(Number(washes))) {
      return res.json({ ok: false, error: 'Invalid washes' });
    }

    let amount = pricePerWash;
    let washesAdded = 1;

    if (Number(washes) === subWashes) {
      amount = subPrice;
      washesAdded = subWashes;
    } else {
      amount = pricePerWash;
      washesAdded = 1;
    }

    const paymentKey = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // +30 mins

    await dbRun(
      'INSERT INTO Transactions (id, userId, requestedAmount, paymentKey, status, expiresAt, washesAdded) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, user.id, amount, paymentKey, 'PENDING', expiresAt, washesAdded]
    );

    const amountInKopecks = amount;
    const deepLink = MONOBANK_JAR_ID
      ? `https://send.monobank.ua/jar/${MONOBANK_JAR_ID}?a=${amountInKopecks}&t=${paymentKey}`
      : `https://send.monobank.ua/jar/dummy?a=${amountInKopecks}&t=${paymentKey}`;

    res.json({ ok: true, paymentKey, deepLink, expiresAt });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/webhooks/monobank', (req, res) => {
  res.status(200).send('OK');
});

app.post('/api/webhooks/monobank', async (req, res) => {
  res.status(200).send('OK');

  try {
    const data = req.body;
    console.log('[Monobank Webhook] Received data:', JSON.stringify(data));
    
    let tx = null;
    if (data) {
      if (data.data && data.data.statementItem) {
        tx = data.data.statementItem;
      } else if (data.statementItem) {
        tx = data.statementItem;
      }
    }

    if (!tx) {
      console.log('[Monobank Webhook] Missing statementItem in body.data or body');
      return;
    }

    const amount = tx.amount / 100;
    const comment = tx.comment ? tx.comment.trim().toUpperCase() : '';
    const monoId = tx.id;
    const senderName = tx.senderName || '';

    console.log(`[Monobank Webhook] Processing TX: ${amount}грн, Comment: "${comment}", Sender: ${senderName}`);

    if (!comment) {
      console.log('[Monobank Webhook] No comment, saving to unresolved');
      await saveUnresolved(monoId, amount, senderName, comment);
      return;
    }

    const existingTx = await dbGet(
      "SELECT * FROM Transactions WHERE paymentKey = ? AND status = ? AND expiresAt > datetime('now')",
      [comment, 'PENDING']
    );

    if (existingTx) {
      if (Math.abs(amount - existingTx.requestedAmount) >= 0.01) {
        console.log(`[Monobank Webhook] Mismatched amount for ${comment}: expected ${existingTx.requestedAmount}, got ${amount}. Saving to unresolved.`);
        await saveUnresolved(monoId, amount, senderName, comment);
        bot.sendMessage(existingTx.userId, `⚠️ Отримано платіж на суму ${amount} грн, але очікувалось ${existingTx.requestedAmount} грн. Переказ збережено як нерозпізнаний. Зверніться до адміністратора.`).catch(console.error);
        return;
      }
      console.log(`[Monobank Webhook] Found matching transaction for ${comment}. Crediting ${existingTx.washesAdded} washes.`);
      await dbRun("UPDATE Transactions SET status = ?, actualAmount = ?, updatedAt = datetime('now') WHERE id = ?", ['SUCCESS', amount, existingTx.id]);
      await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [existingTx.washesAdded, existingTx.userId]);
      bot.sendMessage(existingTx.userId, `✅ Оплату ${amount} грн отримано! Додано ${existingTx.washesAdded} прань.`).catch(console.error);
    } else {
      console.log(`[Monobank Webhook] No matching pending transaction for "${comment}". Saving to unresolved.`);
      await saveUnresolved(monoId, amount, senderName, comment);
    }
  } catch (err) {
    console.error('[Monobank Webhook] Error:', err);
  }
});

async function saveUnresolved(monoId, amount, senderName, comment) {
  try {
    const id = randomUUID();
    await dbRun(
      'INSERT INTO UnresolvedPayments (id, monobankTransactionId, amount, senderName, comment, status) VALUES (?, ?, ?, ?, ?, ?)',
      [id, monoId, amount, senderName, comment, 'UNCLAIMED']
    );
  } catch (err) {
    // Ignore unique constraint if already processed
  }
}

app.post('/api/payments/claim', async (req, res) => {
  try {
    const tgUser = requireTelegram(req, res);
    if (!tgUser) return;

    const { query: searchQuery } = req.body || {};
    if (!searchQuery) return res.json({ ok: false, error: 'Вкажіть суму або код оплати' });

    const user = await getOrCreateUser(tgUser);
    const cleanQuery = searchQuery.trim().toUpperCase();

    // Check if it's a 6-character code
    const isCode = /^[A-Z0-9]{6}$/.test(cleanQuery);

    if (isCode) {
      // 1. Search in Transactions
      const tx = await dbGet("SELECT * FROM Transactions WHERE paymentKey = ?", [cleanQuery]);
      if (!tx) {
        return res.json({ ok: false, error: 'Оплату з цим кодом не знайдено в системі' });
      }
      if (tx.status === 'SUCCESS') {
        return res.json({ ok: true, message: 'Цей платіж уже успішно зараховано!' });
      }

      // 2. Search in UnresolvedPayments
      const unresolved = await dbGet("SELECT * FROM UnresolvedPayments WHERE comment = ? AND status = 'UNCLAIMED'", [cleanQuery]);
      if (unresolved) {
        if (Math.abs(unresolved.amount - tx.requestedAmount) >= 0.01) {
          return res.json({ ok: false, error: `Сума платежу в банку (${unresolved.amount} грн) не збігається з очікуваною (${tx.requestedAmount} грн).` });
        }
        // Credit it
        await dbRun("UPDATE UnresolvedPayments SET status = 'CLAIMED' WHERE id = ?", [unresolved.id]);
        await dbRun("UPDATE Transactions SET status = 'SUCCESS', actualAmount = ?, updatedAt = datetime('now') WHERE id = ?", [unresolved.amount, tx.id]);
        await dbRun("UPDATE Users SET balance = balance + ? WHERE id = ?", [tx.washesAdded, user.id]);
        return res.json({ ok: true, message: `Оплату знайдено! Нараховано ${tx.washesAdded} прань.` });
      }

      // 3. Try to fetch fresh statements from Monobank to find it
      const jarId = await getMonoJarId();
      if (jarId) {
        const now = Math.floor(Date.now() / 1000);
        const fromTime = now - 12 * 60 * 60; // search last 12 hours
        const statement = await monoApiGet(`/personal/statement/${jarId}/${fromTime}/${now}`);
        if (Array.isArray(statement)) {
          const matchedTx = statement.find(t => t.comment && t.comment.trim().toUpperCase() === cleanQuery);
          if (matchedTx) {
            const amount = matchedTx.amount / 100;
            if (Math.abs(amount - tx.requestedAmount) >= 0.01) {
              return res.json({ ok: false, error: `Сума платежу в банку (${amount} грн) не збігається з очікуваною (${tx.requestedAmount} грн).` });
            }
            const monoId = matchedTx.id;
            
            const already = await dbGet('SELECT id FROM UnresolvedPayments WHERE monobankTransactionId = ?', [monoId]);
            if (!already) {
              await dbRun("UPDATE Transactions SET status = 'SUCCESS', actualAmount = ?, updatedAt = datetime('now') WHERE id = ?", [amount, tx.id]);
              await dbRun("UPDATE Users SET balance = balance + ? WHERE id = ?", [tx.washesAdded, user.id]);
              
              const uuid = randomUUID();
              await dbRun(
                "INSERT INTO UnresolvedPayments (id, monobankTransactionId, amount, senderName, comment, status) VALUES (?, ?, ?, ?, ?, 'CLAIMED')",
                [uuid, monoId, amount, matchedTx.description || '', cleanQuery]
              );
              return res.json({ ok: true, message: `Оплату знайдено в банку та зараховано! Нараховано ${tx.washesAdded} прань.` });
            }
          }
        }
      }

      return res.json({ ok: false, error: 'Платіж не знайдено в банку. Перевірте статус у Monobank або зачекайте 1-2 хвилини.' });

    } else {
      // Treat as amount search
      const exactAmount = Number(cleanQuery);
      if (isNaN(exactAmount) || exactAmount <= 0) {
        return res.json({ ok: false, error: 'Введіть коректну суму або 6-значний код' });
      }

      // Search UnresolvedPayments in the last 24 hours
      const lost = await dbAll(
        "SELECT * FROM UnresolvedPayments WHERE amount = ? AND status = 'UNCLAIMED' AND receivedAt >= datetime('now', '-24 hours')",
        [exactAmount]
      );

      if (lost.length === 1) {
        const lostTx = lost[0];
        await dbRun("UPDATE UnresolvedPayments SET status = 'CLAIMED' WHERE id = ?", [lostTx.id]);

        const settings = await dbAll('SELECT * FROM Settings');
        const sMap = {};
        settings.forEach(s => sMap[s.key] = s.value);

        const isPriv = !!user.is_privileged;
        const subPrice = Number(isPriv ? (sMap.subscription_price_privileged || 100) : (sMap.subscription_price || 150));
        const subWashes = Number(sMap.subscription_washes_count || 8);

        let washesAdded = 1;
        if (exactAmount >= subPrice) {
          washesAdded = subWashes;
        }

        await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [washesAdded, user.id]);
        res.json({ ok: true, message: `Оплату знайдено та зараховано! Додано ${washesAdded} прань.` });
      } else if (lost.length > 1) {
        res.json({ ok: false, error: 'Знайдено кілька схожих платежів на цю суму. Зверніться до підтримки.' });
      } else {
        res.json({ ok: false, error: 'Оплату не знайдено за останні 24 години. Спробуйте пошук за кодом оплати.' });
      }
    }

  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Server error' });
  }
});

setInterval(() => {
  dbRun("UPDATE Transactions SET status = 'EXPIRED', updatedAt = datetime('now') WHERE status = 'PENDING' AND expiresAt < datetime('now')")
    .catch(console.error);
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// MONOBANK REAL-TIME POLLING (fallback for webhooks)
// ─────────────────────────────────────────────

const https = require('https');

function monoApiGet(path) {
  return new Promise((resolve, reject) => {
    if (!process.env.MONOBANK_API_TOKEN) return resolve(null);
    const req = https.request({
      hostname: 'api.monobank.ua',
      path,
      method: 'GET',
      headers: { 'X-Token': process.env.MONOBANK_API_TOKEN }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Cache jar internal ID to avoid repeated API calls
let cachedJarId = null;

async function getMonoJarId() {
  if (cachedJarId) return cachedJarId;
  const info = await monoApiGet('/personal/client-info');
  if (!info || !info.jars) return null;
  // Find jar named "апз" or first jar
  const jar = info.jars.find(j => j.title.toLowerCase().includes('апз')) || info.jars[0];
  if (jar) cachedJarId = jar.id;
  return cachedJarId;
}

// Process a single Monobank transaction (same logic as webhook)
async function processMonoTransaction(tx) {
  const amount = tx.amount / 100;
  const comment = tx.comment ? tx.comment.trim().toUpperCase() : '';
  const monoId = tx.id;

  // Check already processed
  const already = await dbGet('SELECT id FROM UnresolvedPayments WHERE monobankTransactionId = ?', [monoId]);
  const alreadySuccess = await dbGet("SELECT id FROM Transactions WHERE status = 'SUCCESS' AND paymentKey = ?", [comment]);
  if (already || alreadySuccess) return; // skip duplicates

  if (!comment) {
    await saveUnresolved(monoId, amount, tx.description || '', comment);
    return;
  }

  const existingTx = await dbGet(
    "SELECT * FROM Transactions WHERE paymentKey = ? AND status = ? AND expiresAt > datetime('now')",
    [comment, 'PENDING']
  );

  if (existingTx) {
    if (Math.abs(amount - existingTx.requestedAmount) >= 0.01) {
      console.log(`[Monobank Poller] Mismatched amount for ${comment}: expected ${existingTx.requestedAmount}, got ${amount}. Saving to unresolved.`);
      await saveUnresolved(monoId, amount, tx.description || '', comment);
      bot.sendMessage(existingTx.userId, `⚠️ Отримано платіж на суму ${amount} грн, але очікувалось ${existingTx.requestedAmount} грн. Переказ збережено як нерозпізнаний. Зверніться до адміністратора.`).catch(console.error);
      return;
    }
    await dbRun("UPDATE Transactions SET status = ?, actualAmount = ?, updatedAt = datetime('now') WHERE id = ?", ['SUCCESS', amount, existingTx.id]);
    await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [existingTx.washesAdded, existingTx.userId]);
    console.log(`[Monobank Poller] Зараховано ${amount} грн (${comment}) → +${existingTx.washesAdded} прань`);
  } else {
    await saveUnresolved(monoId, amount, tx.description || '', comment);
    console.log(`[Monobank Poller] Незнайомий платіж ${amount} грн збережено як Unresolved`);
  }
}

// Poll every 60 seconds
let lastPollTime = Math.floor(Date.now() / 1000) - 24 * 60 * 60; // start 24 hours back to recover offline payments

async function pollMonobank() {
  const jarId = await getMonoJarId();
  if (!jarId) return;

  const now = Math.floor(Date.now() / 1000);
  const statement = await monoApiGet(`/personal/statement/${jarId}/${lastPollTime}/${now}`);
  lastPollTime = now;

  if (!Array.isArray(statement) || statement.length === 0) return;

  for (const tx of statement) {
    if (tx.amount > 0) { // only incoming
      await processMonoTransaction(tx).catch(console.error);
    }
  }
}

// Auto-register webhook on startup with retries
async function registerWebhook(retryCount = 0) {
  if (!process.env.MONOBANK_API_TOKEN || !WEBAPP_URL) {
    console.warn('[Monobank] Skip registration: Missing token or URL');
    return;
  }
  const webhookUrl = `${WEBAPP_URL}/api/webhooks/monobank`;
  const body = JSON.stringify({ webHookUrl: webhookUrl });
  
  console.log(`[Monobank] Registering webhook (attempt ${retryCount + 1}): ${webhookUrl}...`);
  
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.monobank.ua',
      path: '/personal/webhook',
      method: 'POST',
      headers: {
        'X-Token': process.env.MONOBANK_API_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[Monobank] ✅ Вебхук успішно зареєстровано!`);
          resolve(true);
        } else {
          console.error(`[Monobank] ❌ Помилка реєстрації (${res.statusCode}):`, data);
          if (retryCount < 5) {
            console.log(`[Monobank] Повтор через 10 сек...`);
            setTimeout(() => resolve(registerWebhook(retryCount + 1)), 10000);
          } else {
            resolve(false);
          }
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[Monobank] ❌ Помилка мережі при реєстрації:', e.message);
      if (retryCount < 5) {
        setTimeout(() => resolve(registerWebhook(retryCount + 1)), 10000);
      } else {
        resolve(false);
      }
    });
    req.write(body);
    req.end();
  });
}

// Start polling after 10s delay (let server and tunnel boot), then every 60s
setTimeout(async () => {
  broadcastNewLink(); // Don't await, let it run in background
  await registerWebhook();
  await pollMonobank(); // immediate first poll
  setInterval(pollMonobank, 60 * 1000);
}, 10000);

// ─────────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────────

app.get('/api/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const users = await dbAll('SELECT id, username, full_name, role, is_privileged, balance, is_registered FROM Users ORDER BY id DESC');
    res.json({ ok: true, users });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/balance', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { userId, delta } = req.body || {};
    if (!userId || delta === undefined) return res.json({ ok: false, error: 'Missing userId or delta' });
    await dbRun('UPDATE Users SET balance = MAX(0, balance + ?) WHERE id = ?', [Number(delta), userId]);
    const user = await dbGet('SELECT id, username, full_name, balance FROM Users WHERE id = ?', [userId]);
    res.json({ ok: true, user });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/privilege', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { userId, value } = req.body || {};
    if (!userId) return res.json({ ok: false, error: 'Missing userId' });
    await dbRun('UPDATE Users SET is_privileged = ? WHERE id = ?', [value ? 1 : 0, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { userId } = req.body || {};
    if (!userId) return res.json({ ok: false, error: 'Missing userId' });
    await dbRun('DELETE FROM SentNotifications WHERE booking_id IN (SELECT id FROM Bookings WHERE user_id = ?)', [userId]);
    await dbRun('DELETE FROM ProfileChangeRequests WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM PrivilegeRequests WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM Bookings WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM Transactions WHERE userId = ?', [userId]);
    await dbRun('DELETE FROM Payments WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM Users WHERE id = ?', [userId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/update_name', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { userId, fullName } = req.body || {};
    if (!userId || !fullName) return res.json({ ok: false, error: 'Missing fields' });
    await dbRun('UPDATE Users SET full_name = ? WHERE id = ?', [fullName, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/limit', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { userId, limit } = req.body || {};
    const val = limit === '' || limit === null ? null : parseInt(limit);
    await dbRun('UPDATE Users SET monthly_limit = ? WHERE id = ?', [val, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/bookings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const bookings = await dbAll(
      `SELECT b.*, u.username, u.full_name FROM Bookings b
       LEFT JOIN Users u ON b.user_id = u.id
       ORDER BY b.date DESC, b.time_slot ASC
       LIMIT 200`
    );
    res.json({ ok: true, bookings });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/bookings/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { bookingId } = req.body || {};
    if (!bookingId) return res.json({ ok: false, error: 'Missing bookingId' });
    await dbRun('DELETE FROM Bookings WHERE id = ?', [bookingId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txs = await dbAll(
      `SELECT t.*, u.username, u.full_name FROM Transactions t
       LEFT JOIN Users u ON t.userId = u.id
       ORDER BY t.createdAt DESC LIMIT 200`
    );
    const unresolved = await dbAll('SELECT * FROM UnresolvedPayments ORDER BY receivedAt DESC LIMIT 100');
    res.json({ ok: true, transactions: txs, unresolved });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/unresolved/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { paymentId, userId, washesAdded } = req.body || {};
    if (!paymentId || !userId || !washesAdded) return res.json({ ok: false, error: 'Missing fields' });
    await dbRun("UPDATE UnresolvedPayments SET status = 'CLAIMED' WHERE id = ?", [paymentId]);
    await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [washesAdded, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});



app.get('/api/admin/reports', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { startDate, endDate } = req.query || {};
    let query = `
      SELECT b.*, u.username, u.full_name 
      FROM Bookings b
      JOIN Users u ON b.user_id = u.id
    `;
    const params = [];
    if (startDate && endDate) {
      query += ` WHERE b.date BETWEEN ? AND ? `;
      params.push(startDate, endDate);
    }
    query += ` ORDER BY b.date DESC, b.time_slot ASC `;
    
    const bookings = await dbAll(query, params);
    res.json({ ok: true, bookings });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const settings = await dbAll('SELECT * FROM Settings');
    const map = {};
    settings.forEach(s => map[s.key] = s.value);
    res.json({ ok: true, settings: map });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/settings/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { key, value } = req.body || {};
    await dbRun('INSERT INTO Settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [key, value, value]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});



app.get('/api/admin/privilege_requests', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const requests = await dbAll(
      `SELECT p.*, u.username, u.full_name FROM PrivilegeRequests p
       LEFT JOIN Users u ON p.user_id = u.id
       ORDER BY p.created_at DESC LIMIT 100`
    );
    res.json({ ok: true, requests });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/privilege_requests/resolve', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { requestId, status } = req.body || {};
    if (!requestId || !status) return res.json({ ok: false, error: 'Missing fields' });

    const request = await dbGet('SELECT * FROM PrivilegeRequests WHERE id = ?', [requestId]);
    if (!request) return res.json({ ok: false, error: 'Not found' });

    await dbRun('UPDATE PrivilegeRequests SET status = ? WHERE id = ?', [status, requestId]);

    if (status === 'approved') {
      await dbRun('UPDATE Users SET is_privileged = 1 WHERE id = ?', [request.user_id]);
      bot.sendMessage(request.user_id, '✅ Вашу заявку на пільгу схвалено! Ціни оновлено.').catch(console.error);
    } else if (status === 'rejected') {
      bot.sendMessage(request.user_id, '❌ Вашу заявку на пільгу відхилено.').catch(console.error);
    }

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/telegram_file', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { file_id } = req.query;
    if (!file_id) return res.status(400).json({ error: 'Missing file_id' });

    const https = require('https');

    // 1. Get file path from Telegram
    const pathPromise = new Promise((resolve, reject) => {
      https.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result.file_path);
            else reject(new Error(parsed.description));
          } catch (e) { reject(e); }
        });
      }).on("error", reject);
    });

    const filePath = await pathPromise;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});



const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Delete webhook to avoid conflict with polling
bot.deleteWebHook().then(() => {
  console.log('Old webhooks deleted. Starting polling...');
}).catch(err => console.error('Error deleting webhook:', err.message));

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const currentButton = await bot.getChatMenuButton({ chat_id: chatId });
    if (!currentButton || currentButton.type !== 'web_app' || !currentButton.web_app || currentButton.web_app.url !== WEBAPP_URL) {
      await bot.setChatMenuButton({
        chat_id: chatId,
        menu_button: {
          type: 'web_app',
          text: 'Пральня 🧺',
          web_app: { url: WEBAPP_URL }
        }
      });
      console.log(`Menu button updated for chat ${chatId}`);
    }
  } catch (e) { console.error('Menu update error:', e.message); }

  bot.sendMessage(
    chatId,
    'Вітаю! Для відкриття додатка скористайтеся фіксованою кнопкою внизу екрана "🚀 ВІДКРИТИ ПРАЛЬНЮ" або синьою кнопкою зліва від поля введення повідомлень:',
    {
      reply_markup: {
        keyboard: [
          [
            {
              text: '🚀 ВІДКРИТИ ПРАЛЬНЮ',
              web_app: { url: WEBAPP_URL }
            }
          ]
        ],
        resize_keyboard: true,
        is_persistent: true
      }
    }
  );
});

// Update menu globally on startup
bot.getMe().then(async (me) => {
  botUsername = me.username;
  console.log('Bot username:', botUsername);
  try {
    const currentButton = await bot.getChatMenuButton();
    if (!currentButton || currentButton.type !== 'web_app' || !currentButton.web_app || currentButton.web_app.url !== WEBAPP_URL) {
      await bot.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Пральня 🧺',
          web_app: { url: WEBAPP_URL }
        }
      });
      console.log('Global menu button updated');
    } else {
      console.log('Global menu button is already up-to-date');
    }
  } catch (err) {
    console.error('Global menu update error:', err.message);
  }
}).catch(console.error);

bot.on('photo', async (msg) => {
  try {
    const chatId = msg.chat.id;
    // Get highest resolution photo
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    const user = await getOrCreateUser(msg.from);
    await dbRun('INSERT INTO PrivilegeRequests (user_id, photo_file_id) VALUES (?, ?)', [user.id, fileId]);

    bot.sendMessage(chatId, '📸 Вашу заявку (фото) прийнято! Очікуйте підтвердження адміністратором.');

    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'REPLACE_WITH_YOUR_TELEGRAM_ID') {
      bot.sendMessage(ADMIN_CHAT_ID, `🆕 Нова заявка на пільгу від @${user.username || user.id} (ID: ${user.id}). Перевірте адмін-панель.`);
    }
  } catch (err) {
    console.error('Error handling photo:', err);
  }
});

bot.onText(/\/set_privilege\s+@?(\w+)/, async (msg, match) => {
  try {
    if (!ADMIN_CHAT_ID || String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const username = match[1];
    const user = await dbGet('SELECT * FROM Users WHERE username = ?', [username]);
    if (!user) return bot.sendMessage(msg.chat.id, 'Користувача не знайдено');
    await dbRun('UPDATE Users SET is_privileged = 1 WHERE id = ?', [user.id]);
    bot.sendMessage(msg.chat.id, `@${username} тепер пільговик`);
  } catch (err) {
    console.error(err);
  }
});

bot.onText(/\/add_balance\s+@?(\w+)\s+(\d+)/, async (msg, match) => {
  try {
    if (!ADMIN_CHAT_ID || String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const username = match[1];
    const amount = Number(match[2]);
    const user = await dbGet('SELECT * FROM Users WHERE username = ?', [username]);
    if (!user) return bot.sendMessage(msg.chat.id, 'Користувача не знайдено');
    await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [amount, user.id]);
    bot.sendMessage(msg.chat.id, `Баланс @${username} поповнено на ${amount}`);
    bot.sendMessage(user.id, `Ваш баланс поповнено на ${amount}`);
  } catch (err) {
    console.error(err);
  }
});

bot.on('callback_query', async (query) => {
  try {
    const data = query.data || '';
    if (data.startsWith('paid:')) {
      const paymentId = Number(data.split(':')[1]);
      const payment = await dbGet('SELECT * FROM Payments WHERE id = ?', [paymentId]);
      if (!payment || payment.status !== 'pending') {
        return bot.answerCallbackQuery(query.id, { text: 'Заявка неактивна' });
      }
      if (!ADMIN_CHAT_ID) {
        return bot.answerCallbackQuery(query.id, { text: 'Адмін не налаштований' });
      }

      const user = await dbGet('SELECT * FROM Users WHERE id = ?', [payment.user_id]);
      const userTag = user?.username ? `@${user.username}` : `ID:${payment.user_id}`;

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `Заявка від ${userTag} на суму ${payment.amount} грн. Перевірте банку.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Підтвердити', callback_data: `approve:${paymentId}` },
                { text: '❌ Відхилити', callback_data: `reject:${paymentId}` }
              ]
            ]
          }
        }
      );

      await bot.answerCallbackQuery(query.id, { text: 'Заявка надіслана адміну' });
    }

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      if (!ADMIN_CHAT_ID || String(query.message.chat.id) !== String(ADMIN_CHAT_ID)) {
        return bot.answerCallbackQuery(query.id, { text: 'Тільки для адміна' });
      }

      const [action, id] = data.split(':');
      const paymentId = Number(id);
      const payment = await dbGet('SELECT * FROM Payments WHERE id = ?', [paymentId]);
      if (!payment || payment.status !== 'pending') {
        return bot.answerCallbackQuery(query.id, { text: 'Заявка неактивна' });
      }

      if (action === 'approve') {
        await dbRun('UPDATE Payments SET status = ? WHERE id = ?', ['approved', paymentId]);
        await dbRun('UPDATE Users SET balance = balance + ? WHERE id = ?', [payment.washes_added, payment.user_id]);
        await bot.sendMessage(payment.user_id, `Оплату підтверджено. Додано ${payment.washes_added} прань.`);
        await bot.answerCallbackQuery(query.id, { text: 'Підтверджено' });
      } else {
        await dbRun('UPDATE Payments SET status = ? WHERE id = ?', ['rejected', paymentId]);
        await bot.sendMessage(payment.user_id, 'Оплату відхилено. Якщо це помилка — зверніться до адміна.');
        await bot.answerCallbackQuery(query.id, { text: 'Відхилено' });
      }
    }
  } catch (err) {
    console.error(err);
  }
});

// ─────────────────────────────────────────────
// REMINDERS
// ─────────────────────────────────────────────

async function sendReminders() {
  try {
    const now = new Date();
    const todayStr = getLocalDateString(now);
    
    // Find active bookings for today
    const bookings = await dbAll("SELECT * FROM Bookings WHERE date = ? AND status = 'active'", [todayStr]);
    
    for (const b of bookings) {
      // Use regex to handle both en-dash and hyphen, and optional spaces
      const startTimeStr = b.time_slot.split(/[–-]/)[0].trim();
      const [hour, min] = startTimeStr.split(':').map(Number);
      
      const bookingTime = new Date();
      bookingTime.setHours(hour, min, 0, 0);
      
      const diffMins = (bookingTime - now) / 60000;
      
      let type = '';
      if (diffMins <= 61 && diffMins > 55) type = '1h';
      else if (diffMins <= 31 && diffMins > 25) type = '30m';
      else if (diffMins <= 11 && diffMins > 5) type = '10m';
      
      if (type) {
        const alreadySent = await dbGet('SELECT * FROM SentNotifications WHERE booking_id = ? AND type = ?', [b.id, type]);
        if (!alreadySent) {
          const msg = `🔔 Нагадування: Ваше прання о ${startTimeStr} (через ${type === '1h' ? 'годину' : type === '30m' ? '30 хв' : '10 хв'})!`;
          await bot.sendMessage(b.user_id, msg);
          await dbRun('INSERT INTO SentNotifications (booking_id, type) VALUES (?, ?)', [b.id, type]);
        }
      }
    }
  } catch (err) {
    console.error('Reminder error:', err);
  }
}

async function broadcastNewLink() {
  if (!WEBAPP_URL || WEBAPP_URL.includes('localhost')) return;
  try {
    const users = await dbAll("SELECT id FROM Users WHERE is_registered = 1");
    console.log(`[Broadcast] Sending new link to ${users.length} users...`);
    
    for (const u of users) {
      await bot.sendMessage(u.id, "🚀 Посилання на пральню оновлено! Використовуйте кнопку нижче або синю кнопку в меню:", {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Пральня 🧺', web_app: { url: WEBAPP_URL } }
          ]]
        }
      }).catch(err => {
        // Silently skip if user blocked the bot
      });
      await new Promise(r => setTimeout(r, 50));
    }
    console.log("[Broadcast] Done.");
  } catch (err) {
    console.error("[Broadcast] Error:", err);
  }
}

// Run every 1 minute for better precision
setInterval(sendReminders, 60 * 1000);

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
