// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_BASE = '';
let ADMIN_SECRET = '';
let allUsers = [];
let pendingClaimId = null;

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function adminFetch(path, opts = {}) {
  return fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': ADMIN_SECRET,
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(r => r.json());
}

let toastTimer;
function toast(msg, color = '#10b981') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = color + '44';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('uk-UA', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', tryLogin);
document.getElementById('secretInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

async function tryLogin() {
  const secret = document.getElementById('secretInput').value.trim();
  if (!secret) return;
  const err = document.getElementById('login-error');
  err.textContent = '';
  ADMIN_SECRET = secret;
  try {
    const res = await adminFetch('/api/admin/users');
    if (res.ok) {
      localStorage.setItem('admin_secret', secret);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('main-app').style.display = 'flex';
      
      try {
        const config = await fetch('/api/config').then(r => r.json());
        if (config.ok && config.botUsername) {
          const btn = document.getElementById('openBotLink');
          btn.href = `https://t.me/${config.botUsername}`;
          btn.style.display = 'inline-block';
        }
      } catch (e) {}

      loadAll();
    } else {
      err.textContent = 'Невірний ключ доступу';
      ADMIN_SECRET = '';
    }
  } catch {
    err.textContent = 'Помилка з\'єднання з сервером';
    ADMIN_SECRET = '';
  }
}

// Auto-login from localStorage
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('admin_secret');
  if (saved) {
    document.getElementById('secretInput').value = saved;
    ADMIN_SECRET = saved;
    adminFetch('/api/admin/users').then(res => {
      if (res.ok) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';
        
        fetch('/api/config').then(r => r.json()).then(config => {
          if (config.ok && config.botUsername) {
            const btn = document.getElementById('openBotLink');
            btn.href = `https://t.me/${config.botUsername}`;
            btn.style.display = 'inline-block';
          }
        }).catch(() => {});

        loadAll();
      } else {
        localStorage.removeItem('admin_secret');
        ADMIN_SECRET = '';
      }
    }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ─────────────────────────────────────────────
// LOAD ALL DATA
// ─────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadUsers(), loadBookings(), loadPayments(), loadPrivileges(), loadSettings(), loadMachines()]);
}

// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────
async function loadUsers() {
  const res = await adminFetch('/api/admin/users');
  if (!res.ok) return;
  allUsers = res.users;

  const totalBalance = allUsers.reduce((s, u) => s + (u.balance || 0), 0);
  document.getElementById('s-users').textContent = allUsers.length;
  document.getElementById('s-balance').textContent = totalBalance;
  document.getElementById('cnt-users').textContent = allUsers.length;

  renderUsers(allUsers);
}

document.getElementById('userSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = allUsers.filter(u =>
    String(u.id).includes(q) ||
    (u.username || '').toLowerCase().includes(q) ||
    (u.full_name || '').toLowerCase().includes(q)
  );
  renderUsers(filtered);
});

function renderUsers(users) {
  const el = document.getElementById('users-list');
  if (!users.length) {
    el.innerHTML = '<div class="empty"><div class="emoji">👤</div>Нікого не знайдено</div>';
    return;
  }
  el.innerHTML = users.map(u => `
    <div class="card" id="user-card-${u.id}">
      <div class="card-top">
        <div class="card-info">
          <div class="card-name" onclick="editUserName(${u.id}, '${u.full_name || ''}')" style="cursor:pointer; text-decoration:underline dashed rgba(255,255,255,0.3)">
            ${u.full_name || (u.username ? '@' + u.username : 'Без нікнейму')} ✏️
          </div>
          <div class="card-sub">${u.username ? `<a href="https://t.me/${u.username}" target="_blank" class="user-link">@${u.username}</a> · ` : ''}ID: ${u.id} ${u.is_registered ? '' : ' (Не зареєстровано)'}</div>
        </div>
        <div class="card-actions">
          <span class="badge-priv ${u.is_privileged ? 'on' : 'off'}" onclick="togglePrivilege(${u.id}, ${u.is_privileged})" title="Натисніть, щоб змінити">
            ${u.is_privileged ? '⭐ Пільга' : 'Звичайний'}
          </span>
          <button class="btn-icon btn-danger" onclick="deleteUser(${u.id})" title="Видалити користувача">🗑</button>
        </div>
      </div>
      <div class="balance-ctrl">
        <button class="btn-icon" onclick="changeBalance(${u.id}, -1)">−</button>
        <span class="balance-val" id="bal-${u.id}">${u.balance}</span>
        <button class="btn-icon" onclick="changeBalance(${u.id}, 1)">+</button>
        <span style="font-size:12px;color:var(--muted)">прань</span>
        
        <div style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
          <span style="font-size:12px; color:var(--muted)">Ліміт:</span>
          <input type="number" value="${u.monthly_limit || ''}" placeholder="Заг." 
            onchange="updateUserLimit(${u.id}, this.value)"
            style="width:50px; background:rgba(0,0,0,0.2); border:1px solid var(--border); color:white; border-radius:4px; padding:2px 4px; font-size:12px; outline:none">
        </div>
        
        <button class="btn btn-sm btn-primary" onclick="changeBalance(${u.id}, 8)" style="margin-left:8px">+8</button>
      </div>
    </div>
  `).join('');
}

async function updateUserLimit(userId, limit) {
  const res = await adminFetch('/api/admin/users/limit', { method: 'POST', body: { userId, limit } });
  if (res.ok) {
    toast('Ліміт оновлено');
    const u = allUsers.find(u => u.id === userId);
    if (u) u.monthly_limit = limit ? parseInt(limit) : null;
  } else {
    toast('Помилка!', '#ef4444');
  }
}

async function editUserName(userId, currentName) {
  const newName = prompt('Введіть нове ПІБ користувача:', currentName);
  if (newName === null || newName.trim() === currentName) return;
  
  const res = await adminFetch('/api/admin/users/update_name', { 
    method: 'POST', 
    body: { userId, fullName: newName.trim() } 
  });
  
  if (res.ok) {
    toast('Ім’я оновлено');
    loadUsers();
  } else {
    toast('Помилка!', '#ef4444');
  }
}

async function changeBalance(userId, delta) {
  const res = await adminFetch('/api/admin/users/balance', { method: 'POST', body: { userId, delta } });
  if (res.ok) {
    const el = document.getElementById(`bal-${userId}`);
    if (el) el.textContent = res.user.balance;
    const u = allUsers.find(u => u.id === userId);
    if (u) u.balance = res.user.balance;
    const totalBalance = allUsers.reduce((s, u) => s + (u.balance || 0), 0);
    document.getElementById('s-balance').textContent = totalBalance;
    toast(delta > 0 ? `+${delta} прань додано` : `${delta} прань знято`);
  } else {
    toast('Помилка!', '#ef4444');
  }
}

async function togglePrivilege(userId, current) {
  const res = await adminFetch('/api/admin/users/privilege', { method: 'POST', body: { userId, value: !current } });
  if (res.ok) {
    toast(current ? 'Пільгу знято' : 'Пільгу надано ⭐');
    loadUsers();
  } else {
    toast('Помилка!', '#ef4444');
  }
}

async function deleteUser(userId) {
  if (!confirm('Видалити користувача та всі його дані? Це незворотньо!')) return;
  const res = await adminFetch('/api/admin/users/delete', { method: 'POST', body: { userId } });
  if (res.ok) {
    toast('Користувача видалено');
    loadAll();
  } else {
    toast('Помилка!', '#ef4444');
  }
}

// ─────────────────────────────────────────────
// BOOKINGS
// ─────────────────────────────────────────────
let allBookings = [];
async function loadBookings() {
  const res = await adminFetch('/api/admin/bookings');
  if (!res.ok) return;
  allBookings = res.bookings;
  const active = allBookings.filter(b => b.status === 'active');
  document.getElementById('s-bookings').textContent = active.length;
  document.getElementById('s-bookings-all').textContent = allBookings.length;
  document.getElementById('cnt-bookings').textContent = allBookings.length;

  renderBookings(allBookings);
}

document.getElementById('bookingSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = allBookings.filter(b =>
    String(b.date).includes(q) ||
    String(b.machine_id).includes(q) ||
    (b.full_name || '').toLowerCase().includes(q) ||
    (b.username || '').toLowerCase().includes(q) ||
    String(b.user_id).includes(q)
  );
  renderBookings(filtered);
});

function renderBookings(bookings) {
  const el = document.getElementById('bookings-list');
  if (!bookings.length) {
    el.innerHTML = '<div class="empty"><div class="emoji">📅</div>Бронювань немає</div>';
    return;
  }
  el.innerHTML = bookings.map(b => `
    <div class="card">
      <div class="card-top">
        <div class="card-info">
          <div class="card-name">Пральна ${b.machine_id} · ${b.time_slot}</div>
          <div class="card-sub">
            ${b.date} · 
            <span onclick="goToUser(${b.user_id})" style="cursor:pointer; color:var(--accent-hover); text-decoration:underline">
              ${b.full_name || b.user_id}
            </span>
            ${b.username ? `· <a href="https://t.me/${b.username}" target="_blank" class="user-link">@${b.username}</a>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <span class="status status-${b.status === 'active' ? 'active' : 'expired'}">${b.status}</span>
          ${b.status === 'active' ? `<button class="btn-icon btn-danger" onclick="deleteBooking(${b.id})" title="Скасувати">🗑</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function goToUser(userId) {
  const tabs = document.querySelectorAll('.tab-btn');
  const userTab = Array.from(tabs).find(t => t.dataset.tab === 'users');
  if (userTab) userTab.click();
  
  const searchInput = document.getElementById('userSearch');
  searchInput.value = userId;
  searchInput.dispatchEvent(new Event('input'));
}

async function deleteBooking(id) {
  if (!confirm('Скасувати це бронювання?')) return;
  const res = await adminFetch('/api/admin/bookings/delete', { method: 'POST', body: { bookingId: id } });
  if (res.ok) {
    toast('Бронювання скасовано');
    loadBookings();
  } else {
    toast('Помилка!', '#ef4444');
  }
}

// ─────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────
async function loadPayments() {
  const res = await adminFetch('/api/admin/transactions');
  if (!res.ok) return;
  const txs = res.transactions;
  const unresolved = res.unresolved;
  const success = txs.filter(t => t.status === 'SUCCESS').length;
  document.getElementById('s-success').textContent = success;
  document.getElementById('s-unresolved').textContent = unresolved.length;
  document.getElementById('cnt-payments').textContent = txs.length + unresolved.length;

  const txEl = document.getElementById('transactions-list');
  if (!txs.length) {
    txEl.innerHTML = '<div class="empty"><div class="emoji">💳</div>Транзакцій немає</div>';
  } else {
    txEl.innerHTML = txs.map(t => `
      <div class="card">
        <div class="card-top">
          <div class="card-info">
            <div class="card-name">${t.requestedAmount} грн · Код: <code style="color:var(--accent-hover)">${t.paymentKey}</code></div>
            <div class="card-sub">
              ${t.full_name || t.userId} · 
              ${t.username ? `<a href="https://t.me/${t.username}" target="_blank" class="user-link">@${t.username}</a>` : ''} · 
              ${formatDate(t.createdAt)}
            </div>
          </div>
          <div class="card-actions">
            <span class="status status-${t.status.toLowerCase()}">${t.status}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  const unEl = document.getElementById('unresolved-list');
  if (!unresolved.length) {
    unEl.innerHTML = '<div class="empty"><div class="emoji">✅</div>Незарахованих немає</div>';
  } else {
    unEl.innerHTML = unresolved.map(p => `
      <div class="card">
        <div class="card-top">
          <div class="card-info">
            <div class="card-name">${p.amount} грн · ${p.senderName || 'Невідомий'}</div>
            <div class="card-sub">Коментар: "${p.comment || '—'}" · ${formatDate(p.receivedAt)}</div>
          </div>
          <div class="card-actions">
            <span class="status status-unclaimed">${p.status}</span>
            <button class="btn btn-sm btn-warn" onclick="openClaimModal('${p.id}')">Зарахувати</button>
          </div>
        </div>
      </div>
    `).join('');
  }
}

// ─────────────────────────────────────────────
// CLAIM MODAL
// ─────────────────────────────────────────────
function openClaimModal(paymentId) {
  pendingClaimId = paymentId;
  document.getElementById('claimWashes').value = '';
  document.getElementById('claimModal').classList.remove('hidden');
}

document.getElementById('claimCancel').addEventListener('click', () => {
  document.getElementById('claimModal').classList.add('hidden');
  pendingClaimId = null;
});

document.getElementById('claimSubmit').addEventListener('click', async () => {
  const userId = document.getElementById('claimUserId').value;
  const washesAdded = Number(document.getElementById('claimWashes').value);
  if (!userId || !washesAdded || washesAdded <= 0) {
    toast('Заповніть усі поля', '#ef4444');
    return;
  }
  const res = await adminFetch('/api/admin/unresolved/claim', {
    method: 'POST',
    body: { paymentId: pendingClaimId, userId: Number(userId), washesAdded }
  });
  if (res.ok) {
    toast('Платіж зараховано ✅');
    document.getElementById('claimModal').classList.add('hidden');
    pendingClaimId = null;
    loadAll();
  } else {
    toast(res.error || 'Помилка', '#ef4444');
  }
});





// ─────────────────────────────────────────────
// PRIVILEGES
// ─────────────────────────────────────────────
async function loadPrivileges() {
  const res = await adminFetch('/api/admin/privilege_requests');
  if (!res.ok) return;
  const reqs = res.requests;
  const pending = reqs.filter(r => r.status === 'pending');
  document.getElementById('cnt-privileges').textContent = pending.length;

  const el = document.getElementById('privileges-list');
  if (!reqs.length) {
    el.innerHTML = '<div class="empty"><div class="emoji">🎓</div>Заявок на пільги немає</div>';
    return;
  }
  
  el.innerHTML = reqs.map(r => `
    <div class="card">
      <div class="card-top">
        <div class="card-info">
          <div class="card-name">Заявка від ${r.full_name || '—'}</div>
          <div class="card-sub">
            ID: ${r.user_id} · 
            ${r.username ? `<a href="https://t.me/${r.username}" target="_blank" class="user-link">@${r.username}</a>` : ''} · 
            ${formatDate(r.created_at)}
          </div>
        </div>
        <div class="card-actions">
          <span class="status status-${r.status === 'pending' ? 'unclaimed' : r.status === 'approved' ? 'success' : 'expired'}">
            ${r.status === 'pending' ? 'Очікує' : r.status === 'approved' ? 'Схвалено' : 'Відхилено'}
          </span>
          <button class="btn btn-sm btn-secondary" style="background: rgba(255,255,255,0.1); color: var(--text);" onclick="viewImage('${r.photo_file_id}')">🖼 Фото</button>
        </div>
      </div>
      ${r.status === 'pending' ? `
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <button class="btn btn-sm btn-primary" onclick="resolvePrivilege(${r.id}, 'approved')" style="flex:1">Схвалити</button>
        <button class="btn btn-sm btn-danger" onclick="resolvePrivilege(${r.id}, 'rejected')" style="flex:1">Відхилити</button>
      </div>` : ''}
    </div>
  `).join('');
}

async function viewImage(fileId) {
  const imgEl = document.getElementById('imageModalImg');
  imgEl.src = ''; // reset
  document.getElementById('imageModal').classList.remove('hidden');
  
  try {
    const res = await adminFetch(`/api/admin/telegram_file?file_id=${fileId}`);
    if (res.ok) {
      imgEl.src = res.url;
    } else {
      toast('Не вдалося завантажити фото', '#ef4444');
      document.getElementById('imageModal').classList.add('hidden');
    }
  } catch (err) {
    toast('Помилка сервера', '#ef4444');
    document.getElementById('imageModal').classList.add('hidden');
  }
}

document.getElementById('imageModalClose').addEventListener('click', () => {
  document.getElementById('imageModal').classList.add('hidden');
});

async function resolvePrivilege(id, status) {
  if (!confirm(`Ви впевнені, що хочете ${status === 'approved' ? 'схвалити' : 'відхилити'} цю заявку?`)) return;
  const res = await adminFetch('/api/admin/privilege_requests/resolve', {
    method: 'POST',
    body: { requestId: id, status }
  });
  if (res.ok) {
    toast(status === 'approved' ? 'Заявку схвалено' : 'Заявку відхилено');
    loadPrivileges();
    loadUsers();
  } else {
    toast('Помилка', '#ef4444');
  }
}

// ─────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────
let currentReportData = [];
async function generateReport() {
  const startDate = document.getElementById('reportStartDate').value;
  const endDate = document.getElementById('reportEndDate').value;
  if (!startDate || !endDate) return toast('Оберіть період', '#ef4444');

  const res = await adminFetch(`/api/admin/reports?startDate=${startDate}&endDate=${endDate}`);
  const el = document.getElementById('report-results');
  const actionsEl = document.getElementById('report-actions');
  
  if (res.ok) {
    currentReportData = res.bookings;
    if (!res.bookings.length) {
      el.innerHTML = '<p class="empty">За цей період бронювань не знайдено</p>';
      actionsEl.style.display = 'none';
      return;
    }
    actionsEl.style.display = 'flex';
    el.innerHTML = `
      <div id="report-table-container" style="background:white; color:black; padding:20px; border-radius:8px;">
        <h2 style="margin-bottom:15px; text-align:center">Звіт за період ${startDate} — ${endDate}</h2>
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="text-align:left; border-bottom:2px solid #000;">
              <th style="padding:8px;">Дата</th>
              <th style="padding:8px;">Час</th>
              <th style="padding:8px;">Пр.</th>
              <th style="padding:8px;">ПІБ</th>
              <th style="padding:8px;">Username</th>
              <th style="padding:8px;">Статус</th>
            </tr>
          </thead>
          <tbody>
            ${res.bookings.map(b => `
              <tr style="border-bottom:1px solid #ddd;">
                <td style="padding:8px;">${b.date}</td>
                <td style="padding:8px;">${b.time_slot}</td>
                <td style="padding:8px;">${b.machine_id}</td>
                <td style="padding:8px;">${b.full_name || '—'}</td>
                <td style="padding:8px;">
                  ${b.username ? `@${b.username}` : b.user_id}
                </td>
                <td style="padding:8px;">${b.status}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="margin-top:15px; font-weight:bold; text-align:right">Всього бронювань: ${res.bookings.length}</div>
      </div>
    `;
  } else {
    toast('Помилка генерації звіту', '#ef4444');
  }
}

function exportPDF() {
  const element = document.getElementById('report-table-container');
  const opt = {
    margin:       10,
    filename:     `Report_${new Date().toISOString().split('T')[0]}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2 },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };
  html2pdf().set(opt).from(element).save();
}

async function exportWord() {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel } = docx;

  const tableRows = [
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ text: "Дата", bold: true })] }),
        new TableCell({ children: [new Paragraph({ text: "Час", bold: true })] }),
        new TableCell({ children: [new Paragraph({ text: "Пр.", bold: true })] }),
        new TableCell({ children: [new Paragraph({ text: "ПІБ", bold: true })] }),
        new TableCell({ children: [new Paragraph({ text: "Юзер", bold: true })] }),
        new TableCell({ children: [new Paragraph({ text: "Статус", bold: true })] }),
      ],
    }),
    ...currentReportData.map(b => new TableRow({
      children: [
        new TableCell({ children: [new Paragraph(b.date)] }),
        new TableCell({ children: [new Paragraph(b.time_slot)] }),
        new TableCell({ children: [new Paragraph(String(b.machine_id))] }),
        new TableCell({ children: [new Paragraph(b.full_name || "—")] }),
        new TableCell({ children: [new Paragraph("@" + (b.username || b.user_id))] }),
        new TableCell({ children: [new Paragraph(b.status)] }),
      ],
    }))
  ];

  const table = new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "Звіт по бронюванням", heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
        new Paragraph({ text: `Дата формування: ${new Date().toLocaleString()}`, alignment: AlignmentType.CENTER }),
        new Paragraph({ text: "" }), // spacing
        table,
        new Paragraph({ text: "" }),
        new Paragraph({ text: `Всього бронювань: ${currentReportData.length}`, bold: true, alignment: AlignmentType.RIGHT }),
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `Report_${new Date().toISOString().split('T')[0]}.docx`);
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
async function loadSettings() {
  const res = await adminFetch('/api/admin/settings');
  if (res.ok) {
    document.getElementById('settingMonthlyLimit').value = res.settings.monthly_limit || 12;
    document.getElementById('settingPricePerWash').value = res.settings.price_per_wash || 50;
    document.getElementById('settingPricePerWashPrivileged').value = res.settings.price_per_wash_privileged || 30;
    document.getElementById('settingSubscriptionWashes').value = res.settings.subscription_washes_count || 8;
    document.getElementById('settingSubscriptionPrice').value = res.settings.subscription_price || 150;
    document.getElementById('settingSubscriptionPricePrivileged').value = res.settings.subscription_price_privileged || 100;

    // Render maintenance mode settings
    const maintActive = res.settings.maintenance_mode === 'true';
    const maintPass = res.settings.maintenance_password || '';

    const badge = document.getElementById('maintenanceStatusBadge');
    const passInput = document.getElementById('maintenancePassword');
    const btnEnable = document.getElementById('btnEnableMaintenance');
    const btnDisable = document.getElementById('btnDisableMaintenance');

    if (badge) {
      if (maintActive) {
        badge.className = 'status status-expired';
        badge.textContent = 'Увімкнено (Активний)';
        if (btnEnable) btnEnable.style.display = 'none';
        if (btnDisable) btnDisable.style.display = 'inline-block';
      } else {
        badge.className = 'status status-success';
        badge.textContent = 'Вимкнено (Всі оплати доступні)';
        if (btnEnable) btnEnable.style.display = 'inline-block';
        if (btnDisable) btnDisable.style.display = 'none';
      }
    }
    if (passInput) {
      passInput.value = maintPass;
    }
  }
  await loadMachines();
}

async function loadMachines() {
  const res = await adminFetch('/api/admin/machines');
  const el = document.getElementById('machines-list');
  if (!el) return;
  if (!res.ok) {
    el.innerHTML = '<div class="empty">Не вдалося завантажити список пральних машин</div>';
    return;
  }
  const machines = res.machines || [];
  if (!machines.length) {
    el.innerHTML = '<div class="empty">Пральних машин не знайдено</div>';
    return;
  }

  el.innerHTML = machines.map(m => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:8px; background:rgba(0,0,0,0.2)">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:20px;">🧺</span>
        <div>
          <div style="font-weight:600; font-size:14px;">${m.name || ('Пралка №' + m.id)}</div>
          <div style="font-size:12px; color:var(--muted)">ID: ${m.id}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:12px;">
        <span class="status status-${m.status === 'active' ? 'success' : 'expired'}" style="padding:4px 10px; font-size:12px">
          ${m.status === 'active' ? '● Активна' : '✕ Деактивована'}
        </span>
        <button class="btn btn-sm ${m.status === 'active' ? 'btn-danger' : 'btn-primary'}" onclick="toggleMachineStatus(${m.id}, '${m.status}')">
          ${m.status === 'active' ? 'Деактивувати' : 'Активувати'}
        </button>
      </div>
    </div>
  `).join('');
}

async function toggleMachineStatus(machineId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  const actionName = newStatus === 'inactive' ? 'деактивувати' : 'активувати';
  
  let confirmMsg = `Ви дійсно бажаєте ${actionName} Пралку №${machineId}?`;
  if (newStatus === 'inactive') {
    confirmMsg += '\n\nУвага: всі її майбутні бронювання будуть скасовані, а прання повернуті користувачам у боті!';
  }

  if (!confirm(confirmMsg)) return;

  const res = await adminFetch('/api/admin/machines/status', {
    method: 'POST',
    body: { machineId, status: newStatus }
  });

  if (res.ok) {
    if (newStatus === 'inactive') {
      toast(`Пралку №${machineId} деактивовано. Скасовано бронювань: ${res.cancelledCount || 0}`);
    } else {
      toast(`Пралку №${machineId} активовано`);
    }
    loadMachines();
    loadBookings();
    loadUsers();
  } else {
    toast(res.error || 'Помилка зміни статусу', '#ef4444');
  }
}

async function updateSetting(key, value) {
  const res = await adminFetch('/api/admin/settings/update', { method: 'POST', body: { key, value } });
  if (res.ok) {
    toast('Налаштування збережено');
    loadSettings();
  } else {
    toast('Помилка збереження', '#ef4444');
  }
}

// Real-time updates via Socket.io
if (typeof io !== 'undefined') {
  const socket = io();
  socket.on('update', () => {
    console.log('Real-time update received');
    loadAll();
  });
}

// Maintenance Mode Event Listeners
const btnEnableMaint = document.getElementById('btnEnableMaintenance');
const btnDisableMaint = document.getElementById('btnDisableMaintenance');

if (btnEnableMaint) {
  btnEnableMaint.addEventListener('click', async () => {
    const password = document.getElementById('maintenancePassword').value;
    if (!password || !password.trim()) {
      alert('Будь ласка, введіть пароль для ввімкнення техробіт!');
      return;
    }

    const res1 = await adminFetch('/api/admin/settings/update', { method: 'POST', body: { key: 'maintenance_mode', value: 'true' } });
    const res2 = await adminFetch('/api/admin/settings/update', { method: 'POST', body: { key: 'maintenance_password', value: password.trim() } });

    if (res1.ok && res2.ok) {
      toast('Режим техробіт увімкнено!');
      loadSettings();
    } else {
      toast('Помилка ввімкнення', '#ef4444');
    }
  });
}

if (btnDisableMaint) {
  btnDisableMaint.addEventListener('click', async () => {
    const res = await adminFetch('/api/admin/settings/update', { method: 'POST', body: { key: 'maintenance_mode', value: 'false' } });
    if (res.ok) {
      toast('Режим техробіт вимкнено!');
      loadSettings();
    } else {
      toast('Помилка вимкнення', '#ef4444');
    }
  });
}
