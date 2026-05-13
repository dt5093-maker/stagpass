const authScreen = document.getElementById('auth-screen');
const setupScreen = document.getElementById('setup-screen');
const studentView = document.getElementById('student-view');
const teacherView = document.getElementById('teacher-view');
const userChip = document.getElementById('user-chip');
const userName = document.getElementById('user-name');
const userRole = document.getElementById('user-role');
const toggleRoleButton = document.getElementById('toggle-role-button');
const logoutButton = document.getElementById('logout-button');
const requestForm = document.getElementById('request-form');
const studentMessage = document.getElementById('student-message');
const studentRefreshButton = document.getElementById('student-refresh-button');
const myRequestsList = document.getElementById('my-requests-list');
const teacherRefreshButton = document.getElementById('teacher-refresh-button');
const pendingList = document.getElementById('pending-list');
const activeList = document.getElementById('active-list');
const historyList = document.getElementById('history-list');
const lookupForm = document.getElementById('lookup-form');
const lookupResults = document.getElementById('lookup-results');

let activePasses = [];
let currentUser = null;
const socket = io();

// Socket.IO event listeners for real-time updates
socket.on('passes-updated', () => {
  if (currentUser) {
    if (currentUser.role === 'teacher') {
      loadTeacherDashboard();
    } else {
      loadStudentDashboard();
    }
  }
});

function show(element) {
  element.classList.remove('hidden');
}

function hide(element) {
  element.classList.add('hidden');
}

function formatTime(timestamp) {
  if (!timestamp) return 'Not started';
  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatDuration(minutes) {
  if (minutes < 1) return 'Just now';
  if (minutes === 1) return '1 min';
  return `${minutes} min`;
}

function statusLabel(status) {
  const labels = {
    pending: 'Waiting',
    approved: 'Active',
    returned: 'Returned',
    denied: 'Denied',
  };
  return labels[status] || status;
}

function updateClock() {
  document.getElementById('clock').textContent = new Intl.DateTimeFormat([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
}

function showMessage(element, text, type = 'info') {
  element.textContent = text;
  element.dataset.type = type;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }

  return data;
}

function emptyState(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = text;
  return div;
}

function passDetails(pass) {
  return [
    pass.room ? `Room ${pass.room}` : null,
    pass.teacher ? (pass.status === 'pending' ? `To ${pass.teacher}` : `Approved by ${pass.teacher}`) : null,
    pass.maxMinutes ? `Limit ${pass.maxMinutes} min` : null,
  ].filter(Boolean).join(' • ');
}

function activePassCard(pass) {
  const article = document.createElement('article');
  article.className = `pass-card ${pass.isOverdue ? 'overdue' : ''}`;
  article.innerHTML = `
    <div class="pass-main">
      <div>
        <h3></h3>
        <p class="destination"></p>
        <p class="meta"></p>
      </div>
      <div class="timer ${pass.isOverdue ? 'timer-alert' : ''}">
        ${formatDuration(pass.elapsedMinutes)}
      </div>
    </div>
    <div class="pass-footer">
      <span></span>
      <button type="button" data-action="return">Return</button>
    </div>
  `;
  article.querySelector('h3').textContent = pass.name;
  article.querySelector('.destination').textContent = pass.destination;
  article.querySelector('.meta').textContent = `Out ${formatTime(pass.startTime)} • ${passDetails(pass)}`;
  article.querySelector('span').textContent = pass.studentEmail || '';
  article.querySelector('[data-action="return"]').addEventListener('click', () => endPass(pass.id));

  if (pass.notes) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = pass.notes;
    article.appendChild(note);
  }

  return article;
}

function pendingRequestCard(pass) {
  const article = document.createElement('article');
  article.className = 'pass-card pending-card';
  article.innerHTML = `
    <div class="pass-main">
      <div>
        <h3></h3>
        <p class="destination"></p>
        <p class="meta"></p>
      </div>
      <div class="status-pill">Pending</div>
    </div>
    <div class="pass-footer">
      <span></span>
      <div class="button-pair">
        <button class="danger-button" type="button" data-action="deny">Deny</button>
        <button type="button" data-action="approve">Approve</button>
      </div>
    </div>
  `;
  article.querySelector('h3').textContent = pass.name;
  article.querySelector('.destination').textContent = pass.destination;
  article.querySelector('.meta').textContent = `Requested ${formatTime(pass.requestedAt)} • ${passDetails(pass)}`;
  article.querySelector('span').textContent = pass.studentEmail || '';
  article.querySelector('[data-action="approve"]').addEventListener('click', () => approveRequest(pass.id));
  article.querySelector('[data-action="deny"]').addEventListener('click', () => denyRequest(pass.id));

  if (pass.notes) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = pass.notes;
    article.appendChild(note);
  }

  return article;
}

function studentRequestCard(pass) {
  const article = document.createElement('article');
  article.className = `pass-card status-${pass.status}`;
  const timeText = pass.status === 'pending'
    ? `Requested ${formatTime(pass.requestedAt)}`
    : pass.status === 'approved'
      ? `Approved ${formatTime(pass.approvedAt)}`
      : pass.status === 'returned'
        ? `${formatTime(pass.startTime)} to ${formatTime(pass.endTime)}`
        : `Denied ${formatTime(pass.deniedAt)}`;

  article.innerHTML = `
    <div class="pass-main">
      <div>
        <h3></h3>
        <p class="destination"></p>
        <p class="meta"></p>
      </div>
      <div class="status-pill"></div>
    </div>
    <div class="pass-footer">
      <span></span>
    </div>
  `;
  article.querySelector('h3').textContent = pass.destination;
  article.querySelector('.destination').textContent = timeText;
  article.querySelector('.meta').textContent = passDetails(pass);
  article.querySelector('.status-pill').textContent = statusLabel(pass.status);
  article.querySelector('span').textContent = pass.deniedReason
    ? `Reason: ${pass.deniedReason}`
    : pass.notes || 'No note added';

  if (pass.status === 'approved') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'I returned';
    button.addEventListener('click', () => endPass(pass.id));
    article.querySelector('.pass-footer').appendChild(button);
  }

  return article;
}

function historyRow(pass) {
  const row = document.createElement('article');
  row.className = 'history-row';
  row.innerHTML = `
    <div>
      <strong></strong>
      <p></p>
    </div>
    <span></span>
  `;
  row.querySelector('strong').textContent = pass.name;
  row.querySelector('p').textContent =
    `${pass.destination} • ${formatTime(pass.startTime)} to ${formatTime(pass.endTime)}`;
  row.querySelector('span').textContent = formatDuration(pass.elapsedMinutes);
  return row;
}

function lookupPassRow(pass) {
  const row = document.createElement('article');
  row.className = 'history-row lookup-pass-row';
  row.innerHTML = `
    <div>
      <strong></strong>
      <p></p>
    </div>
    <span></span>
  `;

  const status = pass.endTime
    ? `${formatTime(pass.startTime)} to ${formatTime(pass.endTime)}`
    : `Out since ${formatTime(pass.startTime)}`;

  row.querySelector('strong').textContent = pass.destination;
  row.querySelector('p').textContent = [
    status,
    pass.teacher,
    pass.room ? `Room ${pass.room}` : null,
  ].filter(Boolean).join(' • ');
  row.querySelector('span').textContent = pass.endTime
    ? formatDuration(pass.elapsedMinutes)
    : 'Active';

  if (!pass.endTime) row.classList.add('active-lookup-row');
  return row;
}

function renderActive() {
  activeList.replaceChildren();

  if (!activePasses.length) {
    activeList.appendChild(emptyState('No students are currently out.'));
    return;
  }

  activePasses.forEach((pass) => {
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - pass.startTime) / 60000));
    activeList.appendChild(activePassCard({
      ...pass,
      elapsedMinutes,
      isOverdue: elapsedMinutes >= pass.maxMinutes,
    }));
  });
}

function renderPending(passes) {
  pendingList.replaceChildren();
  if (!passes.length) {
    pendingList.appendChild(emptyState('No pass requests are waiting.'));
    return;
  }
  passes.forEach((pass) => pendingList.appendChild(pendingRequestCard(pass)));
}

function renderStudentRequests(passes) {
  myRequestsList.replaceChildren();
  if (!passes.length) {
    myRequestsList.appendChild(emptyState('Your pass requests will appear here.'));
    return;
  }
  passes.forEach((pass) => myRequestsList.appendChild(studentRequestCard(pass)));
}

function renderTeacherSelect(teachers) {
  const select = document.getElementById('teacher');
  select.replaceChildren();
  select.appendChild(new Option('Choose teacher', ''));
  teachers.forEach((teacher) => {
    select.appendChild(new Option(teacher.name, teacher.email));
  });
}

function renderOverdue(passes) {
  const overdueList = document.getElementById('overdue-list');
  overdueList.replaceChildren();

  const overduePasses = passes.filter((pass) => pass.isOverdue && !pass.endTime);
  if (!overduePasses.length) {
    overdueList.appendChild(emptyState('No overdue passes.'));
    return;
  }

  overduePasses.forEach((pass) => overdueList.appendChild(activePassCard(pass)));
}

function renderHistory(passes) {
  historyList.replaceChildren();
  if (!passes.length) {
    historyList.appendChild(emptyState('Returned passes will appear here.'));
    return;
  }
  passes.forEach((pass) => historyList.appendChild(historyRow(pass)));
}

function renderStats(stats) {
  document.getElementById('pending-count').textContent = stats.pending;
  document.getElementById('active-count').textContent = stats.active;
  document.getElementById('overdue-count').textContent = stats.overdue;
  document.getElementById('today-count').textContent = stats.today;
  document.getElementById('average-minutes').textContent = stats.averageMinutes;
}

function renderLookupResults(data) {
  lookupResults.replaceChildren();

  if (!data.summary.total) {
    lookupResults.appendChild(emptyState(`No passes found for "${data.query}".`));
    return;
  }

  const header = document.createElement('div');
  header.className = 'lookup-summary';
  header.innerHTML = `
    <div>
      <p class="eyebrow">Matched Student</p>
      <h3></h3>
    </div>
    <div class="lookup-stat-grid">
      <article><span>${data.summary.total}</span><p>Total</p></article>
      <article><span>${data.summary.active}</span><p>Active</p></article>
      <article><span>${data.summary.returned}</span><p>Returned</p></article>
      <article><span>${data.summary.overdue}</span><p>Overdue</p></article>
      <article><span>${data.summary.averageMinutes}</span><p>Avg min</p></article>
    </div>
  `;
  header.querySelector('h3').textContent = data.matchedName;
  lookupResults.appendChild(header);

  if (data.studentEmail) {
    const exportLink = document.createElement('a');
    exportLink.className = 'ghost-button';
    exportLink.href = `/api/students/${encodeURIComponent(data.studentEmail)}/export`;
    exportLink.textContent = 'Export CSV';
    exportLink.target = '_blank';
    exportLink.rel = 'noopener';
    lookupResults.appendChild(exportLink);
  }

  const rows = document.createElement('div');
  rows.className = 'lookup-pass-list';
  data.passes.forEach((pass) => rows.appendChild(lookupPassRow(pass)));
  lookupResults.appendChild(rows);
}

async function loadTeacherDashboard() {
  const [pending, passes, history, stats] = await Promise.all([
    api('/api/requests'),
    api('/api/passes'),
    api('/api/history?limit=8'),
    api('/api/stats'),
  ]);

  activePasses = passes;
  renderPending(pending);
  renderOverdue(passes);
  renderActive();
  renderHistory(history);
  renderStats(stats);
}

async function loadStudentDashboard() {
  const [passes, teachers] = await Promise.all([
    api('/api/my/requests'),
    api('/api/teachers'),
  ]);
  renderStudentRequests(passes);
  renderTeacherSelect(teachers);
}

async function requestPass(event) {
  event.preventDefault();
  const submit = requestForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  showMessage(studentMessage, 'Sending request...');

  const formData = new FormData(requestForm);
  const payload = Object.fromEntries(formData.entries());
  payload.teacher = requestForm.querySelector('#teacher option:checked')?.textContent || '';

  try {
    await api('/api/requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    requestForm.reset();
    document.getElementById('maxMinutes').value = '10';
    showMessage(studentMessage, 'Pass request sent to teachers.', 'success');
    await loadStudentDashboard();
  } catch (err) {
    showMessage(studentMessage, err.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

async function approveRequest(id) {
  await api(`/api/requests/${id}/approve`, { method: 'POST' });
  await loadTeacherDashboard();
}

async function denyRequest(id) {
  await api(`/api/requests/${id}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Denied by teacher' }),
  });
  await loadTeacherDashboard();
}

async function endPass(id) {
  await api(`/api/passes/${id}/end`, { method: 'POST' });
  if (currentUser.role === 'teacher') {
    await loadTeacherDashboard();
  } else {
    showMessage(studentMessage, 'Pass marked returned.', 'success');
    await loadStudentDashboard();
  }
}

async function lookupStudent(event) {
  event.preventDefault();
  const formData = new FormData(lookupForm);
  const name = String(formData.get('name') || '').trim();
  const submit = lookupForm.querySelector('button[type="submit"]');

  if (!name) return;

  submit.disabled = true;
  lookupResults.replaceChildren(emptyState('Searching...'));

  try {
    const data = await api(`/api/students/search?name=${encodeURIComponent(name)}&limit=25`);
    renderLookupResults(data);
  } catch (err) {
    lookupResults.replaceChildren(emptyState(err.message));
  } finally {
    submit.disabled = false;
  }
}

async function toggleRole() {
  try {
    const response = await api('/auth/toggle-role', { method: 'POST' });
    currentUser.role = response.role;
    userRole.textContent = response.role;
    toggleRoleButton.textContent = response.role === 'teacher' ? 'Switch to Student' : 'Switch to Teacher';
    
    // Hide current view and show new view
    hide(studentView);
    hide(teacherView);
    
    if (response.role === 'teacher') {
      show(teacherView);
      await loadTeacherDashboard();
    } else {
      show(studentView);
      await loadStudentDashboard();
    }
  } catch (err) {
    console.error('Failed to toggle role:', err);
  }
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.warn('Logout request failed:', err);
  }

  currentUser = null;
  hide(userChip);
  hide(toggleRoleButton);
  hide(logoutButton);
  hide(studentView);
  hide(teacherView);
  show(authScreen);
}

function showSignedInUser(user) {
  currentUser = user;
  userName.textContent = user.name;
  userRole.textContent = user.role;
  show(userChip);
  show(logoutButton);
  
  if (user.canToggleRole) {
    show(toggleRoleButton);
    toggleRoleButton.textContent = user.role === 'teacher' ? 'Switch to Student' : 'Switch to Teacher';
  }
}

async function boot() {
  updateClock();
  const me = await api('/api/me');

  if (!me.authConfigured || !me.hasTeacherList) {
    document.getElementById('redirect-uri').textContent = me.redirectUri;
    document.getElementById('setup-copy').textContent = !me.authConfigured
      ? 'Add Google OAuth credentials before using Stag Pass. Your redirect URI should be:'
      : 'Teacher accounts must use lastname@cheverus.org and student accounts must use lastname.firstname@cheverus.org. Your Google redirect URI is:';
    show(setupScreen);
    return;
  }

  if (!me.user) {
    show(authScreen);
    return;
  }

  showSignedInUser(me.user);

  if (me.user.role === 'teacher') {
    show(teacherView);
    await loadTeacherDashboard();
  } else {
    show(studentView);
    await loadStudentDashboard();
  }
}

requestForm.addEventListener('submit', requestPass);
studentRefreshButton.addEventListener('click', loadStudentDashboard);
teacherRefreshButton.addEventListener('click', loadTeacherDashboard);
lookupForm.addEventListener('submit', lookupStudent);
logoutButton.addEventListener('click', logout);
toggleRoleButton.addEventListener('click', toggleRole);

boot().catch((err) => {
  hide(studentView);
  hide(teacherView);
  show(authScreen);
  document.getElementById('auth-title').textContent = 'Something needs attention';
  document.getElementById('auth-copy').textContent = err.message;
});
setInterval(updateClock, 1000);
// Reduced polling frequency since we now have real-time updates via Socket.IO
setInterval(renderActive, 300000); // Every 5 minutes as fallback
setInterval(() => {
  if (!currentUser) return;
  if (currentUser.role === 'teacher') loadTeacherDashboard().catch(() => {});
  else loadStudentDashboard().catch(() => {});
}, 30000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('Service worker registered:', registration.scope);

        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch((error) => console.warn('Service worker registration failed:', error));
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
