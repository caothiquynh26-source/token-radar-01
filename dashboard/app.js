// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the board, the live-token view, the model sandbox and each protocol's detail drawer.
// No network: every byte it shows is in data.js. No links out: nothing here names an address.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) {
    document.getElementById('board').innerHTML = '<p class="note">No radar data was loaded.</p>';
    return;
  }

  var rows = DATA.rows || [];
  var live = DATA.live || [];
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  function money(n) {
    if (n === null || n === undefined) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  // ---- header meta
  var meta = document.getElementById('meta');
  meta.innerHTML = '<b>' + DATA.board_size + ' rows</b> · ' + DATA.watchlist_size + ' watchlist · ' +
    DATA.early_size + ' early · snapshot ' + esc(DATA.as_of) + '<br>model ' + esc(DATA.model_version) +
    ' · fitted on ' + DATA.model.comp_count + ' launched comps';

  // ---- filter options
  var catSel = document.getElementById('cat');
  var chainSel = document.getElementById('chain');
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort().forEach(function (c) { catSel.add(new Option(c, c)); });
  chains.sort().forEach(function (c) { chainSel.add(new Option(c, c)); });

  var state = { q: '', cat: '', chain: '', sort: 'rank', dir: 1, tab: 'board' };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    list.sort(function (a, b) {
      var va, vb;
      if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'growth') { va = a.change_7d === null ? -Infinity : a.change_7d; vb = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { va = a.age_days === null ? -1 : a.age_days; vb = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'verdict') { va = a.farm.usd_per_hour; vb = b.farm.usd_per_hour; }
      else if (key === 'implied') { va = a.implied_value_usd; vb = b.implied_value_usd; }
      else { va = a.rank; vb = b.rank; }
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    var el = document.getElementById('board');
    document.getElementById('count').textContent = list.length + ' of ' + rows.length + ' rows';
    if (list.length === 0) {
      el.innerHTML = '<p class="note">No protocols match these filters.</p>';
      return;
    }
    var html = '<table class="board"><thead><tr>' +
      '<th class="num"><button type="button" data-sort="rank">Rank</button></th>' +
      '<th><button type="button" data-sort="rank">Protocol</button></th>' +
      '<th class="num"><button type="button" data-sort="implied">Implied value</button></th>' +
      '<th class="num"><button type="button" data-sort="tvl">TVL</button></th>' +
      '<th class="num"><button type="button" data-sort="growth">7d</button></th>' +
      '<th class="num"><button type="button" data-sort="age">Age</button></th>' +
      '<th class="num"><button type="button" data-sort="verdict">Farm $/h</button></th>' +
      '</tr></thead><tbody>';
    list.forEach(function (r) {
      var v = r.farm.usd_per_hour;
      var cls = v >= 10 ? 'good' : v < 0 ? 'poor' : '';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.watchlist ? ' class="watch"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '<span class="slug">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="num money">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num verdict ' + cls + '">' + (v >= 0 ? '$' : '−$') + Math.abs(v).toFixed(2) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table><p class="note">Rank 1 is the most valuable. Implied values come from the fitted model — TVL × category multiple × size × growth × maturity — and the farm $/h column is the plan’s expected value per hour. Click any row for the equation, the farm plan and the $/hour verdict.</p>';
    el.innerHTML = html;
    el.querySelectorAll('tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
    el.querySelectorAll('th button[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
        document.getElementById('sort').value = k;
        renderBoard();
      });
    });
  }

  // ---- detail drawer
  var drawer = document.getElementById('drawer');
  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var f = r.farm;
    var good = f.usd_per_hour >= 10;
    var steps = r.farm_steps.map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '</b>' + esc(s) + '</li>';
    }).join('');
    drawer.innerHTML =
      '<button type="button" class="close" id="drawer-close">Close ✕</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank ' + r.rank + ' · ' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorized') + ' · ' +
      esc((r.chains || []).join(', ') || 'no chain listed') + '</p>' +
      (r.description ? '<p>' + esc(r.description) + '</p>' : '') +
      (r.social ? '<p class="sub">Social: ' + esc(r.social) + '</p>' : '') +
      '<h3>Implied value</h3>' +
      '<p><b style="font-size:22px">' + moneyFull(r.implied_value_usd) + '</b> &nbsp;·&nbsp; 80% interval ' +
      money(r.interval_low_usd) + ' – ' + money(r.interval_high_usd) + ' (leave-one-out residuals)</p>' +
      '<h3>How the model got there</h3>' +
      '<div class="equation"><table>' +
      '<tr><td>TVL</td><td>' + moneyFull(r.tvl_usd) + '</td></tr>' +
      '<tr><td>× category multiple (' + esc(r.category || 'Uncategorized') + ')</td><td>' + r.multiple.toFixed(4) + '</td></tr>' +
      '<tr><td>× size multiplier (TVL / $100M) ^ γ</td><td>' + r.size_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>× growth multiplier (' + pct(r.change_7d) + ' in 7 days)</td><td>' + r.growth_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>× maturity multiplier (age ' + ageText(r.age_days) + ')</td><td>' + r.maturity_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td><b>= implied value</b></td><td><b>' + moneyFull(r.implied_value_usd) + '</b></td></tr>' +
      '</table></div>' +
      '<p class="note">The multiple is the winsorized median mcap/TVL of launched protocols in this category, adjusted for size, growth and maturity. Thin categories fall back to the overall multiple of ' + DATA.model.overall_multiple.toFixed(4) + '.</p>' +
      '<h3>Farm plan</h3><ol class="farm">' + steps + '</ol>' +
      '<div class="verdict-box' + (good ? '' : ' poor') + '">' +
      '<div class="big">' + (f.usd_per_hour >= 0 ? '$' : '−$') + Math.abs(f.usd_per_hour).toFixed(2) + ' / hour</div>' +
      '<p>Expected airdrop share ' + moneyFull(f.expected_usd) + ' (5% of implied value across ~25,000 wallets) − gas ' + moneyFull(f.gas_usd) +
      ', over ' + f.hours + ' hours of work with $' + f.capital_usd + ' of capital at stake. ' +
      (good ? 'Worth farming: the expected share clears the costs by a wide margin.' : 'Thin return: farm only if you already use this protocol, or wait for a points program to appear.') + '</p></div>';
    drawer.hidden = false;
    document.getElementById('drawer-close').addEventListener('click', closeDetail);
    history.replaceState(null, '', '#/detail/' + slug);
  }
  function closeDetail() {
    drawer.hidden = true;
    history.replaceState(null, '', '#/board');
  }

  // ---- live tab
  function renderLive() {
    var el = document.getElementById('live-list');
    el.innerHTML = '<div class="live-grid">' + live.map(function (p) {
      return '<div class="live-card"><b>' + esc(p.name) + '</b><div class="mcap">' + money(p.mcap_usd) + '</div>' +
        '<p>Market cap · TVL ' + money(p.tvl_usd) + ' · 7d ' + pct(p.change_7d) + '</p>' +
        '<p>' + esc(p.category || 'Uncategorized') + ' · ' + esc((p.chains || []).join(', ')) + '</p></div>';
    }).join('') + '</div>';
  }

  // ---- model tab
  function renderModel() {
    var m = DATA.model;
    var w = m.weights;
    var multRows = Object.keys(m.multiples).sort(function (a, b) { return m.multiples[b] - m.multiples[a]; })
      .map(function (c) {
        return '<tr><td>' + esc(c) + '</td><td class="num">' + (m.multiple_counts[c] || 0) + '</td><td class="num">' + m.multiples[c].toFixed(4) + '</td></tr>';
      }).join('');
    function testRows(s) {
      return '<tr><td>' + esc(s.name) + '</td><td class="num">' + s.test_count + '</td>' +
        '<td class="num">' + s.fitted_median_log_error.toFixed(3) + '</td><td class="num">' + s.starter_median_log_error.toFixed(3) + '</td>' +
        '<td class="num">' + s.median_error_ratio.toFixed(2) + '×</td><td class="num">' + s.rel_mse_improvement.toFixed(1) + '×</td></tr>';
    }
    var wf = DATA.held_out.walk_forward.map(testRows).join('');
    document.getElementById('model-body').innerHTML =
      '<div class="cards">' +
      '<div class="card"><h3>The model (radar-2)</h3><dl>' +
      '<dt>Formula</dt><dd>TVL × multiple × size × growth × maturity</dd>' +
      '<dt>Size exponent γ</dt><dd>' + w.size_gamma + '</dd>' +
      '<dt>Growth weight</dt><dd>' + w.growth_weight + '</dd>' +
      '<dt>Maturity floor</dt><dd>' + w.maturity_floor + '</dd>' +
      '<dt>Maturity range</dt><dd>' + w.maturity_range + ' over 1,095d</dd>' +
      '<dt>Overall multiple</dt><dd>' + m.overall_multiple.toFixed(4) + '</dd>' +
      '<dt>Comps fitted</dt><dd>' + m.comp_count + '</dd>' +
      '<dt>LOO interval (log)</dt><dd>' + m.loo_log_interval[0].toFixed(2) + ' to +' + m.loo_log_interval[1].toFixed(2) + '</dd>' +
      '</dl><p class="note">Weights were grid-searched in this build by leave-one-out median |log error| over the ' + m.comp_count +
      ' launched comps — never hand-picked, never a protocol name. Size is (TVL / $100M)^γ; growth is 1 + clamped 7d change × weight; maturity rises from the floor over 1,095 days.</p></div>' +
      '<div class="card"><h3>Category multiples</h3><table class="tests"><thead><tr><th>Category</th><th class="num">Comps</th><th class="num">Multiple</th></tr></thead><tbody>' + multRows + '</tbody></table>' +
      '<p class="note">Winsorized median mcap/TVL per category, on size/growth/maturity-adjusted ratios. Under 5 comps, a category falls back to the overall multiple.</p></div>' +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h3>Held-out tests — fitted model vs the house starter</h3>' +
      '<table class="tests"><thead><tr><th>Split</th><th class="num">Test n</th><th class="num">Fitted med |log err|</th><th class="num">Starter med |log err|</th><th class="num">Median ratio</th><th class="num">Rel MSE gain</th></tr></thead><tbody>' +
      testRows(DATA.held_out.loo) + wf + '</tbody></table>' +
      '<p class="note">Leave-one-out refits the multiples with one comp held out, 128 times. Walk-forward fits on protocols listed before the cutoff and tests on later-listed ones. Median |log error| is the typical miss in log terms (a miss of 1.0 means the prediction is off by a factor of e ≈ 2.7). Relative MSE is the mean squared relative error: it is dominated by one or two launched protocols whose tokens are nearly worthless (market cap under $100k on hundreds of millions of TVL) — no TVL-only model can predict those, so read it beside the median. On walk-forward the fitted model beats the starter on both; on leave-one-out it wins the median and loses the relative MSE to that one near-worthless bridge token.</p></div>';
  }

  // ---- tabs
  var tabs = document.querySelectorAll('.tab');
  function showTab(name) {
    state.tab = name;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.getElementById('board').hidden = name !== 'board';
    document.getElementById('filters').style.display = name === 'board' ? '' : 'none';
    document.getElementById('live').hidden = name !== 'live';
    document.getElementById('model').hidden = name !== 'model';
    if (name === 'live') renderLive();
    if (name === 'model') renderModel();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); history.replaceState(null, '', '#/' + t.getAttribute('data-tab')); });
  });

  // ---- filters
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  chainSel.addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  document.getElementById('sort').addEventListener('change', function (e) {
    state.sort = e.target.value; state.dir = e.target.value === 'rank' ? 1 : -1; renderBoard();
  });

  // ---- hash state: #/board, #/live, #/model, #/detail/<slug>, #/filter/<category>
  function fromHash() {
    var h = location.hash || '#/board';
    var m = h.match(/^#\/detail\/([\w-]+)$/);
    if (m && bySlug[m[1]]) { showTab('board'); openDetail(m[1]); return; }
    var f = h.match(/^#\/filter\/(.+)$/);
    if (f) {
      var cat = decodeURIComponent(f[1]);
      if (cats.indexOf(cat) >= 0) { state.cat = cat; catSel.value = cat; }
      showTab('board'); renderBoard(); return;
    }
    var t = h.match(/^#\/(board|live|model)$/);
    showTab(t ? t[1] : 'board');
    renderBoard();
  }
  window.addEventListener('hashchange', fromHash);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  renderBoard();
  fromHash();
})();
