const API_BASE = ''; // Relative path because backend serves it
const TIME_SLOTS = [
  '07:00–09:30',
  '09:30–12:00',
  '12:00–14:30',
  '14:30–17:00',
  '17:00–19:30',
  '19:30–22:00'
];

const tg = window.Telegram.WebApp;
tg.expand();

// Apply theme colors to the Telegram UI
function applyTheme() {
  tg.setHeaderColor(tg.themeParams.secondary_bg_color || '#ffffff');
  tg.setBackgroundColor(tg.themeParams.bg_color || '#ffffff');
}

applyTheme();
tg.onEvent('themeChanged', applyTheme);
const elGrid = document.getElementById('grid');
const elDate = document.getElementById('datePicker');
const elBalance = document.getElementById('balance');
const elBuySingle = document.getElementById('buySingleBtn');
const elBuyPass = document.getElementById('buyPassBtn');
const elSinglePrice = document.getElementById('singlePrice');
const elPassPrice = document.getElementById('passPrice');
const elRefresh = document.getElementById('refreshBtn');
const elUserName = document.getElementById('tg-user-name');
const elUserLogin = document.getElementById('tg-user-login');
const elAvatar = document.getElementById('tg-avatar');
const elLoading = document.getElementById('app-loading');
const elMonthlyUsage = document.getElementById('monthly-usage');
const elMonthlyLimit = document.getElementById('monthly-limit');

const elRegModal = document.getElementById('registrationModal');
const elRegFullName = document.getElementById('regFullName');
const elRegIsPrivileged = document.getElementById('regIsPrivileged');
const elRegSubmit = document.getElementById('submitRegistrationBtn');
const elPrivHint = document.getElementById('privilegeHint');

// FAQ Elements
const elFaqModal = document.getElementById('faqModal');
const elOpenFaq = document.getElementById('openFaqBtn');
const elCloseFaq = document.getElementById('closeFaqBtn');
const elCloseFaqTop = document.getElementById('closeFaqBtnTop');

// Maintenance Mode Elements
const elAppMaintenanceOverlay = document.getElementById('app-maintenance');
const elMaintAppPasswordInput = document.getElementById('maintAppPassword');
const elMaintAppSubmitBtn = document.getElementById('maintAppSubmitBtn');

let currentUser = null;
let currentBalance = 0;
let currentSettings = null;

function showLoading() {
  elLoading.classList.remove('hidden');
}

function hideLoading() {
  elLoading.classList.add('hidden');
}

function showAlert(msg) {
  if (tg) {
    tg.showAlert(msg);
  } else {
    alert(msg);
  }
}

function showConfirm(msg, callback) {
  if (tg) {
    tg.showConfirm(msg, (confirmed) => {
      if (confirmed) callback();
    });
  } else {
    if (confirm(msg)) callback();
  }
}

function getInitData() {
  if (!tg) return null;
  return {
    initData: tg.initData,
    user: tg.initDataUnsafe?.user || null
  };
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setUserUI(user) {
  if (!user) return;
  const displayName = user.full_name || user.first_name || user.username || 'Гість';
  elUserName.textContent = displayName;
  if (user.username) {
    elUserLogin.textContent = `@${user.username}`;
  }
  elAvatar.textContent = displayName.charAt(0).toUpperCase();
}

async function apiGet(path) {
  const init = getInitData();
  const maintPass = localStorage.getItem('app_maint_password') || '';
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'x-telegram-init': init?.initData || '',
      'x-maintenance-password': maintPass
    }
  });
  return res.json();
}

async function apiPost(path, body) {
  const init = getInitData();
  const maintPass = localStorage.getItem('app_maint_password') || '';
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-init': init?.initData || '',
      'x-maintenance-password': maintPass
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

function renderGrid(bookings, myId, machines = []) {
  elGrid.innerHTML = '';

  TIME_SLOTS.forEach((slot) => {
    const row = document.createElement('div');
    row.className = 'grid-row';

    const cellTime = document.createElement('div');
    cellTime.className = 'grid-cell time-col';
    cellTime.textContent = slot;
    row.appendChild(cellTime);

    for (let machine = 1; machine <= 3; machine++) {
      const cell = document.createElement('div');
      
      const mObj = machines.find(m => m.id === machine);
      const isInactive = mObj && mObj.status !== 'active';

      if (isInactive) {
        cell.className = 'slot inactive';
        cell.textContent = 'Не працює';
        cell.addEventListener('click', () => {
          showAlert(`Пральна ${machine} тимчасово деактивована або перебуває на обслуговуванні.`);
        });
      } else {
        const found = bookings.find(
          (b) => b.time_slot === slot && b.machine_id === machine
        );

        if (found) {
          if (found.user_id === myId) {
            cell.className = 'slot mine';
            cell.textContent = 'Моє (Відмінити)';
            cell.addEventListener('click', () => {
              showConfirm(`Відмінити бронювання Пралки ${machine} на час ${slot}?`, () => {
                handleCancel(slot, machine);
              });
            });
          } else {
            cell.className = 'slot booked';
            cell.textContent = 'Зайнято';
          }
        } else {
          cell.className = 'slot free';
          cell.textContent = 'Вільна';
          cell.addEventListener('click', () => {
            showConfirm(`Забронювати Пралку ${machine} на час ${slot}?`, () => {
              handleBooking(slot, machine);
            });
          });
        }
      }

      row.appendChild(cell);
    }
    elGrid.appendChild(row);
  });
}

async function loadState(skipMaintenanceCheck = false) {
  if (!skipMaintenanceCheck) {
    const isBlocked = await checkAppMaintenance();
    if (isBlocked) return;
  }

  showLoading();
  const date = elDate.value;
  try {
    const data = await apiGet(`/api/state?date=${encodeURIComponent(date)}`);
    
    if (!data.ok) {
      if(data.error === 'Unauthorized' && !tg?.initData) {
        // Mock data for local testing without Telegram
        currentUser = { id: 1, first_name: 'Local User' };
        currentBalance = 5;
        renderGrid([], 1);
        setUserUI(currentUser);
        elBalance.textContent = currentBalance;
        hideLoading();
        return;
      }
      showAlert(data.error || 'Помилка завантаження даних');
      hideLoading();
      return;
    }

    currentUser = data.user;
    currentBalance = data.balance;
    elBalance.textContent = currentBalance;
    setUserUI(currentUser);
    
    if (elMonthlyUsage) elMonthlyUsage.textContent = data.monthly_usage;
    if (elMonthlyLimit) {
      elMonthlyLimit.textContent = data.monthly_limit < 0 ? '∞' : data.monthly_limit;
    }

    if (!currentUser.is_registered) {
      elRegModal.classList.remove('hidden');
    } else {
      elRegModal.classList.add('hidden');
    }

    currentSettings = data.settings || {};
    const pricePerWash = data.is_privileged 
      ? (currentSettings.price_per_wash_privileged || 30) 
      : (currentSettings.price_per_wash || 50);
    const pricePass = data.is_privileged 
      ? (currentSettings.subscription_price_privileged || 100) 
      : (currentSettings.subscription_price || 150);
    const subWashes = currentSettings.subscription_washes_count || 8;

    elSinglePrice.textContent = `${pricePerWash} ₴`;
    elPassPrice.textContent = `${pricePass} ₴`;

    const passLabel = elBuyPass.querySelector('span:first-child');
    if (passLabel) {
      passLabel.textContent = `Абонемент (${subWashes} прань)`;
    }

    renderGrid(data.bookings, currentUser.id, data.machines);
  } catch (err) {
    console.error(err);
    showAlert('Помилка з\'єднання з сервером');
  } finally {
    hideLoading();
  }
}

async function handleRegistration() {
  const full_name = elRegFullName.value.trim();
  const is_privileged_request = elRegIsPrivileged.checked;

  if (full_name.length < 3) {
    showAlert('Будь ласка, введіть ПІБ повністю');
    return;
  }

  showLoading();
  try {
    const res = await apiPost('/api/register', { full_name, is_privileged_request });
    if (res.ok) {
      elRegModal.classList.add('hidden');
      if (is_privileged_request) {
        showAlert('Реєстрація успішна! Тепер надішліть фото документа боту для отримання пільги.');
      } else {
        showAlert('Реєстрація успішна!');
      }
      loadState();
    } else {
      showAlert(res.error || 'Помилка реєстрації');
    }
  } catch (err) {
    showAlert('Помилка сервера');
  } finally {
    hideLoading();
  }
}

async function handleBooking(timeSlot, machineId) {
  showLoading();
  try {
    const date = elDate.value;
    
    // Mock for local testing
    if(!tg?.initData) {
      showAlert(`Бронювання ${timeSlot} на М${machineId} успішне! (Локальний тест)`);
      loadState();
      return;
    }

    const res = await apiPost('/api/book', { date, time_slot: timeSlot, machine_id: machineId });
    if (!res.ok) {
      showAlert(res.error || 'Не вдалося забронювати');
    } else {
      showAlert('Бронювання успішно створено!');
      loadState();
    }
  } catch(err) {
    showAlert('Сталася помилка');
  } finally {
    hideLoading();
  }
}

async function handleCancel(timeSlot, machineId) {
  showLoading();
  try {
    const date = elDate.value;
    
    if(!tg?.initData) {
      showAlert(`Відміна ${timeSlot} на М${machineId} успішна! (Локальний тест)`);
      loadState();
      return;
    }

    const res = await apiPost('/api/book/cancel', { date, time_slot: timeSlot, machine_id: machineId });
    if (!res.ok) {
      showAlert(res.error || 'Не вдалося відмінити');
    } else {
      showAlert('Бронювання успішно відмінено!');
      loadState();
    }
  } catch(err) {
    showAlert('Сталася помилка');
  } finally {
    hideLoading();
  }
}

async function checkAppMaintenance() {
  try {
    const configRes = await apiGet('/api/config');
    const maintOverlay = document.getElementById('app-maintenance');
    
    if (configRes && configRes.ok && configRes.maintenanceMode) {
      const savedPass = localStorage.getItem('app_maint_password');
      if (savedPass) {
        const date = elDate.value;
        const testRes = await apiGet(`/api/state?date=${encodeURIComponent(date)}`);
        if (testRes && (testRes.ok || (testRes.error === 'Unauthorized' && !tg?.initData))) {
          maintOverlay.classList.add('hidden');
          return false;
        }
      }
      maintOverlay.classList.remove('hidden');
      return true;
    } else {
      maintOverlay.classList.add('hidden');
      localStorage.removeItem('app_maint_password');
      return false;
    }
  } catch (err) {
    console.error('Error checking maintenance:', err);
    return false;
  }
}


async function buy(washes) {
  showLoading();
  try {
    const res = await apiPost('/api/payments/create', { washes });
    if (!res.ok) {
      if (res.error === 'maintenance_restricted') {
        showAlert(res.error_uk || 'Доступ обмежено: невірний пароль!');
      } else {
        showAlert(res.error || 'Не вдалося створити заявку');
      }
    } else {
      if (tg && tg.openLink) {
        tg.openLink(res.deepLink);
      } else {
        window.open(res.deepLink, '_blank');
      }
    }
  } catch (err) {
    showAlert('Сталася помилка при створенні оплати');
  } finally {
    hideLoading();
  }
}

const elClaimModal = document.getElementById('claimModal');
const elOpenClaim = document.getElementById('openClaimBtn');
const elCloseClaim = document.getElementById('closeClaimBtn');
const elSubmitClaim = document.getElementById('submitClaimBtn');
const elClaimAmount = document.getElementById('claimAmount');

if (elOpenClaim) {
  elOpenClaim.addEventListener('click', () => elClaimModal.classList.remove('hidden'));
  elCloseClaim.addEventListener('click', () => elClaimModal.classList.add('hidden'));

  elSubmitClaim.addEventListener('click', async () => {
    const rawVal = elClaimAmount.value.trim();
    if (!rawVal) {
      showAlert('Введіть суму або код оплати');
      return;
    }
    
    showLoading();
    try {
      const res = await apiPost('/api/payments/claim', { query: rawVal });
      if (res.ok) {
        showAlert(res.message);
        elClaimModal.classList.add('hidden');
        loadState();
      } else {
        showAlert(res.error || 'Не вдалося знайти оплату');
      }
    } catch (e) {
      showAlert('Помилка сервера');
    } finally {
      hideLoading();
    }
  });
}

const elPrivilegeModal = document.getElementById('privilegeModal');
const elOpenPrivilege = document.getElementById('openPrivilegeBtn');
const elClosePrivilege = document.getElementById('closePrivilegeBtn');
const elGoToBot = document.getElementById('goToBotBtn');

let cachedBotUsername = null;

if (elOpenPrivilege) {
  elOpenPrivilege.addEventListener('click', async () => {
    elPrivilegeModal.classList.remove('hidden');
    if (!cachedBotUsername) {
      try {
        const res = await apiGet('/api/config');
        if (res.ok && res.botUsername) {
          cachedBotUsername = res.botUsername;
        }
      } catch (e) { console.error(e); }
    }
  });
  
  elClosePrivilege.addEventListener('click', () => elPrivilegeModal.classList.add('hidden'));
  
  elGoToBot.addEventListener('click', () => {
    if (tg && tg.close) {
      // Just close TWA to return to bot chat
      tg.close();
    } else if (cachedBotUsername) {
      window.open(`https://t.me/${cachedBotUsername}`, '_blank');
    } else {
      showAlert("Закрийте додаток і надішліть фото в бота.");
    }
  });
}

function bindEvents() {
  elRefresh.addEventListener('click', loadState);
  elBuySingle.addEventListener('click', () => buy(1));
  elBuyPass.addEventListener('click', () => {
    const washes = currentSettings?.subscription_washes_count || 8;
    buy(washes);
  });
  elDate.addEventListener('change', loadState);

  const elPrevDateBtn = document.getElementById('prevDateBtn');
  const elNextDateBtn = document.getElementById('nextDateBtn');
  if (elPrevDateBtn) {
    elPrevDateBtn.addEventListener('click', () => {
      const d = new Date(elDate.value);
      d.setDate(d.getDate() - 1);
      const iso = d.toISOString().split('T')[0];
      if (iso >= elDate.min) {
        elDate.value = iso;
        loadState();
      }
    });
  }
  if (elNextDateBtn) {
    elNextDateBtn.addEventListener('click', () => {
      const d = new Date(elDate.value);
      d.setDate(d.getDate() + 1);
      const iso = d.toISOString().split('T')[0];
      if (!elDate.max || iso <= elDate.max) {
        elDate.value = iso;
        loadState();
      }
    });
  }

  const elOpenProfile = document.getElementById('openProfileBtn');
  const elProfileModal = document.getElementById('profileModal');
  const elCloseProfile = document.getElementById('closeProfileBtn');
  const elSubmitProfile = document.getElementById('submitProfileBtn');
  const elProfileFullName = document.getElementById('profileFullName');

  if (elOpenProfile) {
    elOpenProfile.addEventListener('click', () => {
      elProfileFullName.value = currentUser?.full_name || '';
      elProfileModal.classList.remove('hidden');
    });
    elCloseProfile.addEventListener('click', () => elProfileModal.classList.add('hidden'));
    elSubmitProfile.addEventListener('click', async () => {
      const full_name = elProfileFullName.value;
      if (!full_name || full_name.trim().length < 3) return showAlert('Введіть коректне ПІБ');
      showLoading();
      try {
        const res = await apiPost('/api/profile/request', { full_name });
        if (res.ok) {
          elProfileModal.classList.add('hidden');
          showAlert('Запит надіслано адміну!');
        } else {
          showAlert(res.error);
        }
      } catch (e) {
        showAlert('Помилка сервера');
      } finally {
        hideLoading();
      }
    });
  }

  // FAQ Modal Events
  if (elOpenFaq) {
    elOpenFaq.addEventListener('click', () => elFaqModal.classList.remove('hidden'));
    [elCloseFaq, elCloseFaqTop].forEach(btn => {
      if (btn) btn.addEventListener('click', () => elFaqModal.classList.add('hidden'));
    });

    // Accordion Logic
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
      const question = item.querySelector('.faq-question');
      if (question) {
        question.addEventListener('click', () => {
          const isActive = item.classList.contains('active');
          // Close others
          faqItems.forEach(i => i.classList.remove('active'));
          // Toggle current
          if (!isActive) item.classList.add('active');
        });
      }
    });
  }
  
  if (elRegSubmit) {
    elRegSubmit.addEventListener('click', handleRegistration);
  }
  
  if (elRegIsPrivileged) {
    elRegIsPrivileged.addEventListener('change', () => {
      // Logic for privilege hint if needed
    });
  }

  const elRegAgreeRules = document.getElementById('regAgreeRules');
  if (elRegAgreeRules && elRegSubmit) {
    elRegAgreeRules.addEventListener('change', () => {
      if (elRegAgreeRules.checked) {
        elRegSubmit.disabled = false;
        elRegSubmit.style.opacity = '1';
      } else {
        elRegSubmit.disabled = true;
        elRegSubmit.style.opacity = '0.5';
      }
    });
  }

  // Global App Maintenance Submit
  const btnAppMaintSubmit = document.getElementById('maintAppSubmitBtn');
  const inputAppMaintPass = document.getElementById('maintAppPassword');

  if (btnAppMaintSubmit) {
    btnAppMaintSubmit.addEventListener('click', async () => {
      const password = inputAppMaintPass.value;
      if (!password || !password.trim()) {
        showAlert('Будь ласка, введіть пароль!');
        return;
      }
      
      localStorage.setItem('app_maint_password', password.trim());
      showLoading();
      
      try {
        const date = elDate.value;
        const testRes = await apiGet(`/api/state?date=${encodeURIComponent(date)}`);
        hideLoading();
        
        if (testRes && (testRes.ok || (testRes.error === 'Unauthorized' && !tg?.initData))) {
          document.getElementById('app-maintenance').classList.add('hidden');
          loadState(true);
        } else {
          localStorage.removeItem('app_maint_password');
          showAlert(testRes.error_uk || 'Невірний пароль!');
        }
      } catch (err) {
        hideLoading();
        localStorage.removeItem('app_maint_password');
        showAlert('Помилка підключення');
      }
    });
  }
}

function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    // Setup header color based on theme
    if (tg.setHeaderColor) {
      tg.setHeaderColor('secondary_bg_color');
    }
  }

  const initData = getInitData();
  if (initData?.user) {
    setUserUI(initData.user);
  } else {
    setUserUI({ first_name: 'Гість' });
  }

  const today = todayISO();
  elDate.value = today;
  elDate.min = today;

  // Set maximum date to the last day of the current month
  const lastDayOfCurrentMonth = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  };
  elDate.max = lastDayOfCurrentMonth();

  bindEvents();
  loadState();

  // Socket.io for real-time updates
  if (typeof io !== 'undefined') {
    const socket = io();
    socket.on('update', () => {
      console.log('Real-time update received');
      loadState();
    });
  }
}

init();
