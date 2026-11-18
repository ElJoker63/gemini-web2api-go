// 单出口能打多少次的实测区间是 80-180，取下沿当参考线。
// 它不是一条硬线：能打多少主要看连接复用和出口质量，而平缓节奏几乎打不满。
const BAN_LINE = 80;

const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: 'include', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { renderLogin(); throw new Error('unauthorized'); }
  return r.json();
};

const fmt = {
  ts: (sec) => new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }),
  ms: (ms) => ms == null ? '-' : (ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(2) + 's'),
  num: (n) => (n || 0).toLocaleString(),
  pct: (n) => (n * 100).toFixed(1) + '%',
};

let charts = {};
const destroyChart = (key) => { if (charts[key]) { charts[key].destroy(); delete charts[key]; } };

// ─── Pages ──────────────────────────────────────────────────────────────────

const pages = {
  dashboard: async () => {
    const stats = await api('api/stats?hours=24');
    const usage = await api('api/usage');
    return `
      <div class="kpi-row">
        <div class="kpi"><div class="label">24 小时请求</div><div class="value">${fmt.num(stats.total_requests)}</div></div>
        <div class="kpi"><div class="label">成功率</div><div class="value">${fmt.pct(stats.success_rate)}</div>
          <div class="sub">${fmt.num(stats.success)} 成功 · ${fmt.num(stats.failures)} 失败</div></div>
        <div class="kpi"><div class="label">平均延迟</div><div class="value">${fmt.ms(stats.avg_ms)}</div></div>
        <div class="kpi"><div class="label">输入 Token</div><div class="value">${fmt.num(stats.prompt_tokens)}</div></div>
        <div class="kpi"><div class="label">输出 Token</div><div class="value">${fmt.num(stats.output_tokens)}</div></div>
      </div>

      <div class="grid-main">
        <div class="panel">
          <h2>请求量与延迟
            <span class="controls">
              <select id="rangeSel">
                <option value="24h">最近 24 小时</option>
                <option value="7d">最近 7 天</option>
                <option value="30d">最近 30 天</option>
              </select>
            </span>
          </h2>
          <div class="chart-wrap"><canvas id="chartReq"></canvas></div>
        </div>

        <div class="stack">
        <div class="panel">
          <h2>距离封禁红线
            <span class="controls"><button onclick="refreshPage()">刷新</button></span>
          </h2>
          <div class="slot-scroll">
            ${(usage.items || []).map(u => {
              const rph = u.rph || 0;
              const limit = u.limit_rph || 0;
              const pct = Math.min(rph / BAN_LINE * 100, 100);
              const limitPct = limit ? Math.min(limit / BAN_LINE * 100, 100) : null;
              const left = Math.max(BAN_LINE - rph, 0);
              let noteCls = '', note = `还能再打约 ${left} 次`;
              if (rph >= BAN_LINE) { noteCls = 'danger'; note = '已越过红线，随时可能被拦'; }
              else if (rph >= BAN_LINE * 0.75) { noteCls = 'warn'; note = `接近红线，只剩约 ${left} 次`; }
              else if (rph === 0) { note = '本小时还没有请求'; }
              return `<div class="slot">
                <div class="slot-head">
                  <span class="slot-name">${escapeHtml(t(u.name))}</span>
                  <span class="slot-count"><b>${rph}</b> / ${BAN_LINE}</span>
                </div>
                <div class="track">
                  <div class="fill" style="width:${pct}%"></div>
                  ${limitPct !== null ? `<div class="redline" style="left:${limitPct}%"
                    title="本地 RPH 限额 ${limit}"></div>` : ''}
                </div>
                <div class="slot-note ${noteCls}">${note} · 并发 ${u.inflight}/${u.limit_concurrent || '∞'}
                  · RPM ${u.rpm}/${u.limit_rpm || '∞'} · RPH ${rph}/${u.limit_rph || '∞'}</div>
              </div>`;
            }).join('') || '<div class="empty">还没有任何请求经过</div>'}
          </div>
          <details class="note" style="margin:12px 0 0">
            <summary>这条线是怎么来的</summary>
            <div class="body">
              实测单个出口打 <b>80-180 次</b>后会被 Google 重定向到 <code>sorry/index</code>，
              轨道取的是这个区间的<b>下沿</b>。区间这么宽是因为它主要由连接策略和出口质量
              决定：同样并发 10，复用连接池能打到 172/177，每次新建连接只有 106/109；
              静态 IP 上到过 188。<br><br>
              <b>它不是一条硬线。</b>节奏才是关键 —— 10 次/分钟平缓地打，连打 800 次、
              跨 110 分钟一次没被拦。所以这条轨道是保守参考，不是"到了就会挂"。<br><br>
              被拦之后是硬拦（封后 20 分钟内 60 次探测 0 成功），106-121 分钟自动恢复。
              红竖线是本地 RPH 限额的位置，超了直接返回 429 而不去消耗 Google 配额。
              要放大产能就在「代理池」加代理，每个代理是独立 slot。
            </div>
          </details>
        </div>

        <div class="panel">
          <h2>连通性诊断
            <span class="controls"><button class="btn" onclick="runTest()">测试一次</button></span>
          </h2>
          <select id="testProxy" style="width:100%">
            <option value="">自动选择（按调度规则）</option>
            <option value="0">直连主机 IP</option>
          </select>
          <p class="hint" style="margin-top:10px">
            打一次真实请求看是否通。不消耗限流配额、不写入请求记录。
            返回 302/429 就是出口进了黑名单，该换 IP。
          </p>
          <div id="testResult" style="display:none; margin-top:12px;"></div>
        </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>按模型分组</h2>
          <table>
            <colgroup><col style="width:38%"><col style="width:14%"><col style="width:14%"><col style="width:16%"><col style="width:18%"></colgroup>
            <thead><tr><th>模型</th><th class="nw">请求</th><th class="nw">成功</th><th class="nw">平均</th><th class="nw">Token</th></tr></thead>
            <tbody>${(stats.by_model || []).map(m => `
              <tr><td class="truncate" title="${escapeHtml(m.model)}">${m.model}</td>
                  <td class="num nw">${fmt.num(m.requests)}</td>
                  <td class="num nw">${fmt.num(m.success)}</td>
                  <td class="num nw">${fmt.ms(m.avg_ms)}</td>
                  <td class="num nw">${fmt.num(m.prompt_tokens + m.output_tokens)}</td></tr>`).join('')
              || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h2>按出口分组</h2>
          <table>
            <colgroup><col style="width:46%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup>
            <thead><tr><th>出口</th><th class="nw">请求</th><th class="nw">成功</th><th class="nw">平均</th></tr></thead>
            <tbody>${(stats.by_proxy || []).map(p => `
              <tr><td class="truncate">${!p.proxy || p.proxy === '(direct)' ? '直连' : escapeHtml(p.proxy)}</td>
                  <td class="num nw">${fmt.num(p.requests)}</td>
                  <td class="num nw">${fmt.num(p.success)}</td>
                  <td class="num nw">${fmt.ms(p.avg_ms)}</td></tr>`).join('')
              || '<tr><td colspan="4" class="empty">暂无数据</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
          <h2>错误分类（近 ${stats.window_hours || 24}h）</h2>
          <table>
            <colgroup><col style="width:22%"><col style="width:10%"><col style="width:68%"></colgroup>
            <thead><tr><th>类型</th><th class="nw">次数</th><th>含义 / 该怎么办</th></tr></thead>
            <tbody>
              ${(stats.error_breakdown || []).map(e => `<tr>
                <td class="nw"><span class="badge ${ERR_BADGE[e.kind] || 'muted'}">${escapeHtml(e.kind)}</span></td>
                <td class="num nw">${e.count}</td>
                <td style="font-size:12.5px">${t(ERR_DESC[e.kind] || '')}
                  <div class="pre" style="margin-top:5px;color:var(--muted)">${escapeHtml(t(e.sample || ''))}</div></td>
              </tr>`).join('') || '<tr><td colspan="3" class="empty">窗口内没有失败</td></tr>'}
            </tbody>
          </table>
      </div>
    `;
  },

  requests: async () => {
    return `
      <div class="panel page-fill">
        <h2>请求记录
          <span class="controls">
            <select id="reqStatus">
              <option value="">全部</option>
              <option value="ok">成功</option>
              <option value="fail">失败</option>
            </select>
            <select id="reqModel"><option value="">全部模型</option></select>
            <select id="reqSize">
              <option value="25">每页 25</option>
              <option value="50" selected>每页 50</option>
              <option value="100">每页 100</option>
              <option value="200">每页 200</option>
            </select>
            <button onclick="loadReqs()">刷新</button>
          </span>
        </h2>
        <div class="table-scroll">
          <table id="reqTable">
            <colgroup>
              <col style="width:140px"><col style="width:150px"><col style="width:130px">
              <col style="width:96px"><col style="width:70px"><col style="width:84px">
              <col style="width:84px"><col style="width:110px"><col style="width:64px">
              <col style="width:64px"><col>
            </colgroup>
            <thead><tr>
              <th class="nw">时间</th><th class="nw">模型</th><th class="nw">实际模型</th>
              <th class="nw">出口</th><th class="nw">账号</th><th class="nw">状态</th>
              <th class="nw">首字</th><th class="nw">总用时</th>
              <th class="nw">输入</th><th class="nw">输出</th><th>接口</th>
            </tr></thead>
            <tbody><tr><td colspan="11" class="empty">加载中...</td></tr></tbody>
          </table>
        </div>
        <div class="pager" id="reqPager"></div>
      </div>
    `;
  },

  proxies: async () => {
    const data = await api('api/proxies');
    return `
      <div class="panel page-fill">
        <h2>代理池
          <span class="controls"><button class="btn" onclick="addProxy()">+ 添加代理</button></span>
        </h2>
        <details class="note">
          <summary>每个代理是一个独立 IP slot</summary>
          <div class="body">
            每个代理享有独立的并发 / RPM / RPH 配额，<b>配越多代理，总容量线性放大</b>。
            请求会自动找有空位的代理，都满则返回 HTTP 429。失败 5 次自动熔断，
            「重置」可手动恢复。<br><br>
            注意：配了至少一个代理后<b>默认不会再退回直连</b>，避免代理满了把主机 IP 也打爆；
            要可用性优先可以在「设置」页打开「无可用代理时退回直连」。熔断的代理默认歇
            120 分钟自动放回池子（实测被拦的出口 106-121 分钟自恢复），也可以在这里手动重置。
            实测单个出口打 80-180 次就会被 Google 拦，所以扩容只能靠加出口。
          </div>
        </details>
        <div class="hint" style="margin:0 0 12px;">代理可以在 Cookie 池里被某个账号独占绑定：独占后其他账号和匿名请求都不会用它，删除也会被拒绝（先去 Cookie 池解绑）。同一个 URL 不能建两条代理，否则独占会绕过。</div>
        <div class="table-scroll">
          <table>
            <colgroup>
              <col style="width:56px"><col style="width:150px"><col>
              <col style="width:88px"><col style="width:120px"><col style="width:80px">
              <col style="width:200px"><col style="width:186px">
            </colgroup>
            <thead><tr>
              <th class="nw">ID</th><th class="nw">名称</th><th>代理 URL</th><th class="nw">状态</th>
              <th class="nw">专属账号</th><th class="nw">失败</th><th class="nw">最近错误</th><th class="nw">操作</th>
            </tr></thead>
            <tbody>${(data.items || []).map(p => `
              <tr>
                <td class="num nw">${p.id}</td>
                <td class="truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                <td class="pre truncate" title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</td>
                <td class="nw">${
                  p.state === 'disabled' ? '<span class="badge muted">已禁用</span>'
                  : p.state === 'cooling' ? `<span class="badge fail" title="连续失败 ${p.fail_count} 次，熔断冷却中">冷却 ${p.cooldown_remaining_sec || 0}s</span>`
                  : '<span class="badge ok">已启用</span>'
                }</td>
                <td class="nw">${p.exclusive_account_id
                  ? `<span class="badge warn" title="这个 IP 只允许该账号使用；删除前需先解绑">${escapeHtml(p.exclusive_account_label || ('#' + p.exclusive_account_id))}</span>`
                  : '<span class="badge muted">共享</span>'}</td>
                <td class="num nw">${p.fail_count > 0 ? '<span class="badge fail">' + p.fail_count + '</span>' : p.fail_count}</td>
                <td class="pre truncate" title="${escapeHtml(t(p.last_error || ''))}">${escapeHtml(t(p.last_error) || '—')}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="toggleProxy(${p.id})">${p.enabled ? '禁用' : '启用'}</button>
                    <button class="btn muted" onclick="resetProxy(${p.id})">重置</button>
                    <button class="btn danger" onclick="delProxy(${p.id})">删除</button>
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="8" class="empty">还没有代理。点「+ 添加代理」加一个。</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  cookies: async () => {
    const data = await api('api/cookies');
    const items = data.items || [];
    const deadN = items.filter(a => a.health === 'dead').length;
    return `
      <div class="panel page-fill">
        <h2>Cookie 池
          <span class="controls">
            ${deadN > 0 ? '<span class="badge fail" style="margin-right:8px" title="' + t('这些号鉴权在失败，多半 cookie 过期了，建议用 Firefox 重新导出') + '">' + deadN + ' ' + t('疑似失效') + '</span>' : ''}
            <span class="badge ${data.enabled > 0 ? 'ok' : 'muted'}" style="margin-right:8px">${LANG === 'en' ? (data.enabled || 0) + ' active / ' + (data.total || 0) + ' total' : (data.enabled || 0) + ' 启用 / ' + (data.total || 0) + ' 共'}</span>
            <button class="btn" onclick="addCookieAcct()">+ 导入 Cookie</button>
          </span>
        </h2>
        <details class="note">
          <summary>每行一个 Google 登录态账号</summary>
          <div class="body">
            粘贴 gemini.google.com 下的<b>完整 cookie 串</b>（至少含 SID / HSID / SSID /
            APISID / SAPISID / __Secure-1PSID / __Secure-1PSIDTS）。请求时按<b>最久未用优先</b>自动轮转挑一个
            启用的账号，媒体生成有每账号 10/天 的配额，配越多号总容量越大。<br><br>
            凭证保存后<b>不再回传浏览器</b>，列表只显示脱敏摘要（cookie 数 / 关键项 /
            SAPISID 末 4 位 / 失败次数）。缺 <code>__Secure-1PSIDTS</code> 的号会标黄，
            首次保活会尝试向 Google 补发；若反复失败请用 <b>Firefox</b> 重新导出
            （Chrome 新版本的设备绑定会话续不了）。
          </div>
        </details>
        <div class="table-scroll">
          <table>
            <colgroup>
              <col style="width:48px"><col style="width:160px"><col style="width:80px">
              <col style="width:130px"><col style="width:120px">
              <col style="width:150px"><col style="width:92px"><col style="width:64px">
              <col style="width:150px"><col><col style="width:150px">
            </colgroup>
            <thead><tr>
              <th class="nw">ID</th><th class="nw">标签</th><th class="nw">状态</th>
              <th class="nw">出口</th><th class="nw">可用性</th>
              <th class="nw">关键 Cookie</th><th class="nw">SAPISID</th><th class="nw">失败</th>
              <th class="nw">最近成功</th><th>最近错误</th><th class="nw">操作</th>
            </tr></thead>
            <tbody>${items.map(a => `
              <tr class="${a.health === 'dead' ? 'row-dead' : ''}">
                <td class="num nw">${a.id}</td>
                <td class="truncate" title="${escapeHtml(a.label || '')}">${a.label ? escapeHtml(a.label) : '<span class="badge muted">未命名</span>'}${a.authuser > 0 ? ` <span class="badge muted" title="${LANG === 'en' ? 'Account index: requests go to /u/' + a.authuser + '/' : '账号序号：请求走 /u/' + a.authuser + '/'}">/u/${a.authuser}</span>` : ''}</td>
                <td class="nw">${
                  a.health === 'dead' ? '<span class="badge fail" title="鉴权在失败，多半 cookie 过期了，建议用 Firefox 重新导出">疑似失效</span>'
                  : a.health === 'disabled' ? '<span class="badge muted">禁用</span>'
                  : a.health === 'unknown' ? '<span class="badge warn" title="还没成功用过，点「检测」确认">待检测</span>'
                  : '<span class="badge ok">正常</span>'
                }</td>
                <td class="nw">${a.proxy_id
                  ? `<span class="badge ${a.proxy_exclusive ? 'warn' : 'muted'}" title="${escapeHtml(a.proxy_name || '')}">${escapeHtml(a.proxy_name || ('#' + a.proxy_id))}${a.proxy_exclusive ? ' · 独占' : ''}</span>`
                  : '<span class="badge muted" title="按调度自动选择共享出口">自动</span>'}</td>
                <td class="nw">${
                  a.status !== 'enabled' ? '<span class="badge muted">已停用</span>'
                  : a.available === false
                    ? `<span class="badge fail" title="${escapeHtml(t(a.unavailable_reason || 'IP 冷却中，Cookie 暂不可用'))}">${t('IP 冷却中')}${a.proxy_retry_after ? ' ' + a.proxy_retry_after + 's' : ''}</span>`
                    : '<span class="badge ok">可用</span>'
                }</td>
                <td class="nw" title="${LANG === 'en' ? 'Total ' + a.cookie_count + ' cookies, key items: ' + (a.key_cookies||[]).join(' / ') : '共 ' + a.cookie_count + ' 个 cookie，关键项：' + (a.key_cookies||[]).join(' / ')}">
                  <span class="badge ${a.has_1psidts ? 'ok' : 'warn'}">${(a.key_cookies||[]).length}/9 项</span>
                  ${a.has_1psidts ? '' : '<span class="badge warn" title="缺 __Secure-1PSIDTS，首次保活会尝试补发；失败请用 Firefox 重新导出">缺 TS</span>'}
                </td>
                <td class="pre nw">${a.sapisid_tail ? '…' + escapeHtml(a.sapisid_tail) : '—'}</td>
                <td class="num nw">${a.fail_count > 0 ? '<span class="badge fail">' + a.fail_count + '</span>' : 0}</td>
                <td class="nw" style="font-size:12px;color:var(--muted)">${a.last_ok_at ? fmt.ts(a.last_ok_at) : '—'}</td>
                <td class="pre truncate" title="${escapeHtml(t(a.last_error || ''))}">${escapeHtml(t(a.last_error) || '—')}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="checkCookieAcct(${a.id}, this)">检测</button>
                    <button class="btn muted" onclick="rotateCookieAcct(${a.id}, this)">保活</button>
                    <button class="btn muted" onclick="toggleCookieAcct(${a.id})">${a.status === 'enabled' ? '禁用' : '启用'}</button>
                    <button class="btn muted" onclick="editCookieAcct(${a.id}, ${JSON.stringify(a.label || '').replace(/"/g, '&quot;')}, ${JSON.stringify(a.note || '').replace(/"/g, '&quot;')}, ${a.authuser || 0}, ${a.proxy_id || 0}, ${a.proxy_exclusive ? 'true' : 'false'})">编辑</button>
                    <button class="btn danger" onclick="delCookieAcct(${a.id})">删除</button>
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="11" class="empty">Cookie 池是空的。点「+ 导入 Cookie」加一个登录态账号。</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  keys: async () => {
    const [data, cookies] = await Promise.all([api('api/keys'), api('api/cookies')]);
    const items = data.items || [];
    const accts = cookies.items || [];
    keysListCache = items;
    keysAccountsCache = accts;
    const acctLabel = id => {
      const a = accts.find(x => x.id === id);
      return a ? (a.label || ('#' + a.id)) : ('#' + id);
    };
    const allowCell = k => {
      if (k.allow_all) return '<span class="badge ok">全部账号</span>';
      if (!(k.account_ids || []).length) return '<span class="badge warn" title="' + t('没有勾选账号，这把 Key 只能走匿名能力（登录态模型不可用）') + '">仅匿名</span>';
      return '<span class="badge muted" title="' + escapeHtml((k.account_ids || []).map(acctLabel).join(', ')) + '">' +
        (k.account_ids || []).length + ' 个账号</span>';
    };
    return `
      <div class="panel page-fill">
        <h2>API Keys
          <span class="controls"><button class="btn" onclick="addKey()">+ 新增 Key</button></span>
        </h2>
        <details class="note">
          <summary>多把 Key，各自限制可用账号</summary>
          <div class="body">每个 Key 默认允许全部账号；关闭「允许全部账号」后只使用勾选的 Cookie 账号，一个都不勾时只能走匿名能力（登录态模型会从该 Key 的模型列表隐藏，请求返回 403）。<br><br><code>--api-key</code> / <code>API_KEY</code> 提供的是<b>部署 Key</b>：永远启用、允许全部账号、面板只读，不能改值或删除；它和这里新增的 Key 同时有效。列表只显示脱敏值，需要完整 Key 时点「显示」。</div>
        </details>
        <div class="table-scroll">
          <table>
            <colgroup>
              <col style="width:48px"><col style="width:170px"><col>
              <col style="width:90px"><col style="width:130px"><col style="width:150px">
              <col style="width:210px">
            </colgroup>
            <thead><tr>
              <th class="nw">ID</th><th class="nw">名称</th><th>Key</th>
              <th class="nw">状态</th><th class="nw">允许账号</th><th class="nw">创建时间</th>
              <th class="nw">操作</th>
            </tr></thead>
            <tbody>${items.map(k => `
              <tr>
                <td class="num nw">${k.id === 0 ? '—' : k.id}</td>
                <td class="truncate" title="${escapeHtml(k.name || '')}">${escapeHtml(k.name || '')}${k.locked ? ' <span class="badge warn">部署</span>' : ''}</td>
                <td class="pre truncate" title="${escapeHtml(k.masked_key || '')}">${escapeHtml(k.masked_key || '—')}</td>
                <td class="nw">${k.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge muted">停用</span>'}</td>
                <td class="nw">${allowCell(k)}</td>
                <td class="nw" style="font-size:12px;color:var(--muted)">${k.created_at ? fmt.ts(k.created_at) : '—'}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="revealKey(${k.id})">显示</button>
                    ${k.locked ? '' : `
                      <button class="btn muted" onclick="editKey(${k.id})">编辑</button>
                      <button class="btn muted" onclick="rotateKeyById(${k.id})">轮换</button>
                      <button class="btn muted" onclick="toggleKey(${k.id})">${k.enabled ? '停用' : '启用'}</button>
                      <button class="btn danger" onclick="delKey(${k.id})">删除</button>`}
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="7" class="empty">还没有额外的 API Key。部署 Key 不存在时需要新增一把。</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  settings: async () => {
    return `
      <div class="grid-main">
        <div class="panel">
          <h2>运行时配置</h2>
          <p class="lede">
            改完点保存<b>立刻生效</b>，不用重启。存在数据库里，优先级高于
            <code>config.json</code> 和命令行参数。
          </p>
          <div id="rtCfgForm"></div>
          <div class="cfg-actions">
            <button class="btn" onclick="saveRtCfg()">保存并生效</button>
            <button class="btn muted" onclick="loadRtCfg()">放弃修改</button>
            <span id="rtCfgMsg" style="font-size:12.5px;"></span>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>API Keys</h2>
            <p class="lede">
              支持多把 Key，每把可以限制可用账号。完整 Key 只在创建/轮换时显示一次，
              之后在「API Keys」页按需显示。
            </p>
            <div class="row" style="margin-bottom:10px;">
              <button class="btn" onclick="switchPage('keys')">管理 API Keys</button>
            </div>
            <details class="note">
              <summary>调用示例</summary>
              <div class="body">
                <pre class="pre" style="margin:0; font-size:11.5px;">curl http://your-host/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash",
       "messages":[{"role":"user","content":"你好"}]}'</pre>
              </div>
            </details>
          </div>

          <div class="card">
            <h2>部署配置</h2>
            <p class="lede">
              改这些本来就要重启进程，所以放在 <code>docker-compose.yml</code> 里管，
              不做成网页表单——凭证也不该经过浏览器。
            </p>
            <table id="deployTable" class="kv">
              <tbody></tbody>
            </table>
            <p class="lede" style="margin:14px 0 0;">
              gemini-web2api-go · 单二进制 · SQLite · Chrome 146 指纹 · tiktoken cl100k_base 计费
            </p>
          </div>
        </div>
      </div>
    `;
  },

  about: async () => {
    await ensureCurrentVersion();
    return `
      <div class="grid-main">
        <div class="panel">
          <h2>版本与更新 <button class="btn muted" onclick="checkUpdate(true)">检查更新</button></h2>
          <table class="kv">
            <tbody>
              <tr><td>当前版本</td><td><b>${CURRENT_VERSION ? 'v' + escapeHtml(CURRENT_VERSION) : '—'}</b></td></tr>
              <tr><td>最新版本</td><td id="updLatest">—</td></tr>
              <tr><td>上次检查</td><td id="updChecked">—</td></tr>
            </tbody>
          </table>
          <label class="row" style="margin-top:12px; font-size:12.5px; cursor:pointer;">
            <input type="checkbox" class="switch" id="updAuto" ${updAutoEnabled() ? 'checked' : ''}
                   onchange="setUpdAuto(this.checked)" />
            <span>打开面板时自动检查更新</span>
          </label>
          <p class="lede" style="margin:8px 0 0;">由浏览器直接查询 GitHub，服务端不发任何请求；结果缓存 6 小时。</p>
          <div id="updBox"></div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>项目</h2>
            <p class="lede">把 gemini.google.com 网页端反代成 OpenAI / Gemini 兼容 API。开源，MIT 许可。</p>
            <table class="kv" style="margin-bottom:14px;">
              <tbody>
                <tr><td>作者</td><td><a class="link" href="https://github.com/zexadev" target="_blank" rel="noopener">Zexa</a> <span class="muted">@zexadev</span></td></tr>
              </tbody>
            </table>
            <div class="about-links">
              <!-- GitHub 没有能直接点上 Star 的链接（/stargazers 是谁点过的列表），只能送到仓库首页 -->
              <a class="btn" href="${REPO_URL}" target="_blank" rel="noopener">
                ${renderHugeIcon('star', 16)}<span>去 GitHub 点 Star</span></a>
            </div>
            <p class="lede" style="margin:0;">觉得好用就去 GitHub 仓库首页，点右上角的 Star。GitHub 的 topic 页按 Star 排序，这是别人找到这个项目的主要入口。</p>
          </div>

          <div class="card">
            <h2>链接</h2>
            <table class="kv">
              <tbody>
                <tr><td>仓库</td><td><a class="link" href="${REPO_URL}" target="_blank" rel="noopener">github.com/${REPO}</a></td></tr>
                <tr><td>更新日志</td><td><a class="link" href="${REPO_URL}/blob/main/CHANGELOG.md" target="_blank" rel="noopener">CHANGELOG.md</a></td></tr>
                <tr><td>发布页</td><td><a class="link" href="${REPO_URL}/releases" target="_blank" rel="noopener">Releases</a></td></tr>
                <tr><td>提交问题</td><td><a class="link" href="${REPO_URL}/issues" target="_blank" rel="noopener">Issues</a></td></tr>
                <tr><td>许可证</td><td><a class="link" href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener">MIT</a></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },
};

// ─── Charts + handlers ──────────────────────────────────────────────────────

async function loadChart(range = '24h') {
  destroyChart('req');
  const data = await api('api/timeseries?range=' + range);
  const labels = (data.series || []).map(s => fmt.ts(s.bucket));
  const reqs = (data.series || []).map(s => s.requests);
  const p50 = (data.series || []).map(s => s.p50_ms);
  const ctx = document.getElementById('chartReq');
  if (!ctx) return;
  const g = ctx.getContext('2d');
  const areaBlue = g.createLinearGradient(0, 0, 0, 260);
  areaBlue.addColorStop(0, 'rgba(66,133,244,.22)');
  areaBlue.addColorStop(1, 'rgba(66,133,244,0)');

  const isDark = THEME === 'dark';
  const tickColor = isDark ? '#C4C7C5' : '#5F6368';
  const gridColor = isDark ? '#2C2E30' : '#EDF1F7';
  const borderColor = isDark ? '#333537' : '#E8ECF1';
  const tooltipBg = isDark ? '#282A2C' : '#1F1F1F';

  const reqLabel = LANG === 'es' ? 'Peticiones' : (LANG === 'en' ? 'Requests' : '请求数');
  const p50Label = LANG === 'es' ? 'Latencia P50' : (LANG === 'en' ? 'P50 Latency' : 'P50 延迟');

  charts.req = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: reqLabel, data: reqs, yAxisID: 'y',
          borderColor: '#0B57D0', backgroundColor: areaBlue, fill: true,
          tension: .35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          pointBackgroundColor: '#0B57D0' },
        { label: p50Label, data: p50, yAxisID: 'y1',
          borderColor: '#9B72CB', backgroundColor: 'transparent',
          tension: .35, borderWidth: 2, borderDash: [5, 4],
          pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: '#9B72CB' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4 } },
      plugins: {
        legend: {
          align: 'end',
          labels: { color: tickColor, usePointStyle: true, pointStyle: 'circle',
                    boxWidth: 8, boxHeight: 8, padding: 16,
                    font: { size: 12, family: 'inherit' } },
        },
        tooltip: {
          backgroundColor: tooltipBg, padding: 10, cornerRadius: 8,
          titleFont: { size: 12, weight: '500' }, bodyFont: { size: 12 },
          displayColors: true, usePointStyle: true, boxPadding: 4,
        },
      },
      scales: {
        x: { ticks: { color: tickColor, maxRotation: 0, autoSkipPadding: 24,
                      font: { size: 11 } },
             grid: { display: false }, border: { color: borderColor } },
        y: { type: 'linear', position: 'left', beginAtZero: true,
             ticks: { color: tickColor, font: { size: 11 }, precision: 0, maxTicksLimit: 6 },
             grid: { color: gridColor }, border: { display: false } },
        y1: { type: 'linear', position: 'right', beginAtZero: true,
              ticks: { color: tickColor, font: { size: 11 }, maxTicksLimit: 6,
                       callback: (v) => v + 'ms' },
              grid: { drawOnChartArea: false }, border: { display: false } },
      },
    },
  });
}

let reqOffset = 0;
// 每页条数由「每页 N」下拉决定；页面还没渲染时退回 50
function reqPageSize() {
  const el = document.getElementById('reqSize');
  return el ? parseInt(el.value, 10) : 50;
}
async function loadReqs() {
  const status = document.getElementById('reqStatus')?.value || '';
  const model = document.getElementById('reqModel')?.value || '';
  const url = `api/requests?limit=${reqPageSize()}&offset=${reqOffset}` +
              (status ? '&status=' + status : '') +
              (model ? '&model=' + encodeURIComponent(model) : '');
  const data = await api(url);
  const tbody = document.querySelector('#reqTable tbody');
  if (!tbody) return;
  tbody.innerHTML = (data.items || []).map(r => `
    <tr>
      <td class="nw muted">${fmt.ts(r.ts)}</td>
      <td class="truncate" title="${escapeHtml(r.model)}">${escapeHtml(r.model)}</td>
      <td class="nw">${upstreamCell(r)}</td>
      <td class="nw truncate">${r.proxy_name ? escapeHtml(t(r.proxy_name)) : '<span class="badge muted">' + t('直连') + '</span>'}</td>
      <td class="nw truncate" title="${escapeHtml(r.account_label || '')}">${
        r.account_id ? escapeHtml(r.account_label || ('#' + r.account_id))
                     : '<span class="badge muted">' + t('匿名') + '</span>'}</td>
      <td class="nw">${r.status === 200 ? '<span class="badge ok">200</span>' : '<span class="badge fail">' + r.status + '</span>'}</td>
      <td class="num nw">${fmt.ms(r.ttfb_ms)}</td>
      <td class="num nw">${fmt.ms(r.total_ms)}</td>
      <td class="num nw">${fmt.num(r.prompt_tokens)}</td>
      <td class="num nw">${fmt.num(r.output_tokens)}</td>
      <td><span class="pre">${escapeHtml(r.endpoint)}${r.stream ? ' <span class="badge muted">stream</span>' : ''}</span>
        ${r.error ? '<div class="pre clamp2" style="color:var(--fail);margin-top:4px" title="'
          + escapeHtml(t(r.error)) + '"><b>' + t('错误：') + '</b>' + escapeHtml(t(r.error)) + '</div>' : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="11" class="empty">还没有请求记录</td></tr>';
  const size = reqPageSize();
  const total = data.total || 0;
  const page = Math.floor(reqOffset / size) + 1;
  const pages = Math.max(Math.ceil(total / size), 1);
  const from = total ? reqOffset + 1 : 0;
  const to = Math.min(reqOffset + size, total);
  document.getElementById('reqPager').innerHTML = `
    <span class="muted">${from}-${to} / ${LANG === 'en' ? 'total ' + total + ' items' : '共 ' + total + ' 条'}</span>
    <span class="pager-btns">
      <button class="btn muted" ${reqOffset === 0 ? 'disabled' : ''}
        onclick="reqOffset=0;loadReqs()">${t('最前')}</button>
      <button class="btn muted" ${reqOffset === 0 ? 'disabled' : ''}
        onclick="reqOffset=Math.max(0,reqOffset-${size});loadReqs()">${t('上一页')}</button>
      <span class="muted" style="min-width:80px;text-align:center">${LANG === 'en' ? 'Page ' + page + ' / ' + pages : '第 ' + page + ' / ' + pages + ' 页'}</span>
      <button class="btn muted" ${to >= total ? 'disabled' : ''}
        onclick="reqOffset+=${size};loadReqs()">${t('下一页')}</button>
      <button class="btn muted" ${to >= total ? 'disabled' : ''}
        onclick="reqOffset=${(pages-1)*size};loadReqs()">${t('最后')}</button>
    </span>
  `;
  if (LANG === 'en') {
    translateTree(tbody, true);
    const pager = document.getElementById('reqPager');
    if (pager) translateTree(pager, true);
  }
  // populate model dropdown from current page (best-effort)
  const sel = document.getElementById('reqModel');
  if (sel && sel.options.length === 1) {
    const seen = new Set();
    (data.items || []).forEach(r => seen.add(r.model));
    [...seen].forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.text = m; sel.appendChild(opt);
    });
  }
}

// ── 运行时配置 ───────────────────────────────────────────────────────────────
// 字段定义跟后端 RuntimeConfig 一一对应；范围与后端 validateRuntimeConfig 一致，
// 前端只做提示，真正的校验在后端（浏览器里的限制随便绕）。
// 必须一一对应：saveRtCfg 只按这里的字段拼 PUT body，后端整体反序列化，漏在这里
// 列出的 RuntimeConfig 字段每次保存都会被解成零值冲掉（multi_turn 栽过，见 #27）。
// 按语义分组，组内自适应多列。分组的依据是"改这一项时在想什么"：
// 调产能 / 调容错 / 调怎么发请求 / 调留多少数据，而不是按字段类型堆在一起。
const RT_GROUPS = [
  {
    title: '流量控制 · 每个 IP slot 独立计数',
    fields: [
      { k: 'per_ip_concurrent', label: '并发', type: 'int', min: 0, max: 1000,
        hint: '同一时刻最多几个请求在飞，0=不限' },
      { k: 'per_ip_rpm', label: 'RPM', type: 'int', min: 0, max: 10000,
        hint: '滚动 60 秒窗口上限，0=不限' },
      { k: 'per_ip_rph', label: 'RPH', type: 'int', min: 0, max: 100000,
        hint: '滚动 1 小时上限，0=不限。实测单出口 80-180 次被拦，默认取下沿 80。按低速率跑可以调高很多——10 次/分钟连打 800 次没被拦过' },
    ],
  },
  {
    title: '重试与超时',
    fields: [
      { k: 'retry_attempts', label: '重试次数', type: 'int', min: 1, max: 10,
        hint: '含首次；流式已吐字后不再重试' },
      { k: 'retry_delay_sec', label: '重试间隔（秒）', type: 'int', min: 0, max: 60 },
      { k: 'request_timeout_sec', label: '上游超时（秒）', type: 'int', min: 5, max: 600 },
      { k: 'retry_on_timeout', label: '超时后重试', type: 'bool',
        hint: '开：上游等满「上游超时」还没回完时，按重试次数再发（默认）。关：超时直接报错——等满一次都没回完，重发多半还是超时，一个请求最坏要等「超时 × 重试次数」，超长输入或慢模型（如 Argon）下能拖十几分钟。其他失败（空响应、出错话术等）照常重试' },
      { k: 'stream_keepalive_sec', label: '流式保活（秒）', type: 'int', min: 0, max: 300,
        hint: '流式请求连续这么多秒没往客户端写东西，就发一次保活，防止前面的 nginx / Cloudflare / newapi 等中间层因连接空闲回 504。建议 15。代价：保活要先开流（HTTP 200），之后再失败只能在流里报错、拿不到 502/429 状态码，依赖状态码换渠道的客户端会受影响；秒级就失败的请求不受影响。非流式请求无效。0=关（默认）' },
      { k: 'stream_idle_timeout_sec', label: '空闲超时（秒）', type: 'int', min: 0, max: 600,
        hint: '上游开流后连续这么多秒一个 chunk 都不来，就掐断当瞬时错误重试。「上游超时」是整条请求的总时限，管不到"首字节秒级就到、之后两三分钟一个字不来"这种挂法——这个专补那个缺口，让卡住的请求几十秒就换一次而不是干等到总超时。掐断会无条件重试（不受「超时后重试」开关影响）。建议 60。设得太小会误伤慢模型（如 Argon 首字节本身就慢）。0=关（默认）' },
    ],
  },
  {
    title: '请求行为',
    fields: [
      { k: 'default_model', label: '默认模型', type: 'select',
        hint: '客户端没传 model 时用哪个' },
      { k: 'max_prompt_bytes', label: 'Prompt 字节上限', type: 'int', min: 0, max: 10000000,
        hint: '超了直接返回 400 context_length_exceeded。上游的墙实测在约 13 万 UTF-8 字节，按字节算跟语言无关（同字节数下中英文表现一致，而 token 数差 1.9 倍）。不拦的话上游从尾部静默截断，被吃掉的正是刚问的那句。0=不限' },
      { k: 'impersonate', label: 'TLS 指纹', type: 'text',
        hint: 'chrome_146 / chrome_144 / firefox_147 / safari_16_0 …' },
      { k: 'firefox_fingerprint', label: 'Firefox 指纹（实验）', type: 'bool',
        hint: '开：请求伪装成 Firefox/Zen——直连时 TLS 握手走 Firefox 指纹、UA 换成 Firefox、去掉 Chrome 专有的 Sec-CH-UA；关：用上面「TLS 指纹」的设置（默认 Chrome）。cookie 从 Firefox 导出时建议配套打开。注意：走代理时 TLS 这层是 Go 标准库的、改不成 Firefox（隧道限制），只有 header 变成 Firefox，仅直连才是完整 Firefox 指纹。实验功能，默认关' },
      { k: 'gemini_bl', label: 'Gemini bl 版本', type: 'text',
        hint: '上游前端版本号。请求大面积失败时先看这里是不是过期了' },
      { k: 'gemini_bl_auto', label: '自动跟随 bl 版本', type: 'bool',
        hint: '每 6 小时从 /app 页面抓一次最新版本号，抓到就用抓到的。抓不到或格式不对就继续用上面钉的值' },
      { k: 'web_channel', label: '新协议（processSession）', type: 'bool',
        hint: '对话改走网页新版用的 processSession（WebChannel）接口，而不是老的 StreamGenerate。后端是同一个，只换传输方式；老接口目前仍正常，老接口出问题时再打开。多轮续接仍走老接口；扩展思考在新协议上暂时不生效（回报普通档）。默认关' },
    ],
  },
  {
    title: '会话与账号',
    fields: [
      { k: 'auto_delete_conversation', label: '自动删网页会话', type: 'bool',
        hint: '出完结果自动删掉 gemini.google.com 上留下的这条会话，免得登录号里堆一堆。只登录态生效，异步 best-effort，删失败不影响响应' },
      { k: 'temporary_chat', label: '临时对话', type: 'bool',
        hint: '走网页端原生「临时对话」（inner[45]=1）：会话压根不进账号的会话列表、不用于训练，比「自动删网页会话」更干净，还省掉那次删除请求。只登录态有意义；开了「服务端多轮续接」时不生效（临时对话不留列表，多轮要靠服务端留会话）' },
      { k: 'multi_turn', label: '服务端多轮续接', type: 'bool',
        hint: '走 Gemini 原生服务端多轮：按历史前缀认出这是上一轮的续接，命中就只发最新一句、历史留在服务端，同一串对话复用同一个 gemini 会话（不再每发一条就新开一个）。匿名/登录都行，带图或带工具时不生效。首轮/重启/改历史会退回整段重发。默认关' },
      { k: 'image_upscale', label: '生图下载原图/放大', type: 'bool',
        hint: '出图后照网页「下载」按钮那样取图：Ultra 号的图会放大到宽高各 2 倍（1376×768 → 2752×1536），普通号拿到未重新压缩的原始文件（尺寸不变、画质更好）。每张图多一次请求，返回体积大几倍。只登录态生效，取不到就退回原来那张，不会重新生成。默认关' },
      { k: 'anon_first', label: '匿名优先', type: 'bool',
        hint: '这次请求不需要登录态能力时（纯文本、非思考、无工具、不带图）走匿名、不占用 cookie 账号，省账号额度；用到 4 Hydrogen / 4 Carbon / 扩展思考 / 生图 / 传文件这些才挑号。关掉则只要池里有号就一律用号（默认关）' },
    ],
  },
  {
    title: '代理与 cookie 的降级行为',
    fields: [
      { k: 'proxy_cooldown_min', label: '熔断冷却（分钟）', type: 'int', min: -1, max: 10080,
        hint: '代理连续失败 5 次后歇多久再放回池子。实测被拦的出口 106-121 分钟自恢复，默认 120；0=不恢复，要去代理池页面手动重置；-1=不熔断，失败次数只记录不拦请求（出口由 Clash 之类自己换节点时用这个）' },
      { k: 'fallback_direct', label: '无可用代理时退回直连', type: 'bool',
        hint: '关：直接返回 429，本机 IP 不会暴露给上游（默认）。开：可用性优先，但上游会看到本机真实出口' },
      { k: 'fallback_anon', label: 'cookie 失效时降级匿名', type: 'bool',
        hint: '关：直接报错，能立刻发现该换号了（默认）。开：继续跑，但要登录的模型会被静默降级成 3.5 Flash-Lite、思考链消失，客户端看不出来' },
      { k: 'strict_model', label: '严格模型校验', type: 'bool',
        hint: '开：服务端自报的模型跟请求的不一致时（通常是这个号这一档额度用完、被静默降级），不把降级后的回答当成功返回，而是换下一个号重试；全池都被降级就回 429 insufficient_quota（code: model_downgraded）。流式在吐出第一个字之前就判断。关：照常返回降级后的回答（默认）' },
      { k: 'strict_model_cooldown_min', label: '降级冷却（分钟）', type: 'int', min: 0, max: 10080,
        hint: '严格模型校验开着时，被降级的号在这个模型上歇多久再用。网页端用量按 5 小时窗口算，默认 300；0=不记，每次请求都重新试' },
    ],
  },
  {
    title: '数据与日志',
    fields: [
      { k: 'retention_days', label: '明细保留（天）', type: 'int', min: 1, max: 3650,
        hint: '过期只删明细，聚合数据永久保留' },
      { k: 'log_requests', label: '打印请求日志', type: 'bool' },
    ],
  },
];

let rtCfgCache = null, rtModels = [];

async function loadRtCfg() {
  const data = await api('api/config');
  if (!data) return;
  rtCfgCache = data.config; rtModels = data.models || [];
  // 每组先放输入框类字段（自适应多列网格），开关单独成行排在下面：开关的说明普遍
  // 很长，塞进网格的窄列里标签会被挤成一字一行。
  const inputItem = f => {
    const v = rtCfgCache[f.k];
    let input;
    if (f.type === 'select') {
      input = `<select id="rt_${f.k}">` + rtModels.map(m =>
        `<option value="${escapeHtml(m)}" ${m === v ? 'selected' : ''}>${escapeHtml(m)}</option>`
      ).join('') + '</select>';
    } else if (f.type === 'int') {
      input = `<input type="number" id="rt_${f.k}" value="${v}" min="${f.min}" max="${f.max}">`;
    } else {
      input = `<input type="text" id="rt_${f.k}" value="${escapeHtml(String(v ?? ''))}">`;
    }
    return `<div class="cfg-item${f.wide ? ' wide' : ''}">
      <label for="rt_${f.k}">${f.label}</label>
      ${input}
      ${f.hint ? `<div class="rthint">${escapeHtml(f.hint)}</div>` : ''}
    </div>`;
  };
  const toggleItem = f => `<div class="cfg-toggle">
      <input type="checkbox" class="switch" id="rt_${f.k}" ${rtCfgCache[f.k] ? 'checked' : ''}>
      <label for="rt_${f.k}">${f.label}</label>
      ${f.hint ? `<div class="rthint">${escapeHtml(f.hint)}</div>` : ''}
    </div>`;
  document.getElementById('rtCfgForm').innerHTML = RT_GROUPS.map(g => {
    const inputs = g.fields.filter(f => f.type !== 'bool');
    const toggles = g.fields.filter(f => f.type === 'bool');
    return `
    <div class="cfg-group">
      <h3>${escapeHtml(g.title)}</h3>
      ${inputs.length ? `<div class="cfg-grid">${inputs.map(inputItem).join('')}</div>` : ''}
      ${toggles.length ? `<div class="cfg-toggles${inputs.length ? ' after-grid' : ''}">${toggles.map(toggleItem).join('')}</div>` : ''}
    </div>`;
  }).join('');

  // 三列（项/值/怎么改）挤在窄栏里读不动，第三列换成 title 悬浮
  const d = data.deploy || {};
  document.querySelector('#deployTable tbody').innerHTML = [
    ['监听', `${escapeHtml(d.host || '')}:${d.port}`, 'compose 的 ports + --port'],
    ['数据库', escapeHtml(d.db_path || ''), 'compose 的 volumes + --db'],
    ['Cookie 播种文件', d.cookie_file ? escapeHtml(d.cookie_file) : '<span class="badge muted">未配置</span>',
     '启动时把文件内容导入 Cookie 池；之后从「Cookie 池」页面管理'],
    ['面板鉴权', d.admin_auth ? '<span class="badge ok">已开启</span>'
                             : '<span class="badge fail">未设 token</span>', 'compose 的 ADMIN_TOKEN'],
    ['API Key', d.api_key_locked ? '<span class="badge">部署锁定</span>'
                                 : '<span class="badge ok">面板可轮换</span>', 'compose 的 API_KEY'],
  ].map(r => `<tr><td title="${escapeHtml(r[2])}">${r[0]}</td>
      <td class="pre" style="word-break:break-all;">${r[1]}</td></tr>`).join('');
}

async function saveRtCfg() {
  const msg = document.getElementById('rtCfgMsg');
  const body = {};
  for (const f of RT_GROUPS.flatMap(g => g.fields)) {
    const el = document.getElementById('rt_' + f.k);
    if (!el) continue;
    body[f.k] = f.type === 'bool' ? el.checked
      : f.type === 'int' ? parseInt(el.value, 10)
      : el.value.trim();
  }
  msg.textContent = t('保存中…'); msg.style.color = 'var(--muted)';
  const res = await fetch('api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    msg.textContent = t('保存失败：') + t(data.error || res.status);
    msg.style.color = 'var(--fail)';
    return;
  }
  rtCfgCache = data.config;
  msg.textContent = t('已保存并生效');
  msg.style.color = 'var(--ok)';
  setTimeout(() => { msg.textContent = ''; }, 3000);
}

const ERR_BADGE = {
  upstream_rejected: 'muted', rate_limited_local: 'muted', bad_request: 'muted',
  blocked_sorry: 'fail', upstream_429: 'fail', upstream_http_error: 'fail', network: 'fail',
};
const ERR_DESC = {
  upstream_rejected: '上游返回 200 但没有内容帧。实测是瞬时拒绝，隔几分钟自愈，跟频率/并发/累积次数都无关 —— 重试即可，不用调限流。',
  rate_limited_local: '本地限流挡下的（slot 满）。要更高产能就在「代理池」加代理。',
  blocked_sorry: '被 Google 重定向到 sorry/index，该出口 IP 进了黑名单。换代理，6-24 小时才恢复。',
  upstream_429: '上游直接 429。同样是出口 IP 嫌疑，换代理。',
  upstream_http_error: '上游返回非 200 的其它状态码，可能是协议变更或临时故障。',
  network: '连不上代理 / DNS / TLS 握手失败。检查代理可用性 —— 实测代理服务商出口质量参差，劣质出口会连续失败。',
  bad_request: '客户端请求本身有问题（模型名不存在、传了不支持的字段）。',
};

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 服务端会静默降级（例如请求 4 Carbon 实际给的是 3.5 Flash-Lite），只看请求名发现不了。
// upstream_model 取自响应帧里服务端自报的显示名；跟请求的对不上时标黄。
//
// 媒体模型例外：生图/音乐的后端名（Nano Banana / Lyria）跟请求名本来就不同，是预期
// 映射不是降级——真失败会直接报错不落 200 记录，所以这里把它们当"一致"，不误标黄。
const upstreamExpected = { image: 'nanobanana', music: 'lyria' };
function upstreamCell(r) {
  const up = r.upstream_model || '';
  if (!up) return '<span class="badge muted">—</span>';
  const norm = t => (t || '').toLowerCase().replace(/[\s._-]/g, '').replace(/^gemini/, '');
  const nm = norm(r.model), nu = norm(up);
  const same = nu.startsWith(nm.slice(0, 6)) ||
               (upstreamExpected[nm] && nu.startsWith(upstreamExpected[nm]));
  return same
    ? escapeHtml(up)
    : '<span class="badge warn" title="' + escapeHtml(t('服务端实际使用的模型与请求的不一致')) + '">'
      + escapeHtml(up) + '</span>';
}

async function addProxy() {
  const data = await modalForm({
    title: '添加代理',
    desc: '一个代理 = 一个独立 IP slot，享有独立的并发/RPM/RPH 配额。',
    fields: [
      { name: 'name', label: '名称', placeholder: 'vps-uk-1', required: true,
        hint: '随便起，admin 面板里用来区分' },
      { name: 'url', label: '代理 URL', placeholder: 'http://user:pass@1.2.3.4:8080', required: true,
        hint: '支持 http:// / https:// / socks5:// 协议' },
    ],
  });
  if (!data) return;
  const r = await fetch('api/proxies', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: data.name, url: data.url, weight: 1 }),
  });
  const j = await r.json();
  if (j.error) return flash(t('添加失败：') + t(j.error));
  flash(t('代理已添加'));
  await refreshPage();
}
async function delProxy(id) {
  const ok = await modalConfirm({
    title: '删除代理',
    desc: `确定删除代理 #${id}？此操作不可撤销。被 Cookie 独占绑定的代理需要先解绑。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/proxies/' + id, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('删除失败：') + t(j.error || ('HTTP ' + r.status)));
  flash('已删除');
  await refreshPage();
}
async function toggleProxy(id) {
  await api('api/proxies/' + id + '/toggle', { method: 'POST' });
  await refreshPage();
}
async function resetProxy(id) {
  await api('api/proxies/' + id + '/reset', { method: 'POST' });
  flash('已重置失败计数');
  await refreshPage();
}
// Cookie 池 ────────────────────────────────────────────────────────────────

// 逐项模式列出的 cookie。顺序按"从 DevTools 里找的难易"排，不是字母序。
// req 只标 SAPISID：后端也只强制这一项（要用它算 SAPISIDHASH 授权头），
// 其余缺了不一定不能用，标成必填会把能用的号挡在外面。
const COOKIE_KEYS = [
  { k: '__Secure-1PSID', hint: '主会话' },
  { k: 'SAPISID', req: true, hint: '算授权头用，缺了会被当匿名' },
  { k: '__Secure-1PSIDTS', hint: '约 30 分钟过期，保活会自动换发' },
  { k: 'SID' }, { k: 'HSID' }, { k: 'SSID' }, { k: 'APISID' },
];

// 把 "k=v; k=v" 拆成对象。值里可能含 '='（base64 补位），所以只在第一个等号处切。
function parseCookieStr(s) {
  const out = {};
  (s || '').split(';').forEach(p => {
    const t = p.trim();
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  });
  return out;
}

function joinCookieObj(obj) {
  return Object.entries(obj).filter(([, v]) => (v || '').trim())
    .map(([k, v]) => `${k}=${String(v).trim()}`).join('; ');
}

async function addCookieAcct() {
  // 两个模式共用这一份状态，切 tab 时互相带过去。extras 存的是不在
  // COOKIE_KEYS 里的项——整串粘贴进来的 cookie 往往还带一堆别的，
  // 切到逐项再切回去不能把它们弄丢。
  let extras = {};

  const data = await buildModal({
    title: '导入 Cookie',
    wide: true,
    desc: '浏览器 F12 → Application → Cookies → 选 <code>https://gemini.google.com</code>。逐项抄或整串粘贴都行，两种填法可随时切换，已填的内容会带过去。',
    bodyHTML: `
      <div class="field">
        <label>标签</label>
        <input data-name="label" type="text" placeholder="例如账号邮箱，可留空" />
        <div class="hint">仅用于面板里区分账号，不参与请求。</div>
      </div>

      <div class="field">
        <label>账号序号</label>
        <input data-name="authuser" type="text" inputmode="numeric" value="0" />
        <div class="hint">浏览器里同时登了多个 Google 号才需要改：打开那个号的 Gemini，地址栏是 /u/1/ 就填 1，没有 /u/ 就是 0。同一串 cookie 想当几个号用，就导入几次、各填各的序号。</div>
      </div>

      <div class="segbar" data-role="seg">
        <button type="button" data-mode="raw" class="on">整串粘贴（推荐）</button>
        <button type="button" data-mode="fields">逐项填写</button>
      </div>

      <div data-pane="fields" style="display:none;">
        <div class="ck-grid">
          ${COOKIE_KEYS.map(c => `
            <div class="field${c.k.length > 12 ? ' wide' : ''}">
              <label>${escapeHtml(c.k)}${c.req ? ' <span class="req">*</span>' : ''}</label>
              <input data-ck="${escapeHtml(c.k)}" type="text" autocomplete="off" spellcheck="false"
                     placeholder="${escapeHtml(c.hint || '')}" />
            </div>`).join('')}
        </div>
        <div class="ck-extra" data-role="extras"></div>
        <div class="ck-extra">前三项是同类项目实践里的最小可用集合，下面四项补齐更稳。
        抓包实测浏览器每次实际会发 <b>20 多个</b> cookie，而我们把整串原样转发
        （代码里只解析 SAPISID 用来算授权头），所以
        <b>整串粘贴比逐项填更接近真实浏览器</b>；逐项模式适合手头只有零散几项时用。</div>
      </div>

      <div data-pane="raw">
        <div class="field">
          <textarea data-name="cookie" rows="6" spellcheck="false"
            placeholder="SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=...; __Secure-1PSIDTS=..."></textarea>
          <div class="hint">整行粘贴，分号分隔。至少要含 SAPISID 和 __Secure-1PSID。
          建议用 Firefox 导出（Chrome 新版本的会话绑在设备上，续不了）。DevTools 里全选复制即可，
          多余的项会一并保留 —— 发得越全越像真实浏览器。</div>
        </div>
      </div>

      <div class="field" style="margin-top:14px;">
        <label>备注</label>
        <input data-name="note" type="text" placeholder="可留空" />
      </div>`,
    submitText: '导入',
    onReady: (overlay) => {
      const $ = (s) => overlay.querySelector(s);
      const inputs = () => [...overlay.querySelectorAll('[data-ck]')];
      const ta = $('[data-name=cookie]');

      const fieldsToRaw = () => {
        const obj = {};
        inputs().forEach(el => { if (el.value.trim()) obj[el.dataset.ck] = el.value.trim(); });
        ta.value = joinCookieObj({ ...obj, ...extras });
      };
      const rawToFields = () => {
        const obj = parseCookieStr(ta.value);
        const known = new Set(COOKIE_KEYS.map(c => c.k));
        extras = {};
        Object.entries(obj).forEach(([k, v]) => { if (!known.has(k)) extras[k] = v; });
        inputs().forEach(el => { el.value = obj[el.dataset.ck] || ''; });
        const n = Object.keys(extras).length;
        $('[data-role=extras]').textContent = n
          ? (LANG === 'en'
              ? `${n} additional item${n > 1 ? 's' : ''} not listed above (${Object.keys(extras).slice(0, 4).join(', ')}${n > 4 ? ' …' : ''}) will be kept.`
              : `另有 ${n} 项未在上面列出（${Object.keys(extras).slice(0, 4).join(', ')}${n > 4 ? ' …' : ''}），会一并保留。`)
          : '';
      };

      overlay.querySelectorAll('[data-role=seg] button').forEach(btn => {
        btn.onclick = () => {
          const mode = btn.dataset.mode;
          if (mode === 'raw') fieldsToRaw(); else rawToFields();
          overlay.querySelectorAll('[data-role=seg] button')
            .forEach(b => b.classList.toggle('on', b === btn));
          $('[data-pane=fields]').style.display = mode === 'fields' ? '' : 'none';
          $('[data-pane=raw]').style.display = mode === 'raw' ? '' : 'none';
          if (LANG === 'en') translateTree(overlay, true);
        };
      });
      // 在逐项模式里直接粘贴一整串时自动拆开，省得用户先去切 tab
      inputs().forEach(el => el.addEventListener('paste', (ev) => {
        const txt = (ev.clipboardData || window.clipboardData).getData('text') || '';
        if (!txt.includes(';') || !txt.includes('=')) return;
        ev.preventDefault();
        ta.value = txt.trim();
        rawToFields();
      }));
    },
    onSubmit: (overlay) => {
      const label = (overlay.querySelector('[data-name=label]').value || '').trim();
      const note = (overlay.querySelector('[data-name=note]').value || '').trim();
      const authuser = parseAuthUser(overlay.querySelector('[data-name=authuser]').value);
      if (authuser === null) return { error: '账号序号要填 0 到 9 的整数' };
      const isRaw =overlay.querySelector('[data-role=seg] button.on').dataset.mode === 'raw';
      let cookie;
      if (isRaw) {
        cookie = (overlay.querySelector('[data-name=cookie]').value || '').trim();
      } else {
        const obj = {};
        overlay.querySelectorAll('[data-ck]').forEach(el => {
          if (el.value.trim()) obj[el.dataset.ck] = el.value.trim();
        });
        cookie = joinCookieObj(obj);
      }
      if (!cookie) return { error: 'Cookie 不能为空' };
      if (!cookie.includes('SAPISID')) return { error: 'cookie 里没有 SAPISID，多半没复制全' };
      return { label, cookie, note, authuser };
    },
  });
  if (!data) return;
  const r = await fetch('api/cookies', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const j = await r.json();
  if (j.error) return flash('导入失败：' + j.error);
  flash('Cookie 已导入 #' + j.id);
  await refreshPage();
}

// parseAuthUser 把账号序号输入框的值转成 0..9 的整数，不合法返回 null。空 = 0。
function parseAuthUser(v) {
  const s = String(v ?? '').trim();
  if (s === '') return 0;
  if (!/^\d$/.test(s)) return null;
  return parseInt(s, 10);
}

async function editCookieAcct(id, label, note, authuser, proxyID, proxyExclusive) {
  let proxies = [];
  try { proxies = (await api('api/proxies')).items || []; } catch (e) {}
  const proxyOptions = proxies.map(p => {
    const state = p.state === 'cooling'
      ? (LANG === 'en' ? ' · IP cooling' : ' · IP 冷却中')
      : p.state === 'disabled'
        ? (LANG === 'en' ? ' · disabled' : ' · 已禁用')
        : '';
    const owner = p.exclusive_account_id && p.exclusive_account_id !== id
      ? (LANG === 'en' ? ` · owned by #${p.exclusive_account_id}` : ` · 已被 #${p.exclusive_account_id} 独占`)
      : '';
    return `<option value="${p.id}" ${p.id === proxyID ? 'selected' : ''}>${escapeHtml(p.name || ('#' + p.id))} — ${escapeHtml(p.url)}${state}${owner}</option>`;
  }).join('');

  const ok = await buildModal({
    title: '编辑 Cookie #' + id,
    wide: true,
    desc: '改标签、备注、账号序号和出口绑定。要换 cookie 请删掉重新导入。',
    bodyHTML: `
      <div class="field">
        <label>标签</label>
        <input data-name="label" type="text" value="${escapeHtml(label || '')}" placeholder="账号邮箱" />
      </div>
      <div class="field">
        <label>账号序号</label>
        <input data-name="authuser" type="text" inputmode="numeric" value="${authuser || 0}" />
        <div class="hint">浏览器里同时登了多个 Google 号时用：地址栏 /u/1/ 填 1，没有 /u/ 填 0。</div>
      </div>
      <div class="field">
        <label>出口</label>
        <select data-name="proxy_id">
          <option value="0" ${!proxyID ? 'selected' : ''}>不绑定（按调度自动选择共享出口）</option>
          ${proxyOptions}
        </select>
        <div class="hint">绑定后优先用这个出口。勾选独占后，这个 IP 只允许本 Cookie 使用，其他账号和匿名请求都不会用它；IP 冷却或容量满时本 Cookie 暂时不可用，不会换别的 IP。</div>
      </div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="proxy_exclusive" ${proxyExclusive ? 'checked' : ''} ${!proxyID ? 'disabled' : ''} />
        <span>独占此 IP</span>
      </label>
      <div class="field" style="margin-top:12px;">
        <label>备注</label>
        <input data-name="note" type="text" value="${escapeHtml(note || '')}" placeholder="可留空" />
      </div>`,
    onReady: (overlay) => {
      const sel = overlay.querySelector('[data-name=proxy_id]');
      const chk = overlay.querySelector('[data-name=proxy_exclusive]');
      const sync = () => {
        if (sel.value === '0') {
          chk.checked = false;
          chk.disabled = true;
        } else {
          chk.disabled = false;
        }
      };
      sel.onchange = sync;
      sync();
    },
    submitText: '保存',
    onSubmit: async (overlay) => {
      const au = parseAuthUser(overlay.querySelector('[data-name=authuser]').value);
      if (au === null) return { error: '账号序号要填 0 到 9 的整数' };
      const pid = parseInt(overlay.querySelector('[data-name=proxy_id]').value || '0', 10);
      const excl = overlay.querySelector('[data-name=proxy_exclusive]').checked && pid > 0;
      const payload = {
        label: (overlay.querySelector('[data-name=label]').value || '').trim(),
        note: (overlay.querySelector('[data-name=note]').value || '').trim(),
        authuser: au,
        proxy_id: pid,
        proxy_exclusive: excl,
      };
      const r = await fetch('api/cookies/' + id, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) return { error: j.error || ('HTTP ' + r.status) };
      return true;
    },
  });
  if (ok) {
    flash(t('已保存'));
    await refreshPage();
  }
}

// 检测 cookie 还有没有登录态。判据是 /app 页面里有没有 SNlM0e——cookie 失效时
// Gemini 不报错、只是把你当匿名，纯文本请求照样 200，所以不能拿"请求成功"当判据。
async function checkCookieAcct(id, btn) {
  const old = btn.textContent;
  btn.textContent = t('检测中…'); btn.disabled = true;
  try {
    const r = await fetch('api/cookies/' + id + '/check',
      { method: 'POST', credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { flash(t('检测失败：') + t(d.error || r.status)); return; }
    const via = d.proxy_name ? `，出口 ${d.proxy_name}` : '';
    flash((d.ok ? '✓ #' + id + ' ' : '✗ #' + id + ' ') + (d.detail || '') +
          `${via}，${d.took_ms}ms`);
    await refreshPage();
  } finally {
    btn.textContent = old; btn.disabled = false;
  }
}

// 手动触发一次会话保活（刷新 1PSIDTS + SIDCC）。后台启动 15 秒后跑第一次，之后每 10 分钟。
async function rotateCookieAcct(id, btn) {
  const old = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('api/cookies/' + id + '/rotate',
      { method: 'POST', credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { flash(t('保活失败：') + t(d.error || r.status)); return; }
    flash((d.ok ? '✓ #' + id + ' ' : '✗ #' + id + ' ') + (d.detail || '') +
          (d.next_sec ? `，服务端建议 ${d.next_sec}s 后再来` : ''));
    await refreshPage();
  } finally { btn.textContent = old; btn.disabled = false; }
}

async function toggleCookieAcct(id) {
  await api('api/cookies/' + id + '/toggle', { method: 'POST' });
  await refreshPage();
}

async function delCookieAcct(id) {
  const ok = await modalConfirm({
    title: '删除 Cookie',
    desc: `确定删除账号 #${id}？此操作不可撤销，删除后请求不再用它。`,
    confirmText: '删除', danger: true,
  });
  if (!ok) return;
  await api('api/cookies/' + id, { method: 'DELETE' });
  flash('已删除');
  await refreshPage();
}

async function doLogout() {
  const ok = await modalConfirm({
    title: '退出登录',
    desc: '退出后需要重新输入管理员 token 才能进来。服务本身不受影响，API 照常提供。',
    confirmText: '退出',
    danger: true,
  });
  if (!ok) return;
  await api('api/logout', { method: 'POST' });
  currentPage = null;
  renderLogin();
}

// 连通性诊断 ──────────────────────────────────────────────────────────────

async function populateTestProxies() {
  const sel = document.getElementById('testProxy');
  if (!sel) return;
  // 清掉旧的代理选项（保留前两个固定项）
  while (sel.options.length > 2) sel.remove(2);
  try {
    const data = await api('api/proxies');
    (data.items || []).filter(p => p.enabled).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.text = (LANG === 'en' ? 'Proxy: ' : '代理: ') + t(p.name);
      sel.appendChild(opt);
    });
  } catch (e) { /* ignore — login redirect handled in api() */ }
}

async function runTest() {
  const sel = document.getElementById('testProxy');
  const proxy = sel.value;
  const box = document.getElementById('testResult');
  box.style.display = 'block';
  box.innerHTML = `<div class="empty">${t('正在测试…（最多等 30 秒）')}</div>`;
  try {
    const url = 'api/test' + (proxy !== '' ? '?proxy_id=' + proxy : '');
    const r = await api(url);
    const statusBadge = {
      success: '<span class="badge ok">' + t('成功') + '</span>',
      blocked_sorry: '<span class="badge fail">' + t('被风控（302）') + '</span>',
      rate_limited: '<span class="badge fail">' + t('被限流（429）') + '</span>',
      upstream_error: '<span class="badge fail">' + t('上游错误') + '</span>',
      network_error: '<span class="badge fail">' + t('网络层错误') + '</span>',
    }[r.status] || `<span class="badge muted">${escapeHtml(r.status)}</span>`;
    const proxyDesc = (t(r.proxy_name) || '-') + (r.use_direct ? '' : (r.proxy_id ? ' (' + t('代理 #' + r.proxy_id) + ')' : ''));
    box.innerHTML = `
      <div style="display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; font-size: 13px;">
        <div style="color: var(--muted)">${t('结果')}</div><div>${statusBadge}</div>
        <div style="color: var(--muted)">HTTP code</div><div><code>${r.http_code || '-'}</code></div>
        <div style="color: var(--muted)">${t('总用时')}</div><div><code>${r.total_ms} ms</code></div>
        <div style="color: var(--muted)">${t('使用的 IP slot')}</div><div>${escapeHtml(proxyDesc)}</div>
        <div style="color: var(--muted)">${t('指纹')}</div><div><code>${escapeHtml(r.impersonate)}</code></div>
        ${r.response_text ? `<div style="color: var(--muted)">${t('回复内容')}</div><div class="pre">${escapeHtml(r.response_text)}</div>` : ''}
        <div style="color: var(--muted)">${t('诊断说明')}</div><div style="line-height: 1.6;">${escapeHtml(t(r.diagnostic))}</div>
        ${r.upstream_snip && !r.ok ? `<div style="color: var(--muted)">${t('上游响应片段')}</div>
          <div class="pre" style="max-height: 120px; overflow: auto; background: var(--bg); padding: 8px; border-radius: 4px;">${escapeHtml(r.upstream_snip)}</div>` : ''}
      </div>
    `;
    if (LANG === 'en') translateTree(box, true);
  } catch (e) {
    box.innerHTML = `<div class="err">${t('测试请求失败：' + e.message)}</div>`;
  }
}

// API key actions ──────────────────────────────────────────────────────────

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => flash('已复制到剪贴板'))
      .catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); flash('已复制（兼容模式）'); }
  catch (e) { flash('复制失败'); }
  ta.remove();
}

// 完整 Key 只在创建/轮换/reveal 时通过这个弹窗出现一次。
async function showKeyOnce(key, title) {
  if (!key) return;
  await buildModal({
    title: title || 'API Key',
    desc: '完整 Key 只在这里显示，请现在复制保存。',
    bodyHTML: `
      <div class="field">
        <label>Key</label>
        <div class="row">
          <input data-role="key" type="text" readonly value="${escapeHtml(key)}"
                 style="flex:1;min-width:0;font-family:ui-monospace,monospace" />
          <button class="btn muted" data-role="copy">复制</button>
        </div>
      </div>`,
    submitText: '完成',
    onReady: (overlay) => {
      overlay.querySelector('[data-role=copy]').onclick = () => copyText(key);
    },
    onSubmit: () => true,
  });
}

function keyAccountListHTML(selected) {
  const sel = new Set(selected || []);
  const rows = (keysAccountsCache || []).map(a => `
    <label class="row" style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;cursor:pointer;">
      <input type="checkbox" data-account="${a.id}" ${sel.has(a.id) ? 'checked' : ''} />
      <span>${escapeHtml(a.label || ('#' + a.id))}</span>
      <span class="badge ${a.status === 'enabled' ? 'ok' : 'muted'}">${a.status === 'enabled' ? '启用' : '停用'}</span>
      ${a.proxy_id ? `<span class="badge ${a.proxy_exclusive ? 'warn' : 'muted'}">${escapeHtml(a.proxy_name || ('#' + a.proxy_id))}${a.proxy_exclusive ? ' · 独占' : ''}</span>` : ''}
      ${a.available === false ? '<span class="badge fail">IP 不可用</span>' : ''}
    </label>`).join('');
  return rows || '<div class="empty">Cookie 池是空的</div>';
}

function keyModalSync(overlay) {
  const chk = overlay.querySelector('[data-name=allow_all]');
  const box = overlay.querySelector('[data-role=accts]');
  const sync = () => { box.style.display = chk.checked ? 'none' : ''; };
  chk.onchange = sync;
  sync();
}

function keyModalPayload(overlay) {
  return {
    allow_all: overlay.querySelector('[data-name=allow_all]').checked,
    account_ids: [...overlay.querySelectorAll('[data-account]:checked')]
      .map(el => parseInt(el.dataset.account, 10)),
    name: (overlay.querySelector('[data-name=name]').value || '').trim(),
    note: (overlay.querySelector('[data-name=note]').value || '').trim(),
    enabled: overlay.querySelector('[data-name=enabled]').checked,
  };
}

async function addKey() {
  if (!keysAccountsCache.length) {
    try { keysAccountsCache = (await api('api/cookies')).items || []; } catch (e) {}
  }
  const data = await buildModal({
    title: '新增 API Key', wide: true,
    desc: 'Key 留空会自动生成。关闭「允许全部账号」后只使用勾选的账号；一个都不勾时只能走匿名能力。',
    bodyHTML: `
      <div class="field"><label>名称</label>
        <input data-name="name" type="text" placeholder="例如 team-a" /></div>
      <div class="field"><label>Key（留空自动生成）</label>
        <input data-name="key" type="text" autocomplete="off" placeholder="至少 20 字符，或留空" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="allow_all" checked /><span>允许全部账号</span>
      </label>
      <div data-role="accts" style="display:none;margin:10px 0 12px;">
        <div class="hint" style="margin-bottom:6px;">只允许以下账号（可多选）：</div>
        <div style="max-height:220px;overflow:auto;border:1px solid #dadce0;border-radius:8px;padding:8px;">
          ${keyAccountListHTML([])}
        </div>
      </div>
      <div class="field"><label>备注</label>
        <input data-name="note" type="text" placeholder="可留空" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="enabled" checked /><span>启用</span>
      </label>`,
    onReady: keyModalSync,
    submitText: '创建',
    onSubmit: (overlay) => {
      const p = keyModalPayload(overlay);
      p.key = (overlay.querySelector('[data-name=key]').value || '').trim() || undefined;
      return p;
    },
  });
  if (!data) return;
  const r = await fetch('api/keys', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('创建失败：') + t(j.error || ('HTTP ' + r.status)));
  await showKeyOnce(j.key, 'API Key 已生成');
  await refreshPage();
}

async function editKey(id) {
  const k = keysListCache.find(x => x.id === id);
  if (!k) return;
  if (!keysAccountsCache.length) {
    try { keysAccountsCache = (await api('api/cookies')).items || []; } catch (e) {}
  }
  const data = await buildModal({
    title: '编辑 API Key #' + id, wide: true,
    desc: '改名称、启用状态和可用账号。要换 Key 值用下面的「自定义 Key」或列表里的「轮换」。',
    bodyHTML: `
      <div class="field"><label>名称</label>
        <input data-name="name" type="text" value="${escapeHtml(k.name || '')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="allow_all" ${k.allow_all ? 'checked' : ''} /><span>允许全部账号</span>
      </label>
      <div data-role="accts" style="display:none;margin:10px 0 12px;">
        <div class="hint" style="margin-bottom:6px;">只允许以下账号（可多选）：</div>
        <div style="max-height:220px;overflow:auto;border:1px solid #dadce0;border-radius:8px;padding:8px;">
          ${keyAccountListHTML(k.account_ids || [])}
        </div>
      </div>
      <div class="field"><label>自定义 Key（留空不改）</label>
        <input data-name="key" type="text" autocomplete="off" placeholder="留空保持当前 Key" />
        <div class="hint">改 Key 值会让旧 Key 立即失效。</div></div>
      <div class="field"><label>备注</label>
        <input data-name="note" type="text" value="${escapeHtml(k.note || '')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="enabled" ${k.enabled ? 'checked' : ''} /><span>启用</span>
      </label>`,
    onReady: keyModalSync,
    submitText: '保存',
    onSubmit: (overlay) => {
      const p = keyModalPayload(overlay);
      p.key = (overlay.querySelector('[data-name=key]').value || '').trim() || undefined;
      return p;
    },
  });
  if (!data) return;
  const r = await fetch('api/keys/' + id, {
    method: 'PATCH', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('保存失败：') + t(j.error || ('HTTP ' + r.status)));
  flash(t('已保存'));
  await refreshPage();
}

async function revealKey(id) {
  const r = await fetch('api/keys/' + id + '/reveal', { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('读取失败：') + t(j.error || ('HTTP ' + r.status)));
  await showKeyOnce(j.key, id === 0 ? '部署 Key' : 'API Key');
}

async function rotateKeyById(id) {
  const ok = await modalConfirm({
    title: '轮换 API Key',
    desc: '旧 Key 立即失效，所有使用它的客户端都要更换。确定继续？',
    confirmText: '轮换', danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/keys/' + id + '/rotate', { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('轮换失败：') + t(j.error || ('HTTP ' + r.status)));
  await showKeyOnce(j.key, '新的 API Key');
  await refreshPage();
}

async function toggleKey(id) {
  const r = await fetch('api/keys/' + id + '/toggle', { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('操作失败：') + t(j.error || ('HTTP ' + r.status)));
  await refreshPage();
}

async function delKey(id) {
  const ok = await modalConfirm({
    title: '删除 API Key',
    desc: `确定删除 Key #${id}？使用它的客户端会立即失去访问权限，此操作不可撤销。`,
    confirmText: '删除', danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/keys/' + id, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('删除失败：') + t(j.error || ('HTTP ' + r.status)));
  flash('已删除');
  await refreshPage();
}

function flash(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = t(msg);
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1F1F1F;color:#fff;'
    + 'padding:12px 20px;border-radius:12px;font-size:13px;z-index:9999;'
    + 'box-shadow:0 4px 16px rgba(60,64,67,.3);';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

// 自定义弹窗 ──────────────────────────────────────────────────────────────
//   modalConfirm({ title, desc, confirmText, danger })       -> bool
//   modalPrompt({ title, desc, label, placeholder, value })   -> string|null
//   modalForm({ title, desc, fields: [{name,label,...}], submitText })
//                                                            -> obj|null

function buildModal({ title, desc, bodyHTML, submitText, danger, wide, allowEnter, onReady, onSubmit }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        ${title ? `<h3>${escapeHtml(t(title))}</h3>` : ''}
        ${desc ? `<div class="desc">${t(desc)}</div>` : ''}
        <div class="modal-err" style="display:none;"></div>
        <div class="modal-body">${bodyHTML || ''}</div>
        <div class="actions">
          <button class="btn muted" data-act="cancel">${t('取消')}</button>
          <button class="btn ${danger ? 'danger' : ''}" data-act="ok">${escapeHtml(t(submitText || '确定'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (LANG === 'en') translateTree(overlay, true);
    // 弹窗挂上 DOM 之后再交给调用方接事件——内容是 innerHTML 灌进去的，
    // 早于这一步拿不到里面的节点。
    if (onReady) onReady(overlay);

    const finish = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', keyHandler);
      resolve(val);
    };
    const showErr = (msg) => {
      const e = overlay.querySelector('.modal-err');
      e.textContent = t(msg);
      e.style.display = msg ? 'block' : 'none';
      e.className = 'modal-err err';
    };

    overlay.querySelector('[data-act=cancel]').onclick = () => finish(null);
    overlay.querySelector('[data-act=ok]').onclick = async () => {
      const result = onSubmit ? await onSubmit(overlay) : true;
      if (result === false) return; // validation failed
      if (result && typeof result === 'object' && result.error) { showErr(result.error); return; }
      finish(result === true ? true : result);
    };
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };

    const keyHandler = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter' && allowEnter && document.activeElement.tagName !== 'TEXTAREA') {
        overlay.querySelector('[data-act=ok]').click();
      }
    };
    document.addEventListener('keydown', keyHandler);

    // 自动 focus 第一个 input
    setTimeout(() => {
      const first = overlay.querySelector('input,textarea');
      if (first) first.focus();
    }, 50);
  });
}

function modalConfirm({ title, desc, confirmText = '确定', danger = false }) {
  return buildModal({
    title, desc, bodyHTML: '', submitText: confirmText, danger, allowEnter: true,
    onSubmit: () => true,
  });
}

function modalPrompt({ title, desc, label, placeholder = '', value = '', hint, password = false }) {
  return buildModal({
    title, desc, allowEnter: true,
    bodyHTML: `<div class="field">
      ${label ? `<label>${escapeHtml(t(label))}</label>` : ''}
      <input type="${password ? 'password' : 'text'}" placeholder="${escapeHtml(t(placeholder))}" value="${escapeHtml(value)}" />
      ${hint ? `<div class="hint">${escapeHtml(t(hint))}</div>` : ''}
    </div>`,
    submitText: '确定',
    onSubmit: (overlay) => {
      const v = overlay.querySelector('input').value;
      if (!v) return { error: '不能为空' };
      return v;
    },
  });
}

// fields: [{ name, label, placeholder, hint, value, required, password }]
function modalForm({ title, desc, fields, submitText = '提交' }) {
  const html = fields.map(f => `
    <div class="field">
      <label>${escapeHtml(t(f.label))}${f.required ? ' *' : ''}</label>
      <input data-name="${escapeHtml(f.name)}" type="${f.password ? 'password' : 'text'}"
             placeholder="${escapeHtml(t(f.placeholder || ''))}"
             value="${escapeHtml(f.value || '')}" />
      ${f.hint ? `<div class="hint">${escapeHtml(t(f.hint))}</div>` : ''}
    </div>`).join('');
  return buildModal({
    title, desc, bodyHTML: html, submitText, allowEnter: true,
    onSubmit: (overlay) => {
      const out = {};
      for (const f of fields) {
        const el = overlay.querySelector(`[data-name="${f.name}"]`);
        const v = (el.value || '').trim();
        if (f.required && !v) return { error: `「${f.label}」不能为空` };
        if (f.minLength && v.length < f.minLength) return { error: `「${f.label}」至少 ${f.minLength} 字符` };
        out[f.name] = v;
      }
      return out;
    },
  });
}

// ─── Routing / shell ────────────────────────────────────────────────────────

let currentPage = null;
let pageSeq = 0;
// API Keys 页的数据缓存：编辑弹窗直接用列表里的字段，不用再请求一遍。
let keysListCache = [];
let keysAccountsCache = [];

// 点已经选中的导航项直接忽略：重新拉一遍数据、整块内容闪一下再画回原样，
// 用户看到的只是抖动。要重新取数有「刷新」按钮，走 refreshPage()。
async function switchPage(name, force = false) {
  if (!force && name === currentPage) return;
  const seq = ++pageSeq;
  currentPage = name;

  document.querySelectorAll('nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = PAGE_TITLES[name] || name;
  const main = document.getElementById('main');

  // 旧内容先留着，超过 200ms 还没好才显示占位——快的时候完全不闪
  const slow = setTimeout(() => {
    if (seq === pageSeq) main.innerHTML = '<div class="empty">加载中…</div>';
  }, 200);
  let html;
  try {
    html = await pages[name]();
  } catch (e) {
    clearTimeout(slow);
    if (seq === pageSeq) main.innerHTML = '<div class="empty">' + e.message + '</div>';
    return;
  }
  clearTimeout(slow);
  if (seq !== pageSeq) return;   // 期间又点了别的页，丢弃这次结果
  main.innerHTML = html;
  if (name === 'about') renderUpdate();

  if (name === 'dashboard') {
    await loadChart('24h');
    document.getElementById('rangeSel').onchange = (e) => loadChart(e.target.value);
    await populateTestProxies();
  }
  if (name === 'requests') {
    reqOffset = 0;
    document.getElementById('reqStatus').onchange = () => { reqOffset = 0; loadReqs(); };
    document.getElementById('reqModel').onchange = () => { reqOffset = 0; loadReqs(); };
    document.getElementById('reqSize').onchange = () => { reqOffset = 0; loadReqs(); };
    await loadReqs();
  }
  if (name === 'settings') {
    await loadRtCfg();
  }
}

// 主动重新拉当前页的数据（「刷新」按钮、增删改之后回填）
function refreshPage() { return switchPage(currentPage, true); }


const NAV = [
  ['dashboard', '概览'],
  ['requests', '请求记录'],
  ['proxies', '代理池'],
  ['cookies', 'Cookie 池'],
  ['keys', 'API Keys'],
  ['settings', '设置'],
  ['about', '关于'],
];
const PAGE_TITLES = {
  dashboard: '概览', requests: '请求记录', proxies: '代理池', cookies: 'Cookie 池',
  keys: 'API Keys', settings: '设置',
  about: '关于',
};

function toggleSidebar() {
  const el = document.querySelector('.sidebar');
  el.classList.toggle('collapsed');
  try { localStorage.setItem('sbCollapsed', el.classList.contains('collapsed') ? '1' : ''); } catch (e) {}
}

function renderShell() {
  const collapsed = (() => { try { return localStorage.getItem('sbCollapsed') === '1'; } catch (e) { return false; } })();
  document.getElementById('app').innerHTML = `
    <aside class="sidebar${collapsed ? ' collapsed' : ''}">
      <div class="side-top">
        <button class="icon-btn" onclick="toggleSidebar()" title="收起 / 展开" aria-label="收起或展开侧边栏">
          ${renderHugeIcon('menu', 20)}
        </button>
        <span class="brand-text"><span class="spark"></span>gemini-web2api</span>
      </div>
      <nav>
        ${NAV.map(([k, label]) => `
          <button data-page="${k}" onclick="switchPage('${k}')" title="${label}">
            ${renderHugeIcon(k, 20)}
            <span class="nav-label">${label}</span>
          </button>`).join('')}
      </nav>
      <div class="side-foot">
        <div id="sideStat"></div>
        <div class="sf-sep"></div>
        <button class="logout-btn" onclick="doLogout()" title="退出登录">
          ${renderHugeIcon('logout', 18)}
          <span class="nav-label">退出登录</span>
        </button>
      </div>
    </aside>
    <div class="content">
      <div class="topbar">
        <h1 class="page-title" id="pageTitle">概览</h1>
        <div class="topbar-right">
          <button class="upd-pill" id="updPill" style="display:none" onclick="switchPage('about')"
                  title="查看更新"><span>有新版本</span><b id="updPillVer"></b></button>
          <button class="icon-btn" id="themeBtn" onclick="toggleTheme()"
                  title="切换主题 / Toggle theme" aria-label="Toggle theme">
            ${renderHugeIcon(THEME === 'dark' ? 'sun' : 'moon', 18)}
          </button>
          <a class="icon-btn" href="${REPO_URL}" target="_blank" rel="noopener"
             title="GitHub 仓库" aria-label="GitHub">
            ${renderHugeIcon('github', 18)}
          </a>
          <button class="btn" id="langBtn" onclick="toggleLang()" style="padding:5px 10px;font-size:12px" title="切换语言 / Switch language">EN</button>
          <span class="dot" id="healthDot"></span>
          <span class="muted" id="healthText">运行中</span>
        </div>
      </div>
      <main id="main"></main>
    </div>
  `;
  switchPage('dashboard');
  loadSideStat();
  checkUpdate(false);
}

// 侧栏底部放真正有用的服务状态，而不是一个占位破折号
async function loadSideStat() {
  const box = document.getElementById('sideStat');
  if (!box) return;
  try {
    const [root, ck, usage] = await Promise.all([
      fetch('../').then(r => r.json()).catch(() => null),
      api('api/cookies').catch(() => null),
      api('api/usage').catch(() => null),
    ]);
    const dot = document.getElementById('healthDot');
    const ht = document.getElementById('healthText');
    if (dot) dot.classList.toggle('bad', !root);
    if (ht) ht.textContent = t(root ? '运行中' : '无法连接');
    box.innerHTML = [
      ['版本', root ? 'v' + root.version : '—'],
      ['模型', root ? root.models.length + (LANG === 'en' ? ' models' : ' 个') : '—'],
      ['Cookie', ck && ck.items && ck.items.length ? ck.items.length + (LANG === 'en' ? ' accounts' : ' 个') : t('匿名')],
      ['IP slot', usage ? (usage.items || []).length + (LANG === 'en' ? ' slots' : ' 个') : '—'],
    ].map(([k, v]) => `<div class="sf-row"><span>${t(k)}</span><b>${v}</b></div>`).join('');
  } catch (e) { box.innerHTML = ''; }
}

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-box">
      <h1><span class="spark" style="width:20px;height:20px;background:var(--g-sweep);
        border-radius:4px;display:inline-block;
        clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)"></span>
        gemini-web2api</h1>
      <input id="tokenInput" type="password" placeholder="管理员 Token" />
      <button class="btn" onclick="doLogin()">登录</button>
      <div id="loginErr" class="err"></div>
    </div>`;
  document.getElementById('tokenInput').focus();
  document.getElementById('tokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
}

async function doLogin() {
  const tok = document.getElementById('tokenInput').value;
  const r = await fetch('api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok }) });
  if (r.ok) renderShell();
  else document.getElementById('loginErr').textContent = t('Token 错误');
}

// ── 检查更新 ─────────────────────────────────────────────────────────────
// 由浏览器直接查 GitHub releases/latest，服务端不发请求：很多部署是内网或只走代理池
// 出网，让服务端连 GitHub 等于多一条不过代理池的出站连接。api.github.com 允许跨域，
// 匿名每小时 60 次，所以成功结果缓存 6 小时；失败不缓存，下次打开面板再试。
// 不做一键自更新：Docker 部署换容器里的文件重启就没了，Windows 也覆盖不了运行中的 exe，
// 所以只给出按部署方式的现成命令和下载链接。
const REPO = 'ElJoker63/gemini-web2api-go';
const REPO_URL = 'https://github.com/' + REPO;
const UPD_TTL_MS = 6 * 3600 * 1000;
let CURRENT_VERSION = '';
let UPD_ERR = '';      // 最近一次检查失败的原因（只放内存）
let UPD_BUSY = false;

async function ensureCurrentVersion() {
  if (CURRENT_VERSION) return CURRENT_VERSION;
  try {
    const root = await fetch('../').then(r => r.json());
    CURRENT_VERSION = String(root.version || '').replace(/^v/, '');
  } catch (e) {}
  return CURRENT_VERSION;
}

function updAutoEnabled() {
  try { return localStorage.getItem('updAuto') !== '0'; } catch (e) { return true; }
}
function setUpdAuto(on) {
  try { localStorage.setItem('updAuto', on ? '1' : '0'); } catch (e) {}
  if (on) checkUpdate(false);
}
function updCacheRead() {
  try { return JSON.parse(localStorage.getItem('updCache') || 'null'); } catch (e) { return null; }
}

// 比较 "4.25.0" 这类版本号：a>b 返回正数。
function verCmp(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// force=true：手动点「检查更新」，无视缓存和自动检查开关。
async function checkUpdate(force) {
  if (UPD_BUSY) return;
  await ensureCurrentVersion();
  let c = updCacheRead();
  const stale = !c || !c.tag || Date.now() - c.ts > UPD_TTL_MS;
  if (force || (updAutoEnabled() && stale)) {
    UPD_BUSY = true;
    renderUpdate();
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
        { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      c = {
        ts: Date.now(), tag: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url,
        body: j.body || '', published: j.published_at,
        assets: (j.assets || []).map(a => ({ name: a.name, url: a.browser_download_url })),
      };
      try { localStorage.setItem('updCache', JSON.stringify(c)); } catch (e) {}
      UPD_ERR = '';
    } catch (e) {
      UPD_ERR = e.message || String(e);
    }
    UPD_BUSY = false;
    if (force) {
      if (UPD_ERR) flash('检查失败，浏览器连不上 GitHub');
      else flash(verCmp(c.tag, CURRENT_VERSION) > 0 ? '发现新版本' : '已是最新版本');
    }
  }
  renderUpdate();
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = s; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  flash('已复制到剪贴板');
}

// 刷新顶栏的「有新版本」提示，以及「关于」页里的版本块（不在那页就只刷顶栏）。
function renderUpdate() {
  const c = updCacheRead();
  const hasNew = !!(c && c.tag && CURRENT_VERSION && verCmp(c.tag, CURRENT_VERSION) > 0);
  const pill = document.getElementById('updPill');
  if (pill) {
    pill.style.display = hasNew ? '' : 'none';
    document.getElementById('updPillVer').textContent = hasNew ? ' v' + c.tag : '';
  }

  const latest = document.getElementById('updLatest');
  if (!latest) return;
  const checked = document.getElementById('updChecked');
  const box = document.getElementById('updBox');
  if (UPD_BUSY) {
    latest.innerHTML = `<span class="muted">${t('检查中…')}</span>`;
    return;
  }
  latest.innerHTML = c && c.tag
    ? `<b>v${escapeHtml(c.tag)}</b> ` + (hasNew
        ? `<span class="badge warn">${t('有新版本')}</span>`
        : `<span class="badge ok">${t('已是最新版本')}</span>`)
    : '—';
  checked.textContent = c && c.ts ? new Date(c.ts).toLocaleString() : '—';
  if (UPD_ERR) {
    box.innerHTML = `<p class="err">${t('检查失败，浏览器连不上 GitHub')}（${escapeHtml(UPD_ERR)}）</p>`;
    return;
  }
  if (!hasNew) { box.innerHTML = ''; return; }

  const dockerCmd = 'docker compose pull && docker compose up -d';
  const bins = (c.assets || []).filter(a => !/SHA256SUMS/i.test(a.name));
  const sums = (c.assets || []).find(a => /SHA256SUMS/i.test(a.name));
  box.innerHTML = `
    <div class="upd-new">
      <h3><span>发现新版本</span> v${escapeHtml(c.tag)}</h3>
      <div class="muted" style="font-size:12px;">${c.published ? new Date(c.published).toLocaleDateString() : ''}</div>
      <details class="note" open style="margin-top:8px;">
        <summary>更新内容</summary>
        <div class="pre upd-notes">${escapeHtml(c.body)}</div>
      </details>
      <div class="label">Docker 部署</div>
      <div class="row cmd-row">
        <code>${escapeHtml(dockerCmd)}</code>
        <button class="btn muted" onclick="copyText(${escapeHtml(JSON.stringify(dockerCmd))})">复制</button>
      </div>
      <div class="label">二进制部署</div>
      <p class="hint" style="margin-bottom:6px;">下载对应平台的文件，替换旧的二进制后重启即可；数据在 data/ 目录，不受影响。</p>
      <ul class="asset-list">
        ${bins.map(a => `<li><a class="link" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a></li>`).join('')}
        ${sums ? `<li><a class="link" href="${escapeHtml(sums.url)}" target="_blank" rel="noopener">${escapeHtml(sums.name)}</a> <span class="muted">· <span>校验和</span></span></li>` : ''}
      </ul>
      <div style="margin-top:14px; display:flex; gap:10px; align-items:center;">
        <button id="btnAutoUpdate" class="btn primary" onclick="triggerAutoUpdate()">一键更新二进制</button>
        <a class="btn" href="${escapeHtml(c.url || REPO_URL + '/releases')}" target="_blank" rel="noopener">在 GitHub 查看</a>
      </div>
      <div id="updStatusMsg" style="margin-top:10px;"></div>
    </div>`;
}

async function triggerAutoUpdate() {
  const btn = document.getElementById('btnAutoUpdate');
  const msg = document.getElementById('updStatusMsg');
  if (btn) btn.disabled = true;
  if (msg) msg.innerHTML = '<span class="muted">正在下载并替换二进制，请稍候…</span>';
  try {
    const res = await api('/admin/api/update', { method: 'POST' });
    if (res && res.status === 'ok') {
      if (msg) msg.innerHTML = '<span class="badge ok">' + escapeHtml(res.message) + '</span>';
      flash('更新成功！请重启服务。');
    } else {
      throw new Error((res && res.error) || 'Update failed');
    }
  } catch (err) {
    if (msg) msg.innerHTML = '<span class="err">更新失败：' + escapeHtml(err.message || String(err)) + '</span>';
    flash('更新失败');
    if (btn) btn.disabled = false;
  }
}

// ── i18n（中 ⇄ 英）───────────────────────────────────────────────────────
// 机制：一个 MutationObserver 盯 #app，内容一变就按整段文本节点/属性精确匹配
// I18N_EN 词典替换成英文；切回中文时从 ZH_ORIG 里恢复原文。渲染逻辑一行不用改，
// 只在最外面套一层翻译。插值文案（带数字/名字的）不精确匹配、保持中文，属可接受。



// ── Theme (Dark Mode) Manager ─────────────────────────────────────────────
let THEME = (() => {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
})();

function applyTheme(theme) {
  THEME = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.innerHTML = renderHugeIcon(theme === 'dark' ? 'sun' : 'moon', 18);
  }
  // Update Chart theme if present
  if (charts.req && currentPage === 'dashboard') {
    const range = document.getElementById('rangeSel')?.value || '24h';
    loadChart(range);
  }
}

function toggleTheme() {
  const next = THEME === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch (e) {}
  applyTheme(next);
}

// ── i18n Engine (JSON-backed) ─────────────────────────────────────────────
let LANG = (() => {
  try {
    const l = localStorage.getItem('lang');
    return (l === 'es' || l === 'en' || l === 'zh') ? l : 'zh';
  } catch (e) {
    return 'zh';
  }
})();

const I18N_DATA = {};
const ZH_ORIG = new WeakMap();
const I18N_ATTRS = ['title', 'placeholder', 'aria-label'];

async function loadLocale(lang) {
  if (I18N_DATA[lang]) return I18N_DATA[lang];
  try {
    const r = await fetch(`locales/${lang}.json`);
    if (r.ok) {
      I18N_DATA[lang] = await r.json();
      return I18N_DATA[lang];
    }
  } catch (err) {
    console.warn('Could not load locale', lang, err);
  }
  return {};
}

const I18N_PATTERNS = [
  [/^upstream error:\s*(.*)$/i, (m, p1) => (LANG === 'es' ? 'Error de upstream: ' : 'Upstream error: ') + t(p1)],
  [/cookie\s*池里\s*(\d+)\s*个账号都不可用[（(]最后一个[：:](.*?)[）)]；到面板[「"']Cookie\s*池[」"']用[「"']检测[」"']按钮逐个排查，或打开\s*fallback_anon\s*降级匿名/g,
   (m, n, last) => LANG === 'es'
     ? `Las ${n} cuentas en el pool de cookies no están disponibles (última: ${t(last)}); revísalas en "Cookies" con el botón "Verificar", o activa fallback_anon`
     : `all ${n} account(s) in cookie pool unavailable (last: ${t(last)}); check accounts in "Cookie pool" with "Check" button, or enable fallback_anon to fall back to anonymous`],
  [/^上传附件\s*(.+)\s*失败[：:]\s*(.*)$/, (m, p1, p2) => (LANG === 'es' ? `Fallo al subir adjunto ${p1}: ` : `Failed to upload attachment ${p1}: `) + t(p2)],
  [/^建匿名会话失败[：:]\s*(.*)$/, (m, p1) => (LANG === 'es' ? 'Fallo al crear sesión anónima: ' : 'Failed to create anonymous session: ') + t(p1)],
  [/^取 XSRF 失败[：:]\s*(.*)$/, (m, p1) => (LANG === 'es' ? 'Fallo al obtener XSRF: ' : 'Failed to obtain XSRF: ') + t(p1)],
  [/^拿到 403，但没有有效的新 Cookie[（(](.*)[）)]$/, (m, p1) => (LANG === 'es' ? `Recibido 403 sin cookie nueva válida (${p1})` : `Got 403 but no valid new Cookie (${p1})`)],
  [/^拿到的 response_data 里没有会话 id[（(](.*)[）)]$/, (m, p1) => (LANG === 'es' ? `response_data sin ID de sesión (${p1})` : `No session id in response_data (${p1})`)],
  [/^会话被限流[（(](\d+)[）)]，服务端建议\s*(\d+)s\s*后再来$/, (m, p1, p2) => (LANG === 'es' ? `Sesión limitada (${p1}), reintentar en ${p2}s` : `Session rate limited (${p1}), retry in ${p2}s`)],
  [/^会话被限流[（(](\d+)[）)]$/, (m, p1) => (LANG === 'es' ? `Sesión limitada (${p1})` : `Session rate limited (${p1})`)],
  [/^出口被限流[（(](\d+)[）)]，服务端建议\s*(\d+)s\s*后再来$/, (m, p1, p2) => (LANG === 'es' ? `Salida limitada (${p1}), reintentar en ${p2}s` : `Egress rate limited (${p1}), retry in ${p2}s`)],
  [/^出口被限流[（(](\d+)[）)]$/, (m, p1) => (LANG === 'es' ? `Salida limitada (${p1})` : `Egress rate limited (${p1})`)],
  [/^账号不可用[（(](.*?)[）)]，换下一个账号重试$/, (m, p1) => (LANG === 'es' ? `Cuenta no disponible (${p1}), cambiando de cuenta...` : `Account unavailable (${p1}), trying next account`)],
  [/^网络层错误[（(](.*?)[）)]，换下一个账号重试$/, (m, p1) => (LANG === 'es' ? `Error de red (${p1}), cambiando de cuenta...` : `Network error (${p1}), trying next account`)],
  [/^登录态不可用[（(](.*?)[）)]，降级匿名重试$/, (m, p1) => (LANG === 'es' ? `Sesión no disponible (${p1}), reintentando en modo anónimo...` : `Login unavailable (${p1}), retrying anonymous`)],
  [/^所有账号均降级，返回 429[（(](.*?)[）)]$/, (m, p1) => (LANG === 'es' ? `Todas las cuentas degradadas, devuelto 429 (${p1})` : `All accounts downgraded, returning 429 (${p1})`)],
  [/^账号已被降级[（(](.*?)[）)]，换下一个账号重试$/, (m, p1) => (LANG === 'es' ? `Cuenta degradada (${p1}), cambiando de cuenta...` : `Account downgraded (${p1}), trying next account`)],
  [/^代理已连续失败\s*(\d+)\s*次，触发熔断停用[（(]冷却\s*(\d+)\s*分钟[）)]$/, (m, p1, p2) => (LANG === 'es' ? `Proxy con ${p1} fallos consecutivos, disyuntor activado (${p2} min de enfriamiento)` : `Proxy failed ${p1} times, circuit breaker tripped (${p2} min cooldown)`)],
  [/^代理已连续失败\s*(\d+)\s*次，记录失败计数[（(]熔断已关闭[）)]$/, (m, p1) => (LANG === 'es' ? `Proxy con ${p1} fallos consecutivos registrados (disyuntor desactivado)` : `Proxy failed ${p1} times, recorded failure count (circuit breaker disabled)`)],
  [/^轮换代理[（(](.*?)[）)]$/, (m, p1) => (LANG === 'es' ? `Rotando proxy (${p1})` : `Rotating proxy (${p1})`)],
  [/^代理重试[（(](.*?)[）)]$/, (m, p1) => (LANG === 'es' ? `Reintento de proxy (${p1})` : `Proxy retry (${p1})`)],
  [/^\+(\d+)\s*个非关键项$/, (m, p1) => (LANG === 'es' ? `+${p1} elementos adicionales` : `+${p1} extra items`)],
  [/^约\s*(\d+)\s*分钟过期，保活会自动换发$/, (m, p1) => (LANG === 'es' ? `Caduca en ~${p1} min, se renueva automáticamente` : `Expires in ~${p1} min, renewed automatically`)],
  [/^连打\s*(\d+)\s*次$/, (m, p1) => (LANG === 'es' ? `${p1} peticiones seguidas` : `${p1} consecutive requests`)],
  [/^连打\s*(\d+)\s*次失败$/, (m, p1) => (LANG === 'es' ? `${p1} fallos consecutivos` : `${p1} consecutive failures`)],
  [/^第\s*(\d+)\s*次重试[：:](.*)$/, (m, p1, p2) => (LANG === 'es' ? `Reintento #${p1}: ` : `Retry #${p1}: `) + t(p2)],
];

function t(s) {
  if (LANG === 'zh' || !s) return s;
  const k = String(s).trim().replace(/\s+/g, ' ');
  const dict = I18N_DATA[LANG] || {};
  if (dict[k]) return dict[k];
  if (LANG === 'es' && I18N_DATA['en'] && I18N_DATA['en'][k]) return I18N_DATA['en'][k];

  // Toast / status prefix pattern
  const toastMatch = k.match(/^([✓✗]\s*#\d+\s+)(.*)$/);
  if (toastMatch) {
    let rest = toastMatch[2];
    if (LANG === 'es') {
      rest = rest.replace(/保活成功，刷新了\s*/, 'Keepalive exitoso, renovado ');
      rest = rest.replace(/，但缺 SAPISID（算不出授权头，部分接口会被当匿名）/, ', pero falta SAPISID (no se puede firmar cabecera)');
      rest = rest.replace(/，出口\s*([^，,]+)/, (x, p) => `, salida ${t(p.trim())}`);
      rest = rest.replace(/，服务端建议\s*(\d+)s\s*后再来/, ', el servidor sugiere reintentar en $1s');
      rest = rest.replace(/，(\d+)ms/, ', $1ms');
    } else {
      rest = rest.replace(/保活成功，刷新了\s*/, 'Keepalive succeeded, refreshed ');
      rest = rest.replace(/，但缺 SAPISID（算不出授权头，部分接口会被当匿名）/, ', but missing SAPISID (cannot sign auth header)');
      rest = rest.replace(/，出口\s*([^，,]+)/, (x, p) => `, egress ${t(p.trim())}`);
      rest = rest.replace(/，服务端建议\s*(\d+)s\s*后再来/, ', upstream suggests retry in $1s');
      rest = rest.replace(/，(\d+)ms/, ', $1ms');
    }
    return toastMatch[1] + rest;
  }

  let cur = k;
  let matched = false;
  for (const [re, repl] of I18N_PATTERNS) {
    if (re.test(cur)) {
      cur = cur.replace(re, repl);
      matched = true;
    }
  }
  return matched ? cur : s;
}

function translateTree(root, lang) {
  if (!root) return;
  const isTranslated = lang === 'en' || lang === 'es';
  const dict = I18N_DATA[lang] || {};
  const norm = s => String(s).trim().replace(/\s+/g, ' ');

  // 1. Text nodes
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (isTranslated && n.parentElement && n.parentElement.closest('[data-zh-html]')) continue;
    const raw = n.nodeValue;
    const key = norm(raw);
    if (!key) continue;
    if (isTranslated) {
      let tr = dict[key] || (lang === 'es' && I18N_DATA['en'] ? I18N_DATA['en'][key] : null);
      if (!tr) {
        let cur = key;
        let matched = false;
        for (const [re, repl] of I18N_PATTERNS) {
          if (re.test(cur)) {
            cur = cur.replace(re, repl);
            matched = true;
          }
        }
        if (matched) tr = cur;
      }
      if (tr) {
        if (!ZH_ORIG.has(n)) ZH_ORIG.set(n, raw);
        const leading = raw.match(/^\s*/)[0];
        const trailing = raw.match(/\s*$/)[0];
        n.nodeValue = leading + tr + trailing;
      }
    } else if (ZH_ORIG.has(n)) {
      n.nodeValue = ZH_ORIG.get(n);
      ZH_ORIG.delete(n);
    }
  }

  // 2. Element attributes (title, placeholder, aria-label)
  const scope = root.querySelectorAll ? root.querySelectorAll('[title],[placeholder],[aria-label]') : [];
  scope.forEach(el => {
    I18N_ATTRS.forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const dz = 'data-zh-' + attr;
      if (isTranslated) {
        const val = norm(el.getAttribute(attr));
        let tr = dict[val] || (lang === 'es' && I18N_DATA['en'] ? I18N_DATA['en'][val] : null);
        if (!tr) {
          let cur = val;
          let matched = false;
          for (const [re, repl] of I18N_PATTERNS) {
            if (re.test(cur)) {
              cur = cur.replace(re, repl);
              matched = true;
            }
          }
          if (matched) tr = cur;
        }
        if (tr && !el.hasAttribute(dz)) {
          el.setAttribute(dz, el.getAttribute(attr));
          el.setAttribute(attr, tr);
        }
      } else if (el.hasAttribute(dz)) {
        el.setAttribute(attr, el.getAttribute(dz));
        el.removeAttribute(dz);
      }
    });
  });
}

let i18nObserver = null;
let i18nPending = false;

function i18nApply() {
  const app = document.getElementById('app');
  if (!app) return;
  if (i18nObserver) i18nObserver.disconnect();
  translateTree(app, LANG);
  document.querySelectorAll('.modal-overlay, .toast').forEach(el => translateTree(el, LANG));
  if (i18nObserver) i18nObserver.observe(app, { childList: true, subtree: true, characterData: true });
}

function i18nSchedule() {
  if (i18nPending || LANG === 'zh') return;
  i18nPending = true;
  requestAnimationFrame(() => { i18nPending = false; i18nApply(); });
}

function i18nInit() {
  const app = document.getElementById('app');
  if (!app) return;
  i18nObserver = new MutationObserver(() => i18nSchedule());
  i18nObserver.observe(app, { childList: true, subtree: true, characterData: true });
  updateLangBtn();
  if (LANG !== 'zh') i18nApply();
}

function updateLangBtn() {
  const b = document.getElementById('langBtn');
  if (b) b.textContent = LANG === 'es' ? 'ES' : (LANG === 'en' ? 'EN' : '中');
  document.documentElement.lang = LANG === 'es' ? 'es' : (LANG === 'en' ? 'en' : 'zh-CN');
  document.title = LANG === 'es'
    ? 'gemini-web2api Panel de Administración'
    : (LANG === 'en' ? 'gemini-web2api Admin Panel' : 'gemini-web2api 管理面板');
}

async function toggleLang() {
  LANG = LANG === 'zh' ? 'en' : (LANG === 'en' ? 'es' : 'zh');
  try { localStorage.setItem('lang', LANG); } catch (e) {}
  await loadLocale(LANG);
  i18nApply();
  updateLangBtn();
  if (currentPage === 'dashboard') {
    const range = document.getElementById('rangeSel')?.value || '24h';
    loadChart(range);
  }
}

// ── Application Boot ───────────────────────────────────────────────────────
(async () => {
  await loadLocale(LANG);
  applyTheme(THEME);
  const r = await fetch('api/stats?hours=1', { credentials: 'include' });
  if (r.ok) renderShell();
  else renderLogin();
  i18nInit();
})();
