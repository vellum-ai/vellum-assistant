/* ============================================================
   Vellum Widgets — Interactive JS Utilities
   Injected alongside vellum-design-system.css into all
   dynamic page WKWebViews via WKUserScript.

   API: window.vellum.widgets.*
   ============================================================ */

(function () {
  'use strict';

  // Extend the existing window.vellum namespace (created by the bridge script).
  if (!window.vellum) window.vellum = {};
  var widgets = {};

  // ─── SVG Chart Defaults ──────────────────────────────────────

  var defaultColors = {
    line: 'var(--v-accent, #8A5BE0)',
    fill: 'var(--v-accent, #8A5BE0)',
    bar: 'var(--v-accent, #8A5BE0)',
    grid: 'var(--v-surface-border, #334155)',
    text: 'var(--v-text-secondary, #94A3B8)',
    bg: 'transparent'
  };

  function resolveContainer(container) {
    if (typeof container === 'string') return document.getElementById(container) || document.querySelector(container);
    return container;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ─── Charts (SVG-based) ──────────────────────────────────────

  /**
   * Render an inline SVG sparkline.
   * @param {string|Element} container - Element or selector
   * @param {number[]} data - Array of numeric values
   * @param {object} [options]
   * @param {number} [options.width=200]
   * @param {number} [options.height=40]
   * @param {string} [options.color] - Stroke color
   * @param {number} [options.strokeWidth=2]
   * @param {boolean} [options.fill=true] - Show gradient fill
   */
  widgets.sparkline = function (container, data, options) {
    var el = resolveContainer(container);
    if (!el || !data || !data.length) return;

    var opts = Object.assign({ width: 200, height: 40, strokeWidth: 2, fill: true }, options);
    var w = opts.width, h = opts.height;
    var color = opts.color || defaultColors.line;
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    var range = max - min || 1;
    var pad = opts.strokeWidth;

    var points = data.map(function (v, i) {
      var x = (i / (data.length - 1)) * w;
      var y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });

    var uid = 'vw-spark-' + Math.random().toString(36).slice(2, 8);
    var fillMarkup = '';
    if (opts.fill) {
      fillMarkup =
        '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.3"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<polygon points="0,' + h + ' ' + points.join(' ') + ' ' + w + ',' + h + '" fill="url(#' + uid + ')" />';
    }

    el.innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg" style="display:block">' +
      fillMarkup +
      '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="' + opts.strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  };

  /**
   * Render an SVG bar chart.
   * @param {string|Element} container
   * @param {{label:string, value:number, color?:string}[]} data
   * @param {object} [options]
   * @param {number} [options.width=400]
   * @param {number} [options.height=200]
   * @param {number} [options.barGap=4]
   * @param {boolean} [options.showLabels=true]
   * @param {boolean} [options.showValues=true]
   * @param {boolean} [options.horizontal=false]
   */
  widgets.barChart = function (container, data, options) {
    var el = resolveContainer(container);
    if (!el || !data || !data.length) return;

    var opts = Object.assign({ width: 400, height: 200, barGap: 4, showLabels: true, showValues: true, horizontal: false }, options);
    var w = opts.width, h = opts.height;
    var maxVal = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;

    var labelH = opts.showLabels ? 24 : 0;
    var chartH = h - labelH;
    var barW = (w - (data.length - 1) * opts.barGap) / data.length;

    var bars = data.map(function (d, i) {
      var color = d.color || defaultColors.bar;
      var x, y, bw, bh;

      if (opts.horizontal) {
        bh = (chartH - (data.length - 1) * opts.barGap) / data.length;
        bw = (d.value / maxVal) * (w - 60);
        x = 0;
        y = i * (bh + opts.barGap);
        var labelSvg = '<text x="' + (bw + 4) + '" y="' + (y + bh / 2 + 4) + '" fill="' + defaultColors.text + '" font-size="11">' + d.label + ' (' + d.value + ')</text>';
        return '<rect x="' + x + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + color + '" />' + labelSvg;
      }

      bw = barW;
      bh = (d.value / maxVal) * chartH;
      x = i * (barW + opts.barGap);
      y = chartH - bh;
      var valLabel = opts.showValues
        ? '<text x="' + (x + bw / 2) + '" y="' + (y - 4) + '" text-anchor="middle" fill="' + defaultColors.text + '" font-size="11">' + d.value + '</text>'
        : '';
      var axisLabel = opts.showLabels
        ? '<text x="' + (x + bw / 2) + '" y="' + (chartH + 16) + '" text-anchor="middle" fill="' + defaultColors.text + '" font-size="11">' + d.label + '</text>'
        : '';
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + color + '"><title>' + d.label + ': ' + d.value + '</title></rect>' + valLabel + axisLabel;
    });

    el.innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="display:block;font-family:var(--v-font-family,-apple-system,sans-serif)">' +
      bars.join('') +
      '</svg>';
  };

  /**
   * Render an SVG line chart with gradient fill and hover crosshair.
   * @param {string|Element} container
   * @param {{label:string, value:number}[]} data
   * @param {object} [options]
   * @param {number} [options.width=400]
   * @param {number} [options.height=200]
   * @param {string} [options.color]
   * @param {boolean} [options.showDots=true]
   * @param {boolean} [options.showGrid=true]
   * @param {number} [options.gridLines=4]
   */
  widgets.lineChart = function (container, data, options) {
    var el = resolveContainer(container);
    if (!el || !data || !data.length) return;

    var opts = Object.assign({ width: 400, height: 200, showDots: true, showGrid: true, gridLines: 4 }, options);
    var w = opts.width, h = opts.height;
    var color = opts.color || defaultColors.line;
    var values = data.map(function (d) { return d.value; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var range = max - min || 1;
    var padT = 20, padB = 30, padL = 40, padR = 10;
    var cw = w - padL - padR, ch = h - padT - padB;

    var uid = 'vw-line-' + Math.random().toString(36).slice(2, 8);

    var gridMarkup = '';
    if (opts.showGrid) {
      for (var g = 0; g <= opts.gridLines; g++) {
        var gy = padT + (g / opts.gridLines) * ch;
        var gVal = max - (g / opts.gridLines) * range;
        gridMarkup +=
          '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + gy.toFixed(1) + '" stroke="' + defaultColors.grid + '" stroke-width="0.5" />' +
          '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" fill="' + defaultColors.text + '" font-size="10">' + Math.round(gVal) + '</text>';
      }
    }

    var points = data.map(function (d, i) {
      var x = padL + (i / (data.length - 1)) * cw;
      var y = padT + (1 - (d.value - min) / range) * ch;
      return { x: x, y: y, label: d.label, value: d.value };
    });
    var polyStr = points.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');

    var dots = '';
    if (opts.showDots) {
      dots = points.map(function (p) {
        return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3" fill="' + color + '"><title>' + p.label + ': ' + p.value + '</title></circle>';
      }).join('');
    }

    var labels = '';
    var step = Math.max(1, Math.floor(data.length / 6));
    for (var li = 0; li < data.length; li += step) {
      labels += '<text x="' + points[li].x.toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" fill="' + defaultColors.text + '" font-size="10">' + data[li].label + '</text>';
    }

    el.innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="display:block;font-family:var(--v-font-family,-apple-system,sans-serif)">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.2"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      gridMarkup +
      '<polygon points="' + padL + ',' + (padT + ch) + ' ' + polyStr + ' ' + (padL + cw) + ',' + (padT + ch) + '" fill="url(#' + uid + ')" />' +
      '<polyline points="' + polyStr + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      dots + labels +
      '</svg>';
  };

  /**
   * Render a circular progress ring / gauge.
   * @param {string|Element} container
   * @param {number} value - 0-100
   * @param {object} [options]
   * @param {number} [options.size=100]
   * @param {number} [options.strokeWidth=8]
   * @param {string} [options.color]
   * @param {string} [options.trackColor]
   * @param {string} [options.label] - Center text (defaults to value%)
   */
  widgets.progressRing = function (container, value, options) {
    var el = resolveContainer(container);
    if (!el) return;

    var opts = Object.assign({ size: 100, strokeWidth: 8 }, options);
    var s = opts.size, sw = opts.strokeWidth;
    var color = opts.color || defaultColors.line;
    var trackColor = opts.trackColor || defaultColors.grid;
    var r = (s - sw) / 2;
    var circ = 2 * Math.PI * r;
    var pct = clamp(value, 0, 100);
    var offset = circ * (1 - pct / 100);
    var label = opts.label !== undefined ? opts.label : Math.round(pct) + '%';

    el.innerHTML =
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '" xmlns="http://www.w3.org/2000/svg" style="display:block">' +
      '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" fill="none" stroke="' + trackColor + '" stroke-width="' + sw + '" />' +
      '<circle cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '" ' +
      'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '" ' +
      'stroke-linecap="round" transform="rotate(-90 ' + s / 2 + ' ' + s / 2 + ')" style="transition:stroke-dashoffset 0.6s ease"/>' +
      '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="' + defaultColors.text + '" font-size="' + Math.round(s * 0.22) + '" font-weight="600" font-family="var(--v-font-family,-apple-system,sans-serif)">' + label + '</text>' +
      '</svg>';
  };

  // ─── Data Formatting ─────────────────────────────────────────

  /**
   * Format a number as currency.
   * @param {number} amount
   * @param {string} [currency='USD']
   * @param {string} [locale]
   * @returns {string}
   */
  widgets.formatCurrency = function (amount, currency, locale) {
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: 'currency',
        currency: currency || 'USD'
      }).format(amount);
    } catch (e) {
      return (currency || '$') + Number(amount).toFixed(2);
    }
  };

  /**
   * Format a date string.
   * @param {string|Date} iso - ISO date string or Date object
   * @param {string} [format='medium'] - 'relative', 'short', 'medium', 'long', 'full', or Intl options key
   * @returns {string}
   */
  widgets.formatDate = function (iso, format) {
    var date = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(date.getTime())) return String(iso);

    if (format === 'relative') {
      var diff = Date.now() - date.getTime();
      var abs = Math.abs(diff);
      var future = diff < 0;
      var prefix = future ? 'in ' : '';
      var suffix = future ? '' : ' ago';
      if (abs < 60000) return 'just now';
      if (abs < 3600000) return prefix + Math.floor(abs / 60000) + 'm' + suffix;
      if (abs < 86400000) return prefix + Math.floor(abs / 3600000) + 'h' + suffix;
      if (abs < 2592000000) return prefix + Math.floor(abs / 86400000) + 'd' + suffix;
      return prefix + Math.floor(abs / 2592000000) + 'mo' + suffix;
    }

    var styleMap = { short: 'short', medium: 'medium', long: 'long', full: 'full' };
    var style = styleMap[format] || 'medium';

    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: style, timeStyle: style === 'short' ? undefined : 'short' }).format(date);
    } catch (e) {
      return date.toLocaleString();
    }
  };

  /**
   * Format a number with locale-aware formatting.
   * @param {number} value
   * @param {object} [options]
   * @param {boolean} [options.compact=false] - Use compact notation (1.2K, 3.4M)
   * @param {number} [options.decimals] - Fixed decimal places
   * @param {string} [options.locale]
   * @returns {string}
   */
  widgets.formatNumber = function (value, options) {
    var opts = Object.assign({}, options);
    try {
      var intlOpts = {};
      if (opts.compact) intlOpts.notation = 'compact';
      if (opts.decimals !== undefined) {
        intlOpts.minimumFractionDigits = opts.decimals;
        intlOpts.maximumFractionDigits = opts.decimals;
      }
      return new Intl.NumberFormat(opts.locale || undefined, intlOpts).format(value);
    } catch (e) {
      return String(value);
    }
  };

  // ─── Interactive Behaviors ───────────────────────────────────

  /**
   * Make table columns sortable by clicking headers.
   * @param {string} tableId - ID of the .v-data-table element
   * @param {number} [columnIndex] - Sort by this column immediately (optional)
   */
  widgets.sortTable = function (tableId, columnIndex) {
    var table = document.getElementById(tableId);
    if (!table) return;

    var headers = table.querySelectorAll('thead th[data-sortable]');
    if (!headers.length) {
      headers = table.querySelectorAll('thead th');
    }

    function sortBy(idx, header) {
      var tbody = table.querySelector('tbody');
      if (!tbody) return;
      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));

      var dir = header.getAttribute('aria-sort');
      dir = dir === 'ascending' ? 'descending' : 'ascending';

      // Reset other headers
      headers.forEach(function (h) { h.removeAttribute('aria-sort'); });
      header.setAttribute('aria-sort', dir);

      rows.sort(function (a, b) {
        var aCell = a.cells[idx], bCell = b.cells[idx];
        if (!aCell || !bCell) return 0;
        var aVal = (aCell.getAttribute('data-sort-value') || aCell.textContent).trim();
        var bVal = (bCell.getAttribute('data-sort-value') || bCell.textContent).trim();
        var aNum = parseFloat(aVal), bNum = parseFloat(bVal);
        var result;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          result = aNum - bNum;
        } else {
          result = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
        }
        return dir === 'descending' ? -result : result;
      });

      rows.forEach(function (row) { tbody.appendChild(row); });
    }

    headers.forEach(function (header, i) {
      header.style.cursor = 'pointer';
      header.setAttribute('role', 'columnheader');
      header.addEventListener('click', function () { sortBy(i, header); });
      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(i, header); }
      });
      header.setAttribute('tabindex', '0');
    });

    if (columnIndex !== undefined && headers[columnIndex]) {
      sortBy(columnIndex, headers[columnIndex]);
    }
  };

  /**
   * Live text filtering of table rows.
   * @param {string} tableId
   * @param {string} searchInputId
   */
  widgets.filterTable = function (tableId, searchInputId) {
    var table = document.getElementById(tableId);
    var input = document.getElementById(searchInputId);
    if (!table || !input) return;

    input.addEventListener('input', function () {
      var query = input.value.toLowerCase().trim();
      var rows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row) {
        var text = row.textContent.toLowerCase();
        row.style.display = query && text.indexOf(query) === -1 ? 'none' : '';
      });
    });
  };

  /**
   * Wire up tab switching with aria attributes.
   * @param {string} containerId - ID of the .v-tabs container
   */
  widgets.tabs = function (containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var tabs = container.querySelectorAll('.v-tab');
    var panels = container.querySelectorAll('.v-tab-panel');

    function activate(tab) {
      tabs.forEach(function (t) {
        t.setAttribute('aria-selected', 'false');
        t.classList.remove('active');
        t.setAttribute('tabindex', '-1');
      });
      panels.forEach(function (p) { p.hidden = true; });

      tab.setAttribute('aria-selected', 'true');
      tab.classList.add('active');
      tab.setAttribute('tabindex', '0');

      var targetId = tab.getAttribute('aria-controls') || tab.getAttribute('data-panel');
      if (targetId) {
        var panel = document.getElementById(targetId);
        if (panel) panel.hidden = false;
      } else {
        // Fall back to index-based matching
        var idx = Array.prototype.indexOf.call(tabs, tab);
        if (panels[idx]) panels[idx].hidden = false;
      }
    }

    tabs.forEach(function (tab) {
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', function () { activate(tab); });
      tab.addEventListener('keydown', function (e) {
        var idx = Array.prototype.indexOf.call(tabs, tab);
        if (e.key === 'ArrowRight' && idx < tabs.length - 1) { e.preventDefault(); tabs[idx + 1].focus(); activate(tabs[idx + 1]); }
        if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); tabs[idx - 1].focus(); activate(tabs[idx - 1]); }
      });
    });

    panels.forEach(function (panel) { panel.setAttribute('role', 'tabpanel'); });

    // Activate first tab by default if none selected
    var active = container.querySelector('.v-tab[aria-selected="true"], .v-tab.active');
    if (!active && tabs.length) active = tabs[0];
    if (active) activate(active);
  };

  /**
   * Wire up accordion expand/collapse.
   * @param {string} containerId - ID of the .v-accordion container
   * @param {object} [options]
   * @param {boolean} [options.allowMultiple=true]
   */
  widgets.accordion = function (containerId, options) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var opts = Object.assign({ allowMultiple: true }, options);
    var headers = container.querySelectorAll('.v-accordion-header');

    headers.forEach(function (header) {
      var body = header.nextElementSibling;
      if (!body || !body.classList.contains('v-accordion-body')) return;

      var expanded = header.getAttribute('aria-expanded') === 'true';
      if (!expanded) body.style.display = 'none';
      header.setAttribute('aria-expanded', expanded ? 'true' : 'false');

      header.addEventListener('click', function () {
        var isExpanded = header.getAttribute('aria-expanded') === 'true';

        if (!opts.allowMultiple && !isExpanded) {
          headers.forEach(function (h) {
            if (h !== header) {
              h.setAttribute('aria-expanded', 'false');
              var b = h.nextElementSibling;
              if (b && b.classList.contains('v-accordion-body')) b.style.display = 'none';
            }
          });
        }

        header.setAttribute('aria-expanded', isExpanded ? 'false' : 'true');
        body.style.display = isExpanded ? 'none' : '';
      });

      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
      });
      header.setAttribute('tabindex', '0');
    });
  };

  /**
   * Checkbox multi-select with "select all" and bulk action support.
   * @param {string} tableId - ID of the .v-data-table
   */
  widgets.multiSelect = function (tableId) {
    var table = document.getElementById(tableId);
    if (!table) return;

    var selectAll = table.querySelector('thead input[type="checkbox"]');
    var checkboxes = table.querySelectorAll('tbody input[type="checkbox"]');

    function getSelected() {
      var ids = [];
      checkboxes.forEach(function (cb) {
        if (cb.checked) {
          var row = cb.closest('tr');
          ids.push(row ? (row.getAttribute('data-id') || row.rowIndex) : cb.value);
        }
      });
      return ids;
    }

    function updateSelectAll() {
      if (!selectAll) return;
      var total = checkboxes.length;
      var checked = Array.prototype.filter.call(checkboxes, function (cb) { return cb.checked; }).length;
      selectAll.checked = checked === total && total > 0;
      selectAll.indeterminate = checked > 0 && checked < total;
    }

    if (selectAll) {
      selectAll.addEventListener('change', function () {
        checkboxes.forEach(function (cb) {
          cb.checked = selectAll.checked;
          var row = cb.closest('tr');
          if (row) row.classList.toggle('selected', cb.checked);
        });
        if (window.vellum && window.vellum.sendAction) {
          window.vellum.sendAction('multiSelect', { tableId: tableId, selected: getSelected() });
        }
      });
    }

    checkboxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        var row = cb.closest('tr');
        if (row) row.classList.toggle('selected', cb.checked);
        updateSelectAll();
        if (window.vellum && window.vellum.sendAction) {
          window.vellum.sendAction('multiSelect', { tableId: tableId, selected: getSelected() });
        }
      });
    });
  };

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {string} [type='info'] - 'success', 'error', 'warning', 'info'
   * @param {number} [duration=4000] - Auto-dismiss in ms (0 = manual only)
   */
  widgets.toast = function (message, type, duration) {
    type = type || 'info';
    duration = duration !== undefined ? duration : 4000;

    var toastContainer = document.getElementById('v-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'v-toast-container';
      toastContainer.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:400px';
      document.body.appendChild(toastContainer);
    }

    var icons = { success: '\u2713', error: '\u2717', warning: '\u26A0', info: '\u2139' };
    var toast = document.createElement('div');
    toast.className = 'v-toast ' + type;
    toast.style.pointerEvents = 'auto';
    toast.setAttribute('role', 'alert');
    toast.innerHTML =
      '<span>' + (icons[type] || '') + '</span>' +
      '<span style="flex:1">' + message + '</span>' +
      '<button class="v-toast-dismiss" aria-label="Dismiss">\u00D7</button>';

    var dismiss = toast.querySelector('.v-toast-dismiss');
    dismiss.addEventListener('click', function () { remove(); });

    function remove() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'opacity 0.2s, transform 0.2s';
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
    }

    toastContainer.appendChild(toast);

    // Animate in
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    requestAnimationFrame(function () {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });

    if (duration > 0) setTimeout(remove, duration);
  };

  /**
   * Live countdown timer.
   * @param {string|Element} container
   * @param {string|Date} targetDate - ISO date string or Date
   * @param {object} [options]
   * @param {function} [options.onComplete] - Called when countdown reaches zero
   * @param {string} [options.format='dhms'] - 'd' days, 'h' hours, 'm' minutes, 's' seconds
   */
  widgets.countdown = function (container, targetDate, options) {
    var el = resolveContainer(container);
    if (!el) return;

    var opts = Object.assign({ format: 'dhms' }, options);
    var target = targetDate instanceof Date ? targetDate : new Date(targetDate);

    function pad(n) { return n < 10 ? '0' + n : n; }

    function update() {
      var diff = target.getTime() - Date.now();
      if (diff <= 0) {
        el.textContent = '00:00:00';
        if (opts.onComplete) opts.onComplete();
        return;
      }

      var parts = [];
      var d = Math.floor(diff / 86400000);
      var h = Math.floor((diff % 86400000) / 3600000);
      var m = Math.floor((diff % 3600000) / 60000);
      var s = Math.floor((diff % 60000) / 1000);

      if (opts.format.indexOf('d') !== -1 && d > 0) parts.push(d + 'd');
      if (opts.format.indexOf('h') !== -1) parts.push(pad(h));
      if (opts.format.indexOf('m') !== -1) parts.push(pad(m));
      if (opts.format.indexOf('s') !== -1) parts.push(pad(s));

      el.textContent = parts.join(':');
      requestAnimationFrame(update);
    }

    update();
  };

  window.vellum.widgets = widgets;
})();
