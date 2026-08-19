-- SQLite schema for Laundry Booking TWA

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Users (
  id INTEGER PRIMARY KEY, -- Telegram ID
  username TEXT,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  is_privileged INTEGER DEFAULT 0,
  balance INTEGER DEFAULT 0,
  is_registered INTEGER DEFAULT 0,
  monthly_limit INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS Machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS Bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  machine_id INTEGER NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD
  time_slot TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES Users(id),
  FOREIGN KEY (machine_id) REFERENCES Machines(id)
);

CREATE TABLE IF NOT EXISTS Payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  washes_added INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES Users(id)
);

-- NEW TABLES FOR MONOBANK INTEGRATION

CREATE TABLE IF NOT EXISTS Transactions (
  id TEXT PRIMARY KEY, -- UUID
  userId INTEGER NOT NULL,
  requestedAmount REAL NOT NULL,
  actualAmount REAL,
  paymentKey TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'PENDING', -- PENDING, SUCCESS, EXPIRED
  expiresAt TEXT NOT NULL,
  washesAdded INTEGER NOT NULL,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (userId) REFERENCES Users(id)
);

CREATE TABLE IF NOT EXISTS UnresolvedPayments (
  id TEXT PRIMARY KEY, -- UUID
  monobankTransactionId TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL,
  senderName TEXT,
  comment TEXT,
  status TEXT DEFAULT 'UNCLAIMED', -- UNCLAIMED, CLAIMED
  receivedAt TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON Bookings(date, time_slot);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_booking ON Bookings(date, time_slot, machine_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS PrivilegeRequests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  photo_file_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES Users(id)
);

CREATE TABLE IF NOT EXISTS ProfileChangeRequests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  new_full_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES Users(id)
);

CREATE TABLE IF NOT EXISTS Settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Notification tracking to prevent duplicates
CREATE TABLE IF NOT EXISTS SentNotifications (
  booking_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- '1h', '30m', '10m'
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (booking_id, type)
);

-- Initialize default monthly limit
INSERT OR IGNORE INTO Settings (key, value) VALUES ('monthly_limit', '12');
