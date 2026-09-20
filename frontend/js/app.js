import { authenticatedFetch } from './api.js';
import {
  displayNameFor,
  observeAuth,
  requireAuthenticatedUser,
  signInWithGoogle,
  signOut
} from './auth.js';

/**
 * Knocknet Application Controller
 * Manages Host/Join mode switching, 60s timed access tokens, interactive calendar,
 * meeting scheduling, and Spring Boot REST integration.
 */
document.addEventListener('DOMContentLoaded', () => {
  const authButton = document.getElementById('btn-auth');
  const authStatus = document.getElementById('auth-status');

  observeAuth((user) => {
    authButton.textContent = user ? 'SIGN OUT' : 'SIGN IN WITH GOOGLE';
    authStatus.textContent = user ? displayNameFor(user) : 'SIGN IN REQUIRED';
    authStatus.classList.toggle('authenticated', Boolean(user));
    if (user) loadScheduledMeetings();
    else renderMeetingsList([]);
  });

  authButton.addEventListener('click', async () => {
    try {
      if (authButton.textContent === 'SIGN OUT') await signOut();
      else await signInWithGoogle();
    } catch (error) {
      showToast(error.message || 'Unable to complete sign in');
    }
  });

  // 1. Live Clock
  const liveTimeDisplay = document.getElementById('live-time-display');
  function updateLiveClock() {
    const now = new Date();
    liveTimeDisplay.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  updateLiveClock();
  setInterval(updateLiveClock, 1000);

  // 2. Mode Switcher (Host Conference vs Join Conference)
  const tabBtnHost = document.getElementById('tab-btn-host');
  const tabBtnJoin = document.getElementById('tab-btn-join');
  const panelHost = document.getElementById('panel-host');
  const panelJoin = document.getElementById('panel-join');

  tabBtnHost.addEventListener('click', () => {
    tabBtnHost.classList.add('active');
    tabBtnJoin.classList.remove('active');
    panelHost.classList.add('active');
    panelJoin.classList.remove('active');
  });

  tabBtnJoin.addEventListener('click', () => {
    tabBtnJoin.classList.add('active');
    tabBtnHost.classList.remove('active');
    panelJoin.classList.add('active');
    panelHost.classList.remove('active');
    // Auto-focus first digit box
    const firstDigit = document.getElementById('digit-0');
    if (firstDigit) firstDigit.focus();
  });

  // 3. Host Conference Flow
  const btnCapDec = document.getElementById('btn-cap-dec');
  const btnCapInc = document.getElementById('btn-cap-inc');
  const capDisplay = document.getElementById('capacity-display');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const hostSessionTitle = document.getElementById('host-session-title');

  const roomCreatedCard = document.getElementById('room-created-card');
  const createdRoomCode = document.getElementById('created-room-code');
  const shareLinkInput = document.getElementById('share-link-input');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnEnterRoom = document.getElementById('btn-enter-room');
  const timerRing = document.getElementById('timer-ring');
  const countdownText = document.getElementById('countdown-text');

  let currentCapacity = 6;
  let countdownInterval = null;
  const CIRCLE_CIRCUMFERENCE = 62.83; // 2 * Math.PI * 10

  btnCapDec.addEventListener('click', () => {
    if (currentCapacity > 2) {
      currentCapacity--;
      capDisplay.textContent = currentCapacity;
    }
  });

  btnCapInc.addEventListener('click', () => {
    if (currentCapacity < 8) {
      currentCapacity++;
      capDisplay.textContent = currentCapacity;
    }
  });

  btnCreateRoom.addEventListener('click', async () => {
    btnCreateRoom.disabled = true;
    btnCreateRoom.innerHTML = '<span>Creating private room...</span>';

    try {
      const user = await requireAuthenticatedUser();
      const res = await authenticatedFetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxParticipants: currentCapacity,
          hostName: displayNameFor(user),
          title: hostSessionTitle.value.trim()
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Room provisioning failed');
      }

      createdRoomCode.textContent = data.code;
      const fullJoinUrl = `${window.location.origin}/room.html#invite=${encodeURIComponent(data.code)}`;
      shareLinkInput.value = fullJoinUrl;
      sessionStorage.setItem('knocknet_roomId', data.roomId);
      sessionStorage.setItem('knocknet_displayName', displayNameFor(user));
      
      btnEnterRoom.onclick = () => {
        window.location.href = '/room.html';
      };

      roomCreatedCard.classList.add('active');
      startCountdownTimer(data.codeSecondsRemaining || 60);
      showToast('Private room created. The invite expires in 60 seconds.');

    } catch (err) {
      showToast('Error provisioning session: ' + err.message);
    } finally {
      btnCreateRoom.disabled = false;
      btnCreateRoom.innerHTML = `
        <span>Create Private Room</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      `;
    }
  });

  function startCountdownTimer(secondsTotal) {
    if (countdownInterval) clearInterval(countdownInterval);
    let remaining = secondsTotal;

    function updateTick() {
      countdownText.textContent = `${remaining}s`;
      const fraction = remaining / 60;
      const offset = CIRCLE_CIRCUMFERENCE * (1 - fraction);
      timerRing.style.strokeDashoffset = offset;

      if (remaining <= 10) {
        timerRing.style.stroke = '#df5858';
      } else {
        timerRing.style.stroke = 'var(--primary)';
      }

      if (remaining <= 0) {
        clearInterval(countdownInterval);
        countdownText.textContent = 'EXPIRED';
        countdownText.style.color = '#df5858';
        timerRing.style.stroke = '#df5858';
      }
      remaining--;
    }

    updateTick();
    countdownInterval = setInterval(updateTick, 1000);
  }

  btnCopyLink.addEventListener('click', async () => {
    if (!shareLinkInput.value) return;
    try {
      await navigator.clipboard.writeText(shareLinkInput.value);
      btnCopyLink.textContent = 'COPIED!';
      showToast('Direct join link copied to clipboard');
      setTimeout(() => { btnCopyLink.textContent = 'COPY'; }, 2000);
    } catch (err) {
      shareLinkInput.select();
      document.execCommand('copy');
      showToast('Direct join link copied');
    }
  });

  // 4. Join Conference Flow (6-Digit Boxes)
  const digitBoxes = Array.from(document.querySelectorAll('.digit-box'));
  const btnSubmitCode = document.getElementById('btn-submit-code');
  const joinAlertBanner = document.getElementById('join-alert-banner');

  digitBoxes.forEach((box, index) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '');
      box.value = val;

      if (val) {
        box.classList.add('filled');
        if (index < 5) {
          digitBoxes[index + 1].focus();
        }
      } else {
        box.classList.remove('filled');
      }
      checkCodeComplete();
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (!box.value && index > 0) {
          digitBoxes[index - 1].focus();
          digitBoxes[index - 1].value = '';
          digitBoxes[index - 1].classList.remove('filled');
        }
      } else if (e.key === 'ArrowLeft' && index > 0) {
        digitBoxes[index - 1].focus();
      } else if (e.key === 'ArrowRight' && index < 5) {
        digitBoxes[index + 1].focus();
      } else if (e.key === 'Enter') {
        if (!btnSubmitCode.disabled) {
          btnSubmitCode.click();
        }
      }
    });

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text');
      const cleanDigits = pasteData.replace(/\D/g, '').slice(0, 6);
      if (!cleanDigits) return;

      cleanDigits.split('').forEach((char, i) => {
        if (i < 6) {
          digitBoxes[i].value = char;
          digitBoxes[i].classList.add('filled');
        }
      });

      const nextFocus = Math.min(cleanDigits.length, 5);
      digitBoxes[nextFocus].focus();
      checkCodeComplete();
    });
  });

  function getEnteredCode() {
    return digitBoxes.map(b => b.value).join('');
  }

  function checkCodeComplete() {
    const code = getEnteredCode();
    const isComplete = code.length === 6;
    btnSubmitCode.disabled = !isComplete;
    if (isComplete) {
      hideAlert();
    }
  }

  btnSubmitCode.addEventListener('click', async () => {
    const code = getEnteredCode();
    if (code.length !== 6) return;

    btnSubmitCode.disabled = true;
    btnSubmitCode.innerHTML = '<span>Verifying Token...</span>';
    hideAlert();

    try {
      const user = await requireAuthenticatedUser();
      const res = await authenticatedFetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        const errMsg = data.message || 'Verification failed';
        showAlert(errMsg, 'error');
        return;
      }

      sessionStorage.setItem('knocknet_roomId', data.roomId);
      sessionStorage.setItem('knocknet_displayName', displayNameFor(user));
      showToast('Identity and invitation verified. Entering room...');
      setTimeout(() => {
        window.location.href = '/room.html';
      }, 400);

    } catch (err) {
      showAlert('Connection error: ' + err.message, 'error');
    } finally {
      btnSubmitCode.disabled = false;
      btnSubmitCode.innerHTML = `
        <span>JOIN CONFERENCE</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      `;
    }
  });

  function showAlert(msg, type = 'error') {
    joinAlertBanner.style.display = '';
    joinAlertBanner.textContent = msg;
    joinAlertBanner.className = 'alert-banner ' + type;
  }

  function hideAlert() {
    joinAlertBanner.style.display = 'none';
    joinAlertBanner.className = 'alert-banner';
  }

  // 5. Interactive Calendar Logic
  let viewDate = new Date();
  let selectedDate = new Date();
  const calMonthYear = document.getElementById('cal-month-year');
  const calSelectedDateStr = document.getElementById('cal-selected-date-str');
  const calendarGrid = document.getElementById('calendar-grid');
  const btnCalPrev = document.getElementById('btn-cal-prev');
  const btnCalNext = document.getElementById('btn-cal-next');

  btnCalPrev.addEventListener('click', () => {
    viewDate.setMonth(viewDate.getMonth() - 1);
    renderCalendar();
  });

  btnCalNext.addEventListener('click', () => {
    viewDate.setMonth(viewDate.getMonth() + 1);
    renderCalendar();
  });

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    calMonthYear.textContent = `${monthNames[month]} ${year}`;
    calSelectedDateStr.textContent = selectedDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

    // Keep weekday headers
    const weekdayHeaders = Array.from(calendarGrid.querySelectorAll('.cal-weekday'));
    calendarGrid.innerHTML = '';
    weekdayHeaders.forEach(el => calendarGrid.appendChild(el));

    // First day of month (0 = Sun, 1 = Mon, etc.)
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const today = new Date();

    // Empty cells before 1st
    for (let i = 0; i < firstDay; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'cal-day-cell empty';
      calendarGrid.appendChild(emptyCell);
    }

    // Days 1..N
    for (let day = 1; day <= daysInMonth; day++) {
      const cell = document.createElement('div');
      cell.className = 'cal-day-cell';
      cell.textContent = day;

      const isToday = (day === today.getDate() && month === today.getMonth() && year === today.getFullYear());
      const isSelected = (day === selectedDate.getDate() && month === selectedDate.getMonth() && year === selectedDate.getFullYear());

      if (isToday) cell.classList.add('today');
      if (isSelected) cell.classList.add('selected');

      // Sample indicator for days with meetings
      if (day === today.getDate() || day === today.getDate() + 2) {
        cell.classList.add('has-meeting');
      }

      cell.addEventListener('click', () => {
        selectedDate = new Date(year, month, day);
        renderCalendar();
      });

      calendarGrid.appendChild(cell);
    }
  }

  renderCalendar();

  // 6. Scheduled Conferences Integration
  const scheduleList = document.getElementById('schedule-list');
  const btnOpenScheduleModal = document.getElementById('btn-open-schedule-modal');
  const scheduleModal = document.getElementById('schedule-modal');
  const btnCloseScheduleModal = document.getElementById('btn-close-schedule-modal');
  const btnConfirmSchedule = document.getElementById('btn-confirm-schedule');

  const schedTitle = document.getElementById('sched-title');
  const schedTime = document.getElementById('sched-time');
  const schedHost = document.getElementById('sched-host');
  const btnSchedCapDec = document.getElementById('btn-sched-cap-dec');
  const btnSchedCapInc = document.getElementById('btn-sched-cap-inc');
  const schedCapVal = document.getElementById('sched-cap-val');

  let schedCapacity = 6;

  btnSchedCapDec.addEventListener('click', () => {
    if (schedCapacity > 2) {
      schedCapacity--;
      schedCapVal.textContent = schedCapacity;
    }
  });

  btnSchedCapInc.addEventListener('click', () => {
    if (schedCapacity < 8) {
      schedCapacity++;
      schedCapVal.textContent = schedCapacity;
    }
  });

  btnOpenScheduleModal.addEventListener('click', () => {
    scheduleModal.classList.add('active');
  });

  btnCloseScheduleModal.addEventListener('click', () => {
    scheduleModal.classList.remove('active');
  });

  scheduleModal.addEventListener('click', (e) => {
    if (e.target === scheduleModal) scheduleModal.classList.remove('active');
  });

  async function loadScheduledMeetings() {
    try {
      const res = await authenticatedFetch('/api/rooms/schedule');
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.meetings)) {
          renderMeetingsList(data.meetings);
        }
      }
    } catch (e) {
      console.warn('Could not load schedule:', e);
    }
  }

  function renderMeetingsList(meetings) {
    scheduleList.innerHTML = '';
    if (!meetings || meetings.length === 0) {
      scheduleList.innerHTML = '<div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--secondary-muted); padding: 0.5rem 0;">No meetings scheduled for this date.</div>';
      return;
    }

    meetings.forEach(m => {
      const item = document.createElement('div');
      item.className = 'schedule-item';

      item.innerHTML = `
        <div class="schedule-item-info">
          <div class="schedule-item-title">${escapeHtml(m.title)}</div>
          <div class="schedule-item-meta">
            <span>● ${escapeHtml(m.scheduledTime || 'Today')}</span>
            <span>CAP: ${m.maxParticipants || 6} PEERS</span>
          </div>
        </div>
        <div class="schedule-item-actions">
          <button type="button" class="btn-launch-schedule" data-room-id="${m.roomId}">
            LAUNCH / JOIN
          </button>
        </div>
      `;

      item.querySelector('.btn-launch-schedule').addEventListener('click', () => {
        sessionStorage.setItem('knocknet_roomId', m.roomId);
        sessionStorage.setItem('knocknet_displayName', m.hostName || 'Participant');
        window.location.href = '/room.html';
      });

      scheduleList.appendChild(item);
    });
  }

  btnConfirmSchedule.addEventListener('click', async () => {
    const title = schedTitle.value.trim() || 'Planned Conference';
    const time = schedTime.value.trim() || 'Today';
    const host = schedHost.value.trim() || 'Host';

    try {
      const res = await authenticatedFetch('/api/rooms/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          scheduledTime: time,
          maxParticipants: schedCapacity,
          hostName: host
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        scheduleModal.classList.remove('active');
        showToast('Conference scheduled for ' + time);
        loadScheduledMeetings();
      }
    } catch (err) {
      showToast('Error scheduling meeting: ' + err.message);
    }
  });

  // Toast
  const toastNotice = document.getElementById('toast-notice');
  function showToast(text) {
    toastNotice.textContent = text;
    toastNotice.classList.add('show');
    setTimeout(() => {
      toastNotice.classList.remove('show');
    }, 2800);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
