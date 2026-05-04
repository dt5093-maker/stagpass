const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

loadEnvFile();

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const MAX_LIMIT = 200;
const SESSION_COOKIE = 'hallpass_session';
const OAUTH_STATE_COOKIE = 'hallpass_oauth_state';
const SESSION_DAYS = 7;
const dbPath = process.env.DB_PATH || './passes.db';

// Function to get base URL, preferring explicit BASE_URL env var,
// then X-Forwarded headers (for reverse proxy), then constructing from request
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  
  const proto = req.get('X-Forwarded-Proto') || (req.secure ? 'https' : 'http');
  const host = req.get('X-Forwarded-Host') || req.get('Host') || 'localhost';
  return `${proto}://${host}`;
}

const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
const teacherEmails = new Set(
  (process.env.TEACHER_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const dualRoleEmails = new Set(
  (process.env.DUAL_ROLE_EMAILS || 'talbot.dylan@cheverus.org')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const allowedDomain = (process.env.ALLOWED_GOOGLE_DOMAIN || 'cheverus.org').trim().toLowerCase();
const teacherEmailPattern = new RegExp(
  process.env.TEACHER_EMAIL_PATTERN || '^[a-z]+@cheverus\\.org$',
  'i'
);
const studentEmailPattern = new RegExp(
  process.env.STUDENT_EMAIL_PATTERN || '^[a-z]+\\.[a-z]+@cheverus\\.org$',
  'i'
);

function loadEnvFile() {
  if (!fs.existsSync('.env')) return;

  const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

app.use(express.json());
app.use(express.static('public'));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      destination TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      role TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )
  `);

  const migrations = [
    ['teacher', 'TEXT'],
    ['room', 'TEXT'],
    ['notes', 'TEXT'],
    ['maxMinutes', 'INTEGER NOT NULL DEFAULT 10'],
    ['createdAt', 'INTEGER'],
    ['status', "TEXT NOT NULL DEFAULT 'approved'"],
    ['studentEmail', 'TEXT'],
    ['requestedAt', 'INTEGER'],
    ['approvedAt', 'INTEGER'],
    ['approvedByName', 'TEXT'],
    ['approvedByEmail', 'TEXT'],
    ['deniedAt', 'INTEGER'],
    ['deniedByName', 'TEXT'],
    ['deniedByEmail', 'TEXT'],
    ['deniedReason', 'TEXT'],
  ];

  migrations.forEach(([column, type]) => {
    db.run(`ALTER TABLE passes ADD COLUMN ${column} ${type}`, (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        console.error(`Could not add ${column} column:`, err.message);
      }
    });
  });

  db.run('UPDATE passes SET createdAt = startTime WHERE createdAt IS NULL');
  db.run('UPDATE passes SET requestedAt = startTime WHERE requestedAt IS NULL');
  db.run("UPDATE passes SET status = 'returned' WHERE endTime IS NOT NULL AND status = 'approved'");
});

// Socket.IO setup
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function emitPassUpdate() {
  // Emit to all connected clients that passes have been updated
  io.emit('passes-updated');
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit)) return 50;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf('=');
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1)),
        ];
      })
  );
}

function setCookie(res, name, value, options = {}) {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${encodeURIComponent(name)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function publicUser(user) {
  if (!user) return null;
  const roles = allowedRoles(user.email);
  return {
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    roles,
  };
}

function allowedRoles(email) {
  const normalizedEmail = String(email || '').toLowerCase();
  const roles = [];
  if (teacherEmails.has(normalizedEmail) || teacherEmailPattern.test(normalizedEmail) || dualRoleEmails.has(normalizedEmail)) {
    roles.push('teacher');
  }
  if (studentEmailPattern.test(normalizedEmail) || dualRoleEmails.has(normalizedEmail)) {
    roles.push('student');
  }
  return roles;
}

function userRole(email) {
  const roles = allowedRoles(email);
  if (roles.includes('student')) return 'student';
  return roles[0] || null;
}

async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const session = await get(
    `SELECT * FROM sessions
     WHERE token = ?
     AND expiresAt > ?`,
    [token, Date.now()]
  );

  return session || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in with Google first.' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function requireTeacher(req, res, next) {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required.' });
  }
  next();
}

function passResponse(pass) {
  const now = Date.now();
  const endTime = pass.endTime || null;
  const elapsedMs = (endTime || now) - pass.startTime;
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const maxMinutes = Number(pass.maxMinutes) || 10;

  return {
    ...pass,
    endTime,
    maxMinutes,
    elapsedMinutes,
    isOverdue: pass.status === 'approved' && !endTime && elapsedMinutes >= maxMinutes,
  };
}

async function loadPass(id) {
  return get('SELECT * FROM passes WHERE id = ?', [id]);
}

app.get('/api/me', async (req, res) => {
  try {
    const user = await currentUser(req);
    res.json({
      authConfigured: isGoogleConfigured(),
      allowedDomain: allowedDomain || null,
      hasTeacherList: teacherEmails.size > 0 || Boolean(teacherEmailPattern),
      redirectUri: `${getBaseUrl(req)}/auth/google/callback`,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/role', requireAuth, async (req, res) => {
  try {
    const desiredRole = String(req.body.role || '').toLowerCase();
    const roles = allowedRoles(req.user.email);
    if (!roles.includes(desiredRole)) {
      return res.status(403).json({ error: 'Role change not permitted for this account.' });
    }

    if (req.user.role === desiredRole) {
      return res.json({ role: desiredRole });
    }

    const token = parseCookies(req)[SESSION_COOKIE];
    await run('UPDATE sessions SET role = ? WHERE token = ?', [desiredRole, token]);
    req.user.role = desiredRole;
    res.json({ role: desiredRole });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/google', (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(503).send('Google sign-in is not configured.');
  }

  const state = crypto.randomBytes(24).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${getBaseUrl(req)}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });

  if (allowedDomain) params.set('hd', allowedDomain);
  setCookie(res, OAUTH_STATE_COOKIE, state, { maxAge: 600 });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    if (!req.query.code || !req.query.state || req.query.state !== cookies[OAUTH_STATE_COOKIE]) {
      return res.status(400).send('Invalid Google sign-in state.');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${getBaseUrl(req)}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(401).send(tokenData.error_description || 'Google sign-in failed.');
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await userRes.json();
    if (!userRes.ok || !profile.email) {
      return res.status(401).send('Could not read Google profile.');
    }

    const email = profile.email.toLowerCase();
    const domain = email.split('@')[1] || '';
    if (allowedDomain && domain !== allowedDomain) {
      return res.status(403).send(`Use your ${allowedDomain} Google account.`);
    }

    const role = userRole(email);
    if (!role) {
      return res
        .status(403)
        .send('Use a Cheverus account formatted as lastname@cheverus.org for teachers or lastname.firstname@cheverus.org for students.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    await run(
      `INSERT INTO sessions
       (token, email, name, picture, role, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        token,
        email,
        profile.name || email,
        profile.picture || '',
        role,
        now,
        now + SESSION_DAYS * 24 * 60 * 60 * 1000,
      ]
    );

    clearCookie(res, OAUTH_STATE_COOKIE);
    setCookie(res, SESSION_COOKIE, token, {
      maxAge: SESSION_DAYS * 24 * 60 * 60,
      secure: getBaseUrl(req).startsWith('https://'),
    });
    res.redirect('/');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/auth/logout', async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await run('DELETE FROM sessions WHERE token = ?', [token]).catch(() => {});
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/passes', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM passes
       WHERE status = 'approved'
       AND endTime IS NULL
       ORDER BY startTime ASC`
    );
    res.json(rows.map(passResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', requireAuth, requireTeacher, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const rows = await all(
      `SELECT * FROM passes
       WHERE status = 'returned'
       ORDER BY endTime DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows.map(passResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [active, overdue, today, pending, average] = await Promise.all([
      get("SELECT COUNT(*) AS count FROM passes WHERE status = 'approved' AND endTime IS NULL"),
      get(
        `SELECT COUNT(*) AS count FROM passes
         WHERE status = 'approved'
         AND endTime IS NULL
         AND (? - startTime) >= (maxMinutes * 60000)`,
        [Date.now()]
      ),
      get('SELECT COUNT(*) AS count FROM passes WHERE requestedAt >= ?', [
        todayStart.getTime(),
      ]),
      get("SELECT COUNT(*) AS count FROM passes WHERE status = 'pending'"),
      get(
        `SELECT AVG((endTime - startTime) / 60000.0) AS minutes
         FROM passes
         WHERE status = 'returned'`
      ),
    ]);

    res.json({
      active: active.count,
      overdue: overdue.count,
      today: today.count,
      pending: pending.count,
      averageMinutes: average.minutes ? Math.round(average.minutes) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teachers', requireAuth, async (req, res) => {
  try {
    // Get teachers from sessions (those who have signed in)
    const sessionTeachers = await all(
      `SELECT DISTINCT name, email FROM sessions
       WHERE role = 'teacher'
       ORDER BY name ASC`
    );

    // If no teacher emails configured, return session teachers plus any dual-role teachers.
    if (teacherEmails.size === 0) {
      const teachers = [...sessionTeachers];
      dualRoleEmails.forEach((email) => {
        if (!teachers.some((teacher) => teacher.email.toLowerCase() === email)) {
          const name = email.split('@')[0].split('.').map((part) =>
            part.charAt(0).toUpperCase() + part.slice(1)
          ).join(' ');
          teachers.push({ name, email });
        }
      });
      return res.json(teachers);
    }

    // Get all teacher emails from environment plus any dual-role teachers.
    const allTeacherEmails = Array.from(new Set([...teacherEmails, ...dualRoleEmails]));

    // Create a map of email to name from sessions
    const emailToName = new Map();
    sessionTeachers.forEach(teacher => {
      emailToName.set(teacher.email.toLowerCase(), teacher.name);
    });

    // For all teacher emails, use session name if available, otherwise derive from email
    const teachers = allTeacherEmails.map(email => {
      const normalizedEmail = email.trim().toLowerCase();
      const name = emailToName.get(normalizedEmail) || email.split('@')[0].split('.').map(part => 
        part.charAt(0).toUpperCase() + part.slice(1)
      ).join(' ');
      return { name, email: normalizedEmail };
    });

    // Remove duplicates by name
    const uniqueTeachers = teachers.filter((teacher, index, self) => 
      index === self.findIndex(t => t.name === teacher.name)
    );

    res.json(uniqueTeachers.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/requests', requireAuth, requireTeacher, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM passes
       WHERE status = 'pending'
       AND teacher = ?
       ORDER BY requestedAt ASC`,
      [req.user.name]
    );
    res.json(rows.map(passResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/my/requests', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM passes
       WHERE studentEmail = ?
       ORDER BY requestedAt DESC
       LIMIT 20`,
      [req.user.email]
    );
    res.json(rows.map(passResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/search', requireAuth, requireTeacher, async (req, res) => {
  const name = cleanText(req.query.name);
  const limit = parseLimit(req.query.limit);

  if (!name) {
    return res.status(400).json({ error: 'Enter a student name to search.' });
  }

  try {
    const search = `%${escapeLike(name)}%`;
    const rows = await all(
      `SELECT * FROM passes
       WHERE name LIKE ? ESCAPE '\\'
       AND status IN ('approved', 'returned')
       ORDER BY requestedAt DESC
       LIMIT ?`,
      [search, limit]
    );

    const exactRows = rows.filter(
      (pass) => pass.name.toLowerCase() === name.toLowerCase()
    );
    const passes = exactRows.length ? exactRows : rows;
    const completed = passes.filter((pass) => pass.status === 'returned');
    const active = passes.filter((pass) => pass.status === 'approved' && !pass.endTime);
    const overdue = active.filter((pass) => passResponse(pass).isOverdue);
    const averageMinutes = completed.length
      ? Math.round(
          completed.reduce((sum, pass) => {
            return sum + Math.max(0, (pass.endTime - pass.startTime) / 60000);
          }, 0) / completed.length
        )
      : 0;

    res.json({
      query: name,
      matchedName: passes[0]?.name || null,
      summary: {
        total: passes.length,
        active: active.length,
        returned: completed.length,
        overdue: overdue.length,
        averageMinutes,
      },
      passes: passes.map(passResponse),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests', requireAuth, async (req, res) => {
  const destination = cleanText(req.body.destination);
  const room = cleanText(req.body.room);
  const notes = cleanText(req.body.notes);
  const teacher = cleanText(req.body.teacher);
  const maxMinutes = Number.parseInt(req.body.maxMinutes, 10) || 10;

  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Only student accounts can request passes.' });
  }

  if (!destination) {
    return res.status(400).json({ error: 'Destination is required.' });
  }

  if (!teacher) {
    return res.status(400).json({ error: 'Teacher is required.' });
  }

  if (maxMinutes < 1 || maxMinutes > 120) {
    return res.status(400).json({ error: 'Pass length must be between 1 and 120 minutes.' });
  }

  try {
    const existing = await get(
      `SELECT id, status FROM passes
       WHERE studentEmail = ?
       AND status IN ('pending', 'approved')
       AND endTime IS NULL`,
      [req.user.email]
    );

    if (existing) {
      return res.status(409).json({
        error: existing.status === 'pending'
          ? 'You already have a pass waiting for approval.'
          : 'You already have an active pass.',
      });
    }

    const time = Date.now();
    const result = await run(
      `INSERT INTO passes
       (name, studentEmail, destination, room, notes, teacher, maxMinutes, status, startTime, requestedAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [req.user.name, req.user.email, destination, room, notes, teacher, maxMinutes, time, time, time]
    );
    const pass = await loadPass(result.lastID);
    emitPassUpdate();
    res.status(201).json(passResponse(pass));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests/:id/approve', requireAuth, requireTeacher, async (req, res) => {
  try {
    const pass = await loadPass(req.params.id);
    if (!pass) return res.status(404).json({ error: 'Request not found.' });
    if (pass.status !== 'pending') {
      return res.status(409).json({ error: 'This request is no longer pending.' });
    }

    const activePass = await get(
      `SELECT id FROM passes
       WHERE studentEmail = ?
       AND status = 'approved'
       AND endTime IS NULL`,
      [pass.studentEmail]
    );
    if (activePass) {
      return res.status(409).json({ error: `${pass.name} already has an active pass.` });
    }

    const time = Date.now();
    await run(
      `UPDATE passes
       SET status = 'approved',
           teacher = ?,
           approvedByName = ?,
           approvedByEmail = ?,
           approvedAt = ?,
           startTime = ?
       WHERE id = ?`,
      [req.user.name, req.user.name, req.user.email, time, time, req.params.id]
    );
    emitPassUpdate();
    res.json(passResponse(await loadPass(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests/:id/deny', requireAuth, requireTeacher, async (req, res) => {
  const reason = cleanText(req.body.reason);

  try {
    const pass = await loadPass(req.params.id);
    if (!pass) return res.status(404).json({ error: 'Request not found.' });
    if (pass.status !== 'pending') {
      return res.status(409).json({ error: 'This request is no longer pending.' });
    }

    await run(
      `UPDATE passes
       SET status = 'denied',
           deniedByName = ?,
           deniedByEmail = ?,
           deniedAt = ?,
           deniedReason = ?
       WHERE id = ?`,
      [req.user.name, req.user.email, Date.now(), reason, req.params.id]
    );
    emitPassUpdate();
    res.json(passResponse(await loadPass(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/passes/:id/end', requireAuth, async (req, res) => {
  try {
    const pass = await loadPass(req.params.id);
    if (!pass) return res.status(404).json({ error: 'Pass not found.' });
    if (pass.status !== 'approved') {
      return res.status(409).json({ error: 'Only active passes can be returned.' });
    }
    if (req.user.role !== 'teacher' && req.user.email !== pass.studentEmail) {
      return res.status(403).json({ error: 'You can only return your own pass.' });
    }
    if (pass.endTime) return res.json(passResponse(pass));

    await run(
      `UPDATE passes
       SET endTime = ?,
           status = 'returned'
       WHERE id = ?`,
      [Date.now(), req.params.id]
    );
    emitPassUpdate();
    res.json(passResponse(await loadPass(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backward-compatible routes for the original tiny UI.
app.get('/passes', (req, res) => res.redirect(307, '/api/passes'));
app.post('/end/:id', (req, res) => res.redirect(307, `/api/passes/${req.params.id}/end`));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stag Pass running at http://localhost:${PORT}`);
});
