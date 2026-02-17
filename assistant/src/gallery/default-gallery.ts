import type { GalleryManifest } from './gallery-manifest.js';

const focusTimerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Focus Timer</title>
<style>
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --primary: #e94560;
    --primary-hover: #c73e54;
    --text: #eee;
    --text-secondary: #aaa;
    --break-color: #0f9b58;
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 20px;
  }
  .container {
    text-align: center;
    max-width: 400px;
    width: 100%;
  }
  h1 {
    font-size: 1.4rem;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .mode-label {
    font-size: 0.9rem;
    color: var(--text-secondary);
    margin-bottom: 32px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .mode-label.break { color: var(--break-color); }
  .timer-display {
    font-size: 5rem;
    font-weight: 200;
    font-variant-numeric: tabular-nums;
    letter-spacing: 2px;
    margin-bottom: 40px;
  }
  .controls {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin-bottom: 32px;
  }
  button {
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    padding: 10px 28px;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-primary {
    background: var(--primary);
    color: white;
  }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid #333;
  }
  .btn-secondary:hover { background: #1e2d4f; }
  .stats {
    display: flex;
    justify-content: center;
    gap: 32px;
  }
  .stat-item {
    text-align: center;
  }
  .stat-value {
    font-size: 1.6rem;
    font-weight: 600;
  }
  .stat-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Focus Timer</h1>
  <div class="mode-label" id="modeLabel">Work Session</div>
  <div class="timer-display" id="timerDisplay">25:00</div>
  <div class="controls">
    <button class="btn-primary" id="startBtn" onclick="toggleTimer()">Start</button>
    <button class="btn-secondary" id="resetBtn" onclick="resetTimer()">Reset</button>
  </div>
  <div class="stats">
    <div class="stat-item">
      <div class="stat-value" id="sessionCount">0</div>
      <div class="stat-label">Sessions</div>
    </div>
    <div class="stat-item">
      <div class="stat-value" id="totalMinutes">0</div>
      <div class="stat-label">Minutes</div>
    </div>
  </div>
</div>
<script>
  const WORK_MINUTES = 25;
  const BREAK_MINUTES = 5;
  let secondsLeft = WORK_MINUTES * 60;
  let isRunning = false;
  let isBreak = false;
  let intervalId = null;
  let sessions = 0;
  let totalMinutes = 0;

  function updateDisplay() {
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    document.getElementById('timerDisplay').textContent =
      String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function toggleTimer() {
    if (isRunning) {
      clearInterval(intervalId);
      isRunning = false;
      document.getElementById('startBtn').textContent = 'Start';
    } else {
      isRunning = true;
      document.getElementById('startBtn').textContent = 'Pause';
      intervalId = setInterval(function() {
        secondsLeft--;
        if (secondsLeft <= 0) {
          clearInterval(intervalId);
          isRunning = false;
          document.getElementById('startBtn').textContent = 'Start';
          if (!isBreak) {
            sessions++;
            totalMinutes += WORK_MINUTES;
            document.getElementById('sessionCount').textContent = sessions;
            document.getElementById('totalMinutes').textContent = totalMinutes;
            isBreak = true;
            secondsLeft = BREAK_MINUTES * 60;
            document.getElementById('modeLabel').textContent = 'Break Time';
            document.getElementById('modeLabel').classList.add('break');
          } else {
            isBreak = false;
            secondsLeft = WORK_MINUTES * 60;
            document.getElementById('modeLabel').textContent = 'Work Session';
            document.getElementById('modeLabel').classList.remove('break');
          }
        }
        updateDisplay();
      }, 1000);
    }
  }

  function resetTimer() {
    clearInterval(intervalId);
    isRunning = false;
    isBreak = false;
    secondsLeft = WORK_MINUTES * 60;
    document.getElementById('startBtn').textContent = 'Start';
    document.getElementById('modeLabel').textContent = 'Work Session';
    document.getElementById('modeLabel').classList.remove('break');
    updateDisplay();
  }

  updateDisplay();
</script>
</body>
</html>`;

const habitTrackerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Habit Tracker</title>
<style>
  :root {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface-hover: #263348;
    --primary: #6366f1;
    --primary-hover: #5558e6;
    --success: #22c55e;
    --text: #f1f5f9;
    --text-secondary: #94a3b8;
    --border: #334155;
    --radius: 10px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    min-height: 100vh;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }
  h1 { font-size: 1.4rem; font-weight: 600; }
  .add-form {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
  }
  .add-form input {
    flex: 1;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
    outline: none;
  }
  .add-form input:focus { border-color: var(--primary); }
  .add-form input::placeholder { color: var(--text-secondary); }
  button {
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 10px 18px;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-primary {
    background: var(--primary);
    color: white;
  }
  .btn-primary:hover { background: var(--primary-hover); }
  .days-header {
    display: grid;
    grid-template-columns: 1fr repeat(7, 40px);
    gap: 4px;
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .day-label {
    text-align: center;
    font-size: 0.7rem;
    color: var(--text-secondary);
    text-transform: uppercase;
  }
  .habit-row {
    display: grid;
    grid-template-columns: 1fr repeat(7, 40px);
    gap: 4px;
    padding: 10px 4px;
    border-radius: var(--radius);
    margin-bottom: 4px;
    align-items: center;
  }
  .habit-row:hover { background: var(--surface); }
  .habit-name {
    font-size: 0.9rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .check-cell {
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .check-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 2px solid var(--border);
    background: transparent;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    color: transparent;
    font-size: 14px;
  }
  .check-btn.checked {
    background: var(--success);
    border-color: var(--success);
    color: white;
  }
  .check-btn:hover { border-color: var(--success); }
  .delete-btn {
    background: transparent;
    color: var(--text-secondary);
    border: none;
    padding: 4px 8px;
    font-size: 0.8rem;
    cursor: pointer;
    border-radius: 4px;
  }
  .delete-btn:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
  .empty-state {
    text-align: center;
    padding: 48px 0;
    color: var(--text-secondary);
  }
</style>
</head>
<body>
<div class="header">
  <h1>Habit Tracker</h1>
</div>
<div class="add-form">
  <input type="text" id="habitInput" placeholder="Add a new habit..." onkeydown="if(event.key==='Enter')addHabit()">
  <button class="btn-primary" onclick="addHabit()">Add</button>
</div>
<div class="days-header">
  <div></div>
  <div class="day-label" id="d0"></div>
  <div class="day-label" id="d1"></div>
  <div class="day-label" id="d2"></div>
  <div class="day-label" id="d3"></div>
  <div class="day-label" id="d4"></div>
  <div class="day-label" id="d5"></div>
  <div class="day-label" id="d6"></div>
</div>
<div id="habitsList"></div>
<script>
  var vellum = window.vellum;
  var habits = [];
  var dates = [];

  function initDates() {
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dates = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    for (var j = 0; j < 7; j++) {
      var dt = new Date(dates[j] + 'T12:00:00');
      document.getElementById('d' + j).textContent = dayNames[dt.getDay()];
    }
  }

  function loadHabits() {
    vellum.data.query().then(function(records) {
      habits = records;
      render();
    });
  }

  function render() {
    var container = document.getElementById('habitsList');
    if (habits.length === 0) {
      container.innerHTML = '<div class="empty-state">No habits yet. Add one above!</div>';
      return;
    }
    var html = '';
    habits.forEach(function(record) {
      var completedDates = [];
      try { completedDates = JSON.parse(record.data.completedDates || '[]'); } catch(e) { console.error('Failed to parse completedDates for habit ' + record.id + ':', e); }
      html += '<div class="habit-row">';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span class="habit-name">' + escapeHtml(record.data.name) + '</span>';
      html += '<button class="delete-btn" onclick="deleteHabit(\\''+record.id+'\\')">x</button>';
      html += '</div>';
      dates.forEach(function(date) {
        var checked = completedDates.indexOf(date) !== -1;
        html += '<div class="check-cell">';
        html += '<button class="check-btn' + (checked ? ' checked' : '') + '" onclick="toggleDate(\\''+record.id+'\\',\\''+date+'\\')">';
        html += checked ? '\\u2713' : '';
        html += '</button></div>';
      });
      html += '</div>';
    });
    container.innerHTML = html;
  }

  function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function addHabit() {
    var input = document.getElementById('habitInput');
    var name = input.value.trim();
    if (!name) return;
    input.value = '';
    vellum.data.create({ name: name, completedDates: '[]' }).then(function() {
      loadHabits();
    });
  }

  function toggleDate(recordId, date) {
    var record = habits.find(function(h) { return h.id === recordId; });
    if (!record) return;
    var completedDates = [];
    try { completedDates = JSON.parse(record.data.completedDates || '[]'); } catch(e) { console.error('Failed to parse completedDates for habit ' + record.id + ':', e); }
    var idx = completedDates.indexOf(date);
    if (idx === -1) { completedDates.push(date); } else { completedDates.splice(idx, 1); }
    vellum.data.update(recordId, {
      name: record.data.name,
      completedDates: JSON.stringify(completedDates)
    }).then(function() {
      loadHabits();
    });
  }

  function deleteHabit(recordId) {
    vellum.data.delete(recordId).then(function() {
      loadHabits();
    });
  }

  initDates();
  loadHabits();
</script>
</body>
</html>`;

const expenseTrackerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Expense Tracker</title>
<style>
  :root {
    --bg: #0c0c1d;
    --surface: #161630;
    --surface-alt: #1c1c3a;
    --primary: #8b5cf6;
    --primary-hover: #7c4fe0;
    --text: #f0f0f5;
    --text-secondary: #8888a8;
    --border: #2a2a4a;
    --red: #ef4444;
    --green: #22c55e;
    --radius: 10px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    min-height: 100vh;
  }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; }
  .total-card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 20px;
    text-align: center;
  }
  .total-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .total-amount {
    font-size: 2.2rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .form-row {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  input, select {
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
    outline: none;
  }
  input:focus, select:focus { border-color: var(--primary); }
  input::placeholder { color: var(--text-secondary); }
  select { cursor: pointer; }
  option { background: var(--surface); }
  .input-amount { width: 100px; }
  .input-desc { flex: 1; min-width: 120px; }
  .input-date { width: 140px; }
  button {
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 10px 18px;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-primary {
    background: var(--primary);
    color: white;
  }
  .btn-primary:hover { background: var(--primary-hover); }
  .categories-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
    margin-bottom: 20px;
  }
  .category-card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 12px;
    text-align: center;
  }
  .cat-amount {
    font-size: 1.1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .cat-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .expense-list {
    margin-top: 16px;
  }
  .expense-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: var(--surface);
    border-radius: var(--radius);
    margin-bottom: 6px;
  }
  .expense-info {
    flex: 1;
    overflow: hidden;
  }
  .expense-desc {
    font-size: 0.9rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .expense-meta {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .expense-amount {
    font-size: 1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin-left: 12px;
    white-space: nowrap;
  }
  .delete-btn {
    background: transparent;
    color: var(--text-secondary);
    border: none;
    padding: 4px 8px;
    font-size: 0.8rem;
    cursor: pointer;
    margin-left: 8px;
    border-radius: 4px;
  }
  .delete-btn:hover { color: var(--red); background: rgba(239,68,68,0.1); }
  .empty-state {
    text-align: center;
    padding: 40px 0;
    color: var(--text-secondary);
  }
  .section-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
</style>
</head>
<body>
<h1>Expense Tracker</h1>
<div class="total-card">
  <div class="total-label">Total Spent</div>
  <div class="total-amount" id="totalAmount">$0.00</div>
</div>
<div class="form-row">
  <input type="number" class="input-amount" id="amountInput" placeholder="0.00" step="0.01" min="0">
  <select id="categorySelect">
    <option value="food">Food</option>
    <option value="transport">Transport</option>
    <option value="shopping">Shopping</option>
    <option value="bills">Bills</option>
    <option value="entertainment">Entertainment</option>
    <option value="other">Other</option>
  </select>
  <input type="text" class="input-desc" id="descInput" placeholder="Description..." onkeydown="if(event.key==='Enter')addExpense()">
  <input type="date" class="input-date" id="dateInput">
  <button class="btn-primary" onclick="addExpense()">Add</button>
</div>
<div class="section-title">By Category</div>
<div class="categories-grid" id="categoriesGrid"></div>
<div class="section-title">Recent Expenses</div>
<div class="expense-list" id="expenseList"></div>
<script>
  var vellum = window.vellum;
  var expenses = [];

  document.getElementById('dateInput').value = new Date().toISOString().slice(0, 10);

  function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function loadExpenses() {
    vellum.data.query().then(function(records) {
      expenses = records;
      expenses.sort(function(a, b) {
        return (b.data.date || '').localeCompare(a.data.date || '') || b.createdAt - a.createdAt;
      });
      render();
    });
  }

  function render() {
    var total = 0;
    var byCategory = {};
    expenses.forEach(function(r) {
      var amt = parseFloat(r.data.amount) || 0;
      total += amt;
      var cat = r.data.category || 'other';
      byCategory[cat] = (byCategory[cat] || 0) + amt;
    });

    document.getElementById('totalAmount').textContent = '$' + total.toFixed(2);

    var catHtml = '';
    var cats = Object.keys(byCategory).sort();
    cats.forEach(function(cat) {
      catHtml += '<div class="category-card">';
      catHtml += '<div class="cat-amount">$' + byCategory[cat].toFixed(2) + '</div>';
      catHtml += '<div class="cat-label">' + escapeHtml(cat.charAt(0).toUpperCase() + cat.slice(1)) + '</div>';
      catHtml += '</div>';
    });
    document.getElementById('categoriesGrid').innerHTML = catHtml || '<div class="empty-state">No categories yet</div>';

    var listHtml = '';
    if (expenses.length === 0) {
      listHtml = '<div class="empty-state">No expenses recorded yet. Add one above!</div>';
    } else {
      expenses.forEach(function(r) {
        var amt = parseFloat(r.data.amount) || 0;
        listHtml += '<div class="expense-item">';
        listHtml += '<div class="expense-info">';
        listHtml += '<div class="expense-desc">' + escapeHtml(r.data.description || 'No description') + '</div>';
        listHtml += '<div class="expense-meta">' + escapeHtml(r.data.category || 'other') + ' \\u00B7 ' + escapeHtml(r.data.date || '') + '</div>';
        listHtml += '</div>';
        listHtml += '<div class="expense-amount">$' + amt.toFixed(2) + '</div>';
        listHtml += '<button class="delete-btn" onclick="deleteExpense(\\''+r.id+'\\')">x</button>';
        listHtml += '</div>';
      });
    }
    document.getElementById('expenseList').innerHTML = listHtml;
  }

  function addExpense() {
    var amount = parseFloat(document.getElementById('amountInput').value);
    if (!amount || amount <= 0) return;
    var category = document.getElementById('categorySelect').value;
    var description = document.getElementById('descInput').value.trim() || 'Untitled';
    var date = document.getElementById('dateInput').value;
    vellum.data.create({
      amount: amount,
      category: category,
      description: description,
      date: date
    }).then(function() {
      document.getElementById('amountInput').value = '';
      document.getElementById('descInput').value = '';
      loadExpenses();
    });
  }

  function deleteExpense(id) {
    vellum.data.delete(id).then(function() {
      loadExpenses();
    });
  }

  loadExpenses();
</script>
</body>
</html>`;

export const defaultGallery: GalleryManifest = {
  version: 1,
  updatedAt: '2026-02-15T00:00:00Z',
  categories: [
    { id: 'productivity', name: 'Productivity', icon: '\u{1F4CB}' },
    { id: 'health', name: 'Health', icon: '\u{2764}\u{FE0F}' },
    { id: 'finance', name: 'Finance', icon: '\u{1F4B0}' },
  ],
  apps: [
    {
      id: 'gallery-focus-timer',
      name: 'Focus Timer',
      description: 'A clean countdown timer with 25-minute work sessions and 5-minute breaks. Track your completed sessions and total focus time.',
      icon: '\u{1F345}',
      category: 'productivity',
      version: '1.0.0',
      featured: true,
      schemaJson: JSON.stringify({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      htmlDefinition: focusTimerHtml,
    },
    {
      id: 'gallery-habit-tracker',
      name: 'Habit Tracker',
      description: 'Track daily habits with a 7-day view. Mark habits as complete each day and build streaks over time.',
      icon: '\u{2705}',
      category: 'health',
      version: '1.0.0',
      featured: true,
      schemaJson: JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string' },
          completedDates: { type: 'string' },
        },
        required: ['name', 'completedDates'],
      }),
      htmlDefinition: habitTrackerHtml,
    },
    {
      id: 'gallery-expense-tracker',
      name: 'Expense Tracker',
      description: 'Log expenses with amount, category, and date. View your total spending and per-category breakdown at a glance.',
      icon: '\u{1F4B8}',
      category: 'finance',
      version: '1.0.0',
      featured: true,
      schemaJson: JSON.stringify({
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['amount', 'category', 'description', 'date'],
      }),
      htmlDefinition: expenseTrackerHtml,
    },
  ],
};
