// 单出口能打多少次的实测区间是 80-180，取下沿当参考线。
// 它不是一条硬线：能打多少主要看连接复用和出口质量，而平缓节奏几乎打不满。
const BAN_LINE = 80;

const NOTE_BAN_LINE = '实测单个出口打 <b>80-180 次</b>后会被 Google 重定向到 <code>sorry/index</code>， 轨道取的是这个区间的<b>下沿</b>。区间这么宽是因为它主要由连接策略和出口质量 决定：同样并发 10，复用连接池能打到 172/177，每次新建连接只有 106/109； 静态 IP 上到过 188。<br><br> <b>它不是一条硬线。</b>节奏才是关键 —— 10 次/分钟平缓地打，连打 800 次、 跨 110 分钟一次没被拦。所以这条轨道是保守参考，不是"到了就会挂"。<br><br> 被拦之后是硬拦（封后 20 分钟内 60 次探测 0 成功），106-121 分钟自动恢复。 红竖线是本地 RPH 限额的位置，超了直接返回 429 而不去消耗 Google 配额。 要放大产能就在「代理池」加代理，每个代理是独立 slot。';
const NOTE_PROXY = '每个代理享有独立的并发 / RPM / RPH 配额，<b>配越多代理，总容量线性放大</b>。 请求会自动找有空位的代理，都满则返回 HTTP 429。失败 5 次自动熔断， 「重置」可手动恢复。<br><br> 注意：配了至少一个代理后<b>默认不会再退回直连</b>，避免代理满了把主机 IP 也打爆； 要可用性优先可以在「设置」页打开「无可用代理时退回直连」。熔断的代理默认歇 120 分钟自动放回池子（实测被拦的出口 106-121 分钟自恢复），也可以在这里手动重置。 实测单个出口打 80-180 次就会被 Google 拦，所以扩容只能靠加出口。';
const NOTE_COOKIE = '粘贴 gemini.google.com 下的<b>完整 cookie 串</b>（至少含 SID / HSID / SSID / APISID / SAPISID / __Secure-1PSID / __Secure-1PSIDTS）。请求时按<b>最久未用优先</b>自动轮转挑一个 启用的账号，媒体生成有每账号 10/天 的配额，配越多号总容量越大。<br><br> 凭证保存后<b>不再回传浏览器</b>，列表只显示脱敏摘要（cookie 数 / 关键项 / SAPISID 末 4 位 / 失败次数）。缺 <code>__Secure-1PSIDTS</code> 的号会标黄， 首次保活会尝试向 Google 补发；若反复失败请用 <b>Firefox</b> 重新导出 （Chrome 新版本的设备绑定会话续不了）。';
const NOTE_KEY = '每个 Key 默认允许全部账号；关闭「允许全部账号」后只使用勾选的 Cookie 账号，一个都不勾时只能走匿名能力（登录态模型会从该 Key 的模型列表隐藏，请求返回 403）。<br><br><code>--api-key</code> / <code>API_KEY</code> 提供的是<b>部署 Key</b>：永远启用、允许全部账号、面板只读，不能改值或删除；它和这里新增的 Key 同时有效。列表只显示脱敏值，需要完整 Key 时点「显示」。';

const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: 'include', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { renderLogin(); throw new Error('unauthorized'); }
  return r.json();
};

const fmt = {
  ts: (sec) => new Date(sec * 1000).toLocaleString(LANG === 'es' ? 'es-ES' : (LANG === 'en' ? 'en-US' : 'zh-CN'), { hour12: false }),
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
        <div class="kpi"><div class="label">${t('24 小时请求')}</div><div class="value">${fmt.num(stats.total_requests)}</div></div>
        <div class="kpi"><div class="label">${t('成功率')}</div><div class="value">${fmt.pct(stats.success_rate)}</div>
          <div class="sub">${fmt.num(stats.success)} ${t('成功')} · ${fmt.num(stats.failures)} ${t('失败')}</div></div>
        <div class="kpi"><div class="label">${t('平均延迟')}</div><div class="value">${fmt.ms(stats.avg_ms)}</div></div>
        <div class="kpi"><div class="label">${t('输入 Token')}</div><div class="value">${fmt.num(stats.prompt_tokens)}</div></div>
        <div class="kpi"><div class="label">${t('输出 Token')}</div><div class="value">${fmt.num(stats.output_tokens)}</div></div>
      </div>

      <div class="grid-main">
        <div class="panel">
          <h2>${t('请求量与延迟')}
            <span class="controls">
              <select id="rangeSel">
                <option value="24h">${t('最近 24 小时')}</option>
                <option value="7d">${t('最近 7 天')}</option>
                <option value="30d">${t('最近 30 天')}</option>
              </select>
            </span>
          </h2>
          <div class="chart-wrap"><canvas id="chartReq"></canvas></div>
        </div>

        <div class="stack">
        <div class="panel">
          <h2>${t('距离封禁红线')}
            <span class="controls"><button onclick="refreshPage()">${t('刷新')}</button></span>
          </h2>
          <div class="slot-scroll">
            ${(usage.items || []).map(u => {
              const rph = u.rph || 0;
              const limit = u.limit_rph || 0;
              const pct = Math.min(rph / BAN_LINE * 100, 100);
              const limitPct = limit ? Math.min(limit / BAN_LINE * 100, 100) : null;
              const left = Math.max(BAN_LINE - rph, 0);
              let noteCls = '', note = LANG === 'es' ? 'Quedan aprox. ' + left + ' peticiones' : (LANG === 'en' ? 'Can make ~' + left + ' more requests' : '还能再打约 ' + left + ' 次');
              if (rph >= BAN_LINE) { noteCls = 'danger'; note = t('已越过红线，随时可能被拦'); }
              else if (rph >= BAN_LINE * 0.75) { noteCls = 'warn'; note = LANG === 'es' ? 'Cerca del límite, solo quedan aprox. ' + left : (LANG === 'en' ? 'Near ban line, only ~' + left + ' left' : '接近红线，只剩约 ' + left + ' 次'); }
              else if (rph === 0) { note = t('本小时还没有请求'); }
              return `<div class="slot">
                <div class="slot-head">
                  <span class="slot-name">${escapeHtml(t(u.name))}</span>
                  <span class="slot-count"><b>${rph}</b> / ${BAN_LINE}</span>
                </div>
                <div class="track">
                  <div class="fill" style="width:${pct}%"></div>
                  ${limitPct !== null ? `<div class="redline" style="left:${limitPct}%"
                    title="${LANG === 'es' ? 'Límite local RPH ' + limit : (LANG === 'en' ? 'Local RPH limit ' + limit : '本地 RPH 限额 ' + limit)}"></div>` : ''}
                </div>
                <div class="slot-note ${noteCls}">${note} · ${t('并发')} ${u.inflight}/${u.limit_concurrent || '∞'}
                  · RPM ${u.rpm}/${u.limit_rpm || '∞'} · RPH ${rph}/${u.limit_rph || '∞'}</div>
              </div>`;
            }).join('') || '<div class="empty">' + t('还没有任何请求经过') + '</div>'}
          </div>
          <details class="note" style="margin:12px 0 0">
            <summary>${t('这条线是怎么来的')}</summary>
            <div class="body">${t(NOTE_BAN_LINE)}</div>
          </details>
        </div>

        <div class="panel">
          <h2>${t('连通性诊断')}
            <span class="controls"><button class="btn" onclick="runTest()">${t('测试一次')}</button></span>
          </h2>
          <select id="testProxy" style="width:100%">
            <option value="">${t('自动选择（按调度规则）')}</option>
            <option value="0">${t('直连主机 IP')}</option>
          </select>
          <p class="hint" style="margin-top:10px">
            ${t('打一次真实请求看是否通。不消耗限流配额、不写入请求记录。返回 302/429 就是出口进了黑名单，该换 IP。')}
          </p>
          <div id="testResult" style="display:none; margin-top:12px;"></div>
        </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>${t('按模型分组')}</h2>
          <table>
            <colgroup><col style="width:38%"><col style="width:14%"><col style="width:14%"><col style="width:16%"><col style="width:18%"></colgroup>
            <thead><tr><th>${t('模型')}</th><th class="nw">${t('请求')}</th><th class="nw">${t('成功')}</th><th class="nw">${t('平均')}</th><th class="nw">${t('Token')}</th></tr></thead>
            <tbody>${(stats.by_model || []).map(m => `
              <tr><td class="truncate" title="${escapeHtml(m.model)}">${m.model}</td>
                  <td class="num nw">${fmt.num(m.requests)}</td>
                  <td class="num nw">${fmt.num(m.success)}</td>
                  <td class="num nw">${fmt.ms(m.avg_ms)}</td>
                  <td class="num nw">${fmt.num(m.prompt_tokens + m.output_tokens)}</td></tr>`).join('')
              || '<tr><td colspan="5" class="empty">' + t('暂无数据') + '</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h2>${t('按出口分组')}</h2>
          <table>
            <colgroup><col style="width:46%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup>
            <thead><tr><th>${t('出口')}</th><th class="nw">${t('请求')}</th><th class="nw">${t('成功')}</th><th class="nw">${t('平均')}</th></tr></thead>
            <tbody>${(stats.by_proxy || []).map(p => `
              <tr><td class="truncate">${!p.proxy || p.proxy === '(direct)' ? t('直连') : escapeHtml(p.proxy)}</td>
                  <td class="num nw">${fmt.num(p.requests)}</td>
                  <td class="num nw">${fmt.num(p.success)}</td>
                  <td class="num nw">${fmt.ms(p.avg_ms)}</td></tr>`).join('')
              || '<tr><td colspan="4" class="empty">' + t('暂无数据') + '</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
          <h2>${t('错误分类')}（${t('近')} ${stats.window_hours || 24}h）</h2>
          <table>
            <colgroup><col style="width:22%"><col style="width:10%"><col style="width:68%"></colgroup>
            <thead><tr><th>${t('类型')}</th><th class="nw">${t('次数')}</th><th>${t('含义 / 该怎么办')}</th></tr></thead>
            <tbody>
              ${(stats.error_breakdown || []).map(e => `<tr>
                <td class="nw"><span class="badge ${ERR_BADGE[e.kind] || 'muted'}">${escapeHtml(e.kind)}</span></td>
                <td class="num nw">${e.count}</td>
                <td style="font-size:12.5px">${t(ERR_DESC[e.kind] || '')}
                  <div class="pre" style="margin-top:5px;color:var(--muted)">${escapeHtml(t(e.sample || ''))}</div></td>
              </tr>`).join('') || '<tr><td colspan="3" class="empty">' + t('窗口内没有失败') + '</td></tr>'}
            </tbody>
          </table>
      </div>
    `;
  },

  playground: async () => {
    return `
      <div class="pg-container page-fill">
        <!-- Main Chat Area -->
        <div class="pg-main">
          <div class="pg-header">
            <div class="pg-header-left">
              <span class="spark" style="width:16px;height:16px;background:var(--g-sweep);border-radius:3px;display:inline-block;clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)"></span>
              <span style="font-weight:600;font-size:13.5px">Gemini Playground</span>
              <span class="badge ok notranslate" id="pgCurModelBadge" style="margin-left:6px">gemini-3.6-flash</span>
            </div>
            <div class="pg-header-right" style="display:flex;gap:6px;align-items:center;">
              <button class="btn" style="padding:4px 10px;font-size:12px;background:var(--surface-hi);color:var(--text)" onclick="pgToggleSysPrompt()" title="${t('系统指令 (System Prompt)')}">
                ${renderHugeIcon('edit', 14)} <span>${t('系统指令')}</span>
              </button>
              <button class="btn" style="padding:4px 10px;font-size:12px;background:var(--surface-hi);color:var(--text)" onclick="pgShowCodeModal()" title="${t('查看代码 / Export code')}">
                ${renderHugeIcon('copy', 14)} <span>${t('代码')}</span>
              </button>
              <button class="btn" style="padding:4px 10px;font-size:12px;background:var(--surface-hi);color:var(--text)" onclick="pgClearChat()" title="${t('清空对话 / Clear chat')}">
                ${renderHugeIcon('trash', 14)} <span>${t('清空')}</span>
              </button>
            </div>
          </div>

          <!-- Collapsible System Prompt Banner -->
          <div id="pgSysWrap" style="display:none;padding:10px 16px;border-bottom:1px solid var(--outline-soft);background:var(--surface-hi);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:12px;color:var(--muted);font-weight:500">${t('系统指令 (System Prompt)')}</span>
              <button class="icon-btn" style="width:24px;height:24px" onclick="pgToggleSysPrompt()">${renderHugeIcon('close', 14)}</button>
            </div>
            <textarea id="pgSysPrompt" rows="2" style="font-family:var(--sans);font-size:12.5px" placeholder="${t('可选：输入系统人设或指令（例如：你是一个精通全栈开发的资深工程师）...')}"></textarea>
          </div>

          <!-- Messages Container -->
          <div class="pg-messages" id="pgMessages">
            <div class="pg-welcome" id="pgWelcome">
              <div style="width:48px;height:48px;background:var(--g-sweep);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)"></div>
              <h3 style="font-size:16px;font-weight:500;margin-bottom:6px">${t('Gemini Web2API Playground')}</h3>
              <p style="font-size:13px;color:var(--muted);max-width:440px;margin-bottom:16px;line-height:1.5">${t('Prueba y experimenta directamente con todos los modelos de Gemini, razonamiento (thinking), llamadas a herramientas y streaming.')}</p>
              <div class="pg-suggestions">
                <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('¿Cuáles son las principales diferencias entre Gemini 1.5, 2.0 y 2.5 Flash?')}')">💡 ${t('Diferencias entre modelos Gemini')}</button>
                <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('Escribe un script en Python con concurrencia para verificar el estado de una lista de URLs.')}')">🐍 ${t('Script Python concurrente')}</button>
                <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('¿Cuál es el clima actual en Tokio y qué ropa me recomiendas llevar? Usa la herramienta.')}')">🌦️ ${t('Prueba de herramientas (Tools)')}</button>
                <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('Si tengo 3 manzanas y me como 2, luego compro 5 y le regalo 1 a un amigo, ¿cuántas manzanas tengo? Explica paso a paso.')}')">🧠 ${t('Razonamiento paso a paso')}</button>
              </div>
            </div>
          </div>

          <!-- Input Bar Area -->
          <div class="pg-input-wrap">
            <div class="pg-input-bar">
              <textarea id="pgInput" rows="1" placeholder="${t('Escribe un mensaje... (Enter para enviar, Shift+Enter para nueva línea)')}" onkeydown="pgInputKeyDown(event)" oninput="pgAutoResize(this)"></textarea>
              <button class="btn" id="pgSendBtn" onclick="pgSendMessage()" style="padding:10px 18px">
                ${renderHugeIcon('plus', 16)} <span>${t('发送')}</span>
              </button>
              <button class="btn danger" id="pgStopBtn" onclick="pgStopGeneration()" style="display:none;padding:10px 18px">
                ${renderHugeIcon('close', 16)} <span>${t('停止')}</span>
              </button>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11.5px;color:var(--muted)">
              <span id="pgStatus">${t('Listo para interactuar')}</span>
              <span id="pgTokensInfo"></span>
            </div>
          </div>
        </div>

        <!-- Right Sidebar Area -->
        <div class="pg-sidebar">
          <div style="font-weight:600;font-size:14px;border-bottom:1px solid var(--outline-soft);padding-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
            <span>${t('Parámetros')}</span>
            <button class="btn" style="padding:2px 8px;font-size:11px;background:var(--surface-hi)" onclick="pgResetSettings()">${t('Restablecer')}</button>
          </div>

          <!-- Model Selector -->
          <div class="pg-group">
            <label for="pgModelSel">${t('Modelo')}</label>
            <select id="pgModelSel" onchange="pgOnModelChange()">
              <!-- Filled dynamically by initPlayground -->
            </select>
          </div>

          <!-- Temperature Slider -->
          <div class="pg-group">
            <label for="pgTemp"><span>${t('Temperatura')}</span><b id="pgTempVal">0.7</b></label>
            <input type="range" id="pgTemp" min="0" max="2" step="0.1" value="0.7" oninput="document.getElementById('pgTempVal').textContent = this.value">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)">
              <span>${t('Preciso (0.0)')}</span>
              <span>${t('Creativo (2.0)')}</span>
            </div>
          </div>

          <!-- Streaming Toggle -->
          <div class="pg-toggle-row">
            <label for="pgStreamSwitch">
              <span style="font-weight:500;font-size:13px">${t('Streaming')}</span>
              <span class="rthint" style="display:block">${t('Recibir respuesta en tiempo real')}</span>
            </label>
            <input type="checkbox" class="switch" id="pgStreamSwitch" checked>
          </div>

          <!-- Multi-turn Toggle -->
          <div class="pg-toggle-row">
            <label for="pgMultiTurnSwitch">
              <span style="font-weight:500;font-size:13px">${t('Historial multironda')}</span>
              <span class="rthint" style="display:block">${t('Enviar contexto de mensajes previos')}</span>
            </label>
            <input type="checkbox" class="switch" id="pgMultiTurnSwitch" checked>
          </div>

          <!-- Tools Preset Selector -->
          <div class="pg-group">
            <label for="pgToolPreset">${t('Llamada a herramientas (Tools)')}</label>
            <select id="pgToolPreset" onchange="pgOnToolPresetChange()">
              <option value="none" selected>${t('Ninguna')}</option>
              <option value="weather">⛅ get_weather(location, unit)</option>
              <option value="web_search">🌐 web_search(query)</option>
              <option value="calc">🔢 calculate(expression)</option>
              <option value="custom">${t('Esquema JSON personalizado...')}</option>
            </select>
          </div>

          <!-- Custom Tools JSON Textarea -->
          <div class="pg-group" id="pgCustomToolsWrap" style="display:none">
            <label for="pgCustomTools">${t('Definición de Tools (JSON)')}</label>
            <textarea id="pgCustomTools" rows="5" style="font-size:11px" placeholder='[{"type":"function","function":{"name":"...","parameters":{...}}}]'></textarea>
          </div>

          <!-- Custom API Key (Optional) -->
          <div class="pg-group">
            <label for="pgApiKey">${t('API Key (Opcional)')}</label>
            <input type="password" id="pgApiKey" placeholder="${t('Sesión de Admin actual')}">
            <span class="rthint">${t('Dejar vacío para usar la sesión de administrador actual sin restricciones.')}</span>
          </div>
        </div>
      </div>
    `;
  },

  requests: async () => {
    return `
      <div class="panel page-fill">
        <h2>${t('请求记录')}
          <span class="controls">
            <select id="reqStatus">
              <option value="">${t('全部')}</option>
              <option value="ok">${t('成功')}</option>
              <option value="fail">${t('失败')}</option>
            </select>
            <select id="reqModel"><option value="">${t('全部模型')}</option></select>
            <select id="reqSize">
              <option value="25">${t('每页 25')}</option>
              <option value="50" selected>${t('每页 50')}</option>
              <option value="100">${t('每页 100')}</option>
              <option value="200">${t('每页 200')}</option>
            </select>
            <button onclick="loadReqs()">${t('刷新')}</button>
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
              <th class="nw">${t('时间')}</th><th class="nw">${t('模型')}</th><th class="nw">${t('实际模型')}</th>
              <th class="nw">${t('出口')}</th><th class="nw">${t('账号')}</th><th class="nw">${t('状态')}</th>
              <th class="nw">${t('首字')}</th><th class="nw">${t('总用时')}</th>
              <th class="nw">${t('输入')}</th><th class="nw">${t('输出')}</th><th>${t('接口')}</th>
            </tr></thead>
            <tbody><tr><td colspan="11" class="empty">${t('加载中...')}</td></tr></tbody>
          </table>
        </div>
        <div class="pager" id="reqPager"></div>
      </div>
    `;
  },

  logs: async () => {
    return `
      <div class="panel page-fill">
        <h2>${t('系统日志')}
          <span class="controls">
            <select id="logSource">
              <option value="">${t('全部模块')}</option>
              <option value="cookie">${t('Cookie 账号 (Cookie)')}</option>
              <option value="rotate">${t('会话保活 (Rotate)')}</option>
              <option value="context">${t('上下文附件 (Context)')}</option>
              <option value="bl">${t('版本与指纹 (Protocol / BL)')}</option>
              <option value="proxy">${t('代理池 (Proxy)')}</option>
              <option value="general">${t('其他通用 (General)')}</option>
            </select>
            <select id="logLevel">
              <option value="">${t('全部级别')}</option>
              <option value="ERROR">${t('错误 (ERROR)')}</option>
              <option value="WARN">${t('警告 (WARN)')}</option>
              <option value="INFO">${t('信息 (INFO)')}</option>
            </select>
            <select id="logTail">
              <option value="50">${t('最新 50 行')}</option>
              <option value="100" selected>${t('最新 100 行')}</option>
              <option value="250">${t('最新 250 行')}</option>
              <option value="500">${t('最新 500 行')}</option>
            </select>
            <input type="text" id="logSearch" placeholder="${t('搜索关键词...')}" style="width:130px;padding:6px 10px;">
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:var(--text);cursor:pointer;">
              <input type="checkbox" id="logAutoRefresh" checked> ${t('自动刷新 (2s)')}
            </label>
            <button class="btn" onclick="loadLogs()">${t('刷新')}</button>
            <button class="btn muted" onclick="copyLogText()">${t('复制日志')}</button>
            <button class="btn muted" onclick="clearLogBuffer()">${t('清空缓冲')}</button>
          </span>
        </h2>
        <div id="logStatsBanner" style="font-size:12px;color:var(--muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
          <span id="logSummaryText">${t('正在加载日志...')}</span>
          <span style="font-family:var(--mono);">REST API: <code>GET /admin/api/logs?format=text&tail=100</code></span>
        </div>
        <div id="logContainer" style="background:#13151a;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.6;border-radius:10px;padding:12px 14px;flex:1;min-height:0;overflow-y:auto;box-shadow:inset 0 1px 3px rgba(0,0,0,0.5);">
          <div class="empty" style="color:#64748b;">${t('正在加载日志...')}</div>
        </div>
      </div>
    `;
  },

  proxies: async () => {
    const data = await api('api/proxies');
    return `
      <div class="panel page-fill">
        <h2>${t('代理池')}
          <span class="controls"><button class="btn" onclick="addProxy()">+ ${t('添加代理')}</button></span>
        </h2>
        <details class="note">
          <summary>${t('每个代理是一个独立 IP slot')}</summary>
          <div class="body">${t(NOTE_PROXY)}</div>
        </details>
        <div class="hint" style="margin:0 0 12px;">${t('代理可以在 Cookie 池里被某个账号独占绑定：独占后其他账号和匿名请求都不会用它，删除也会被拒绝（先去 Cookie 池解绑）。同一个 URL 不能建两条代理，否则独占会绕过。')}</div>
        <div class="table-scroll">
          <table>
            <colgroup>
              <col style="width:56px"><col style="width:150px"><col>
              <col style="width:88px"><col style="width:120px"><col style="width:80px">
              <col style="width:200px"><col style="width:186px">
            </colgroup>
            <thead><tr>
              <th class="nw">${t('ID')}</th><th class="nw">${t('名称')}</th><th>${t('代理 URL')}</th><th class="nw">${t('状态')}</th>
              <th class="nw">${t('专属账号')}</th><th class="nw">${t('失败')}</th><th class="nw">${t('最近错误')}</th><th class="nw">${t('操作')}</th>
            </tr></thead>
            <tbody>${(data.items || []).map(p => `
              <tr>
                <td class="num nw">${p.id}</td>
                <td class="truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                <td class="pre truncate" title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</td>
                <td class="nw">${
                  p.state === 'disabled' ? '<span class="badge muted">' + t('已禁用') + '</span>'
                  : p.state === 'cooling' ? `<span class="badge fail" title="${LANG === 'es' ? 'Falló ' + p.fail_count + ' veces consecutivas, enfriamiento del disyuntor activo' : (LANG === 'en' ? 'Failed ' + p.fail_count + ' consecutive times, circuit breaker cooling' : '连续失败 ' + p.fail_count + ' 次，熔断冷却中')}">${LANG === 'es' ? 'Enfriamiento ' + (p.cooldown_remaining_sec || 0) + 's' : (LANG === 'en' ? 'Cooldown ' + (p.cooldown_remaining_sec || 0) + 's' : '冷却 ' + (p.cooldown_remaining_sec || 0) + 's')}</span>`
                  : '<span class="badge ok">' + t('已启用') + '</span>'
                }</td>
                <td class="nw">${p.exclusive_account_id
                  ? `<span class="badge warn" title="${t('这个 IP 只允许该账号使用；删除前需先解绑')}">${escapeHtml(p.exclusive_account_label || ('#' + p.exclusive_account_id))}</span>`
                  : '<span class="badge muted">' + t('共享') + '</span>'}</td>
                <td class="num nw">${p.fail_count > 0 ? '<span class="badge fail">' + p.fail_count + '</span>' : p.fail_count}</td>
                <td class="pre truncate" title="${escapeHtml(t(p.last_error || ''))}">${escapeHtml(t(p.last_error) || '—')}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="toggleProxy(${p.id})">${p.enabled ? t('禁用') : t('启用')}</button>
                    <button class="btn muted" onclick="resetProxy(${p.id})">${t('重置')}</button>
                    <button class="btn danger" onclick="delProxy(${p.id})">${t('删除')}</button>
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="8" class="empty">' + t('还没有代理。点「+ 添加代理」加一个。') + '</td></tr>'}
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
        <h2>${t('Cookie 池')}
          <span class="controls">
            ${deadN > 0 ? '<span class="badge fail" style="margin-right:8px" title="' + t('这些号鉴权在失败，多半 cookie 过期了，建议用 Firefox 重新导出') + '">' + deadN + ' ' + t('疑似失效') + '</span>' : ''}
            <span class="badge ${data.enabled > 0 ? 'ok' : 'muted'}" style="margin-right:8px">${LANG === 'es' ? (data.enabled || 0) + ' activas / ' + (data.total || 0) + ' total' : (LANG === 'en' ? (data.enabled || 0) + ' active / ' + (data.total || 0) + ' total' : (data.enabled || 0) + ' 启用 / ' + (data.total || 0) + ' 共')}</span>
            <button class="btn" onclick="addCookieAcct()">+ ${t('导入 Cookie')}</button>
          </span>
        </h2>
        <details class="note">
          <summary>${t('每行一个 Google 登录态账号')}</summary>
          <div class="body">${t(NOTE_COOKIE)}</div>
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
              <th class="nw">${t('ID')}</th><th class="nw">${t('标签')}</th><th class="nw">${t('状态')}</th>
              <th class="nw">${t('出口')}</th><th class="nw">${t('可用性')}</th>
              <th class="nw">${t('关键 Cookie')}</th><th class="nw">${t('SAPISID')}</th><th class="nw">${t('失败')}</th>
              <th class="nw">${t('最近成功')}</th><th>${t('最近错误')}</th><th class="nw">${t('操作')}</th>
            </tr></thead>
            <tbody>${items.map(a => `
              <tr class="${a.health === 'dead' ? 'row-dead' : ''}">
                <td class="num nw">${a.id}</td>
                <td class="truncate" title="${escapeHtml(a.label || '')}">${a.label ? escapeHtml(a.label) : '<span class="badge muted">' + t('未命名') + '</span>'}${a.authuser > 0 ? ` <span class="badge muted" title="${LANG === 'es' ? 'Índice de cuenta: solicitudes van a /u/' + a.authuser + '/' : (LANG === 'en' ? 'Account index: requests go to /u/' + a.authuser + '/' : '账号序号：请求走 /u/' + a.authuser + '/')}">/u/${a.authuser}</span>` : ''}</td>
                <td class="nw">${
                  a.health === 'dead' ? '<span class="badge fail" title="' + t('鉴权在失败，多半 cookie 过期了，建议用 Firefox 重新导出') + '">' + t('疑似失效') + '</span>'
                  : a.health === 'disabled' ? '<span class="badge muted">' + t('禁用') + '</span>'
                  : a.health === 'unknown' ? '<span class="badge warn" title="' + t('还没成功用过，点「检测」确认') + '">' + t('待检测') + '</span>'
                  : '<span class="badge ok">' + t('正常') + '</span>'
                }</td>
                <td class="nw">${a.proxy_id
                  ? `<span class="badge ${a.proxy_exclusive ? 'warn' : 'muted'}" title="${escapeHtml(a.proxy_name || '')}">${escapeHtml(a.proxy_name || ('#' + a.proxy_id))}${a.proxy_exclusive ? ' · ' + t('独占') : ''}</span>`
                  : '<span class="badge muted" title="' + t('按调度自动选择共享出口') + '">' + t('自动') + '</span>'}</td>
                <td class="nw">${
                  a.status !== 'enabled' ? '<span class="badge muted">' + t('已停用') + '</span>'
                  : a.available === false
                    ? `<span class="badge fail" title="${escapeHtml(t(a.unavailable_reason || 'IP 冷却中，Cookie 暂不可用'))}">${t('IP 冷却中')}${a.proxy_retry_after ? ' ' + a.proxy_retry_after + 's' : ''}</span>`
                    : '<span class="badge ok">' + t('可用') + '</span>'
                }</td>
                <td class="nw" title="${LANG === 'es' ? 'Total ' + a.cookie_count + ' cookies, cookies clave: ' + (a.key_cookies||[]).join(' / ') : (LANG === 'en' ? 'Total ' + a.cookie_count + ' cookies, key items: ' + (a.key_cookies||[]).join(' / ') : '共 ' + a.cookie_count + ' 个 cookie，关键项：' + (a.key_cookies||[]).join(' / '))}">
                  <span class="badge ${a.has_1psidts && a.has_osid ? 'ok' : 'warn'}">${(a.key_cookies||[]).length}/10 ${t('项')}</span>
                  ${a.has_1psidts ? '' : '<span class="badge warn" title="' + t('缺 __Secure-1PSIDTS，首次保活会尝试补发；失败请用 Firefox 重新导出') + '">' + t('缺 TS') + '</span>'}
                  ${a.has_osid ? '' : '<span class="badge warn" title="' + t('缺 OSID：gemini.google.com 现在要求这一项，缺了会被跳去登录页。请在 gemini.google.com 页面重新导出') + '">' + t('缺 OSID') + '</span>'}
                </td>
                <td class="pre nw">${a.sapisid_tail ? '…' + escapeHtml(a.sapisid_tail) : '—'}</td>
                <td class="num nw">${a.fail_count > 0 ? '<span class="badge fail">' + a.fail_count + '</span>' : 0}</td>
                <td class="nw" style="font-size:12px;color:var(--muted)">${a.last_ok_at ? fmt.ts(a.last_ok_at) : '—'}</td>
                <td class="pre truncate" title="${escapeHtml(t(a.last_error || ''))}">${escapeHtml(t(a.last_error) || '—')}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="checkCookieAcct(${a.id}, this)">${t('检测')}</button>
                    <button class="btn muted" onclick="rotateCookieAcct(${a.id}, this)">${t('保活')}</button>
                    <button class="btn muted" onclick="toggleCookieAcct(${a.id})">${a.status === 'enabled' ? t('禁用') : t('启用')}</button>
                    <button class="btn muted" onclick="editCookieAcct(${a.id}, ${JSON.stringify(a.label || '').replace(/"/g, '&quot;')}, ${JSON.stringify(a.note || '').replace(/"/g, '&quot;')}, ${a.authuser || 0}, ${a.proxy_id || 0}, ${a.proxy_exclusive ? 'true' : 'false'})">${t('编辑')}</button>
                    <button class="btn danger" onclick="delCookieAcct(${a.id})">${t('删除')}</button>
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="11" class="empty">' + t('Cookie 池是空的。点「+ 导入 Cookie」加一个登录态账号。') + '</td></tr>'}
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
      if (k.allow_all) return '<span class="badge ok">' + t('全部账号') + '</span>';
      if (!(k.account_ids || []).length) return '<span class="badge warn" title="' + t('没有勾选账号，这把 Key 只能走匿名能力（登录态模型不可用）') + '">' + t('仅匿名') + '</span>';
      const acctWord = LANG === 'es' ? 'cuentas' : (LANG === 'en' ? 'accounts' : '个账号');
      return '<span class="badge muted" title="' + escapeHtml((k.account_ids || []).map(acctLabel).join(', ')) + '">' +
        (k.account_ids || []).length + ' ' + acctWord + '</span>';
    };
    return `
      <div class="panel page-fill">
        <h2>${t('API Keys')}
          <span class="controls"><button class="btn" onclick="addKey()">+ ${t('新增 Key')}</button></span>
        </h2>
        <details class="note">
          <summary>${t('多把 Key，各自限制可用账号')}</summary>
          <div class="body">${t(NOTE_KEY)}</div>
        </details>
        <div class="table-scroll">
          <table>
            <colgroup>
              <col style="width:48px"><col style="width:170px"><col>
              <col style="width:90px"><col style="width:130px"><col style="width:150px">
              <col style="width:210px">
            </colgroup>
            <thead><tr>
              <th class="nw">${t('ID')}</th><th class="nw">${t('名称')}</th><th>${t('Key')}</th>
              <th class="nw">${t('状态')}</th><th class="nw">${t('允许账号')}</th><th class="nw">${t('创建时间')}</th>
              <th class="nw">${t('操作')}</th>
            </tr></thead>
            <tbody>${items.map(k => `
              <tr>
                <td class="num nw">${k.id === 0 ? '—' : k.id}</td>
                <td class="truncate" title="${escapeHtml(k.name || '')}">${escapeHtml(k.name || '')}${k.locked ? ' <span class="badge warn">' + t('部署') + '</span>' : ''}</td>
                <td class="pre truncate" title="${escapeHtml(k.masked_key || '')}">${escapeHtml(k.masked_key || '—')}</td>
                <td class="nw">${k.enabled ? '<span class="badge ok">' + t('启用') + '</span>' : '<span class="badge muted">' + t('停用') + '</span>'}</td>
                <td class="nw">${allowCell(k)}</td>
                <td class="nw" style="font-size:12px;color:var(--muted)">${k.created_at ? fmt.ts(k.created_at) : '—'}</td>
                <td class="nw">
                  <span class="actions">
                    <button class="btn muted" onclick="revealKey(${k.id})">${t('显示')}</button>
                    ${k.locked ? '' : `
                      <button class="btn muted" onclick="editKey(${k.id})">${t('编辑')}</button>
                      <button class="btn muted" onclick="rotateKeyById(${k.id})">${t('轮换')}</button>
                      <button class="btn muted" onclick="toggleKey(${k.id})">${k.enabled ? t('停用') : t('启用')}</button>
                      <button class="btn danger" onclick="delKey(${k.id})">${t('删除')}</button>`}
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="7" class="empty">' + t('还没有额外的 API Key。部署 Key 不存在时需要新增一把。') + '</td></tr>'}
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
          <h2>${t('运行时配置')}</h2>
          <p class="lede">
            ${t('改完点保存立刻生效，不用重启。存在数据库里，优先级高于 config.json 和命令行参数。')}
          </p>
          <div id="rtCfgForm"></div>
          <div class="cfg-actions">
            <button class="btn" onclick="saveRtCfg()">${t('保存并生效')}</button>
            <button class="btn muted" onclick="loadRtCfg()">${t('放弃修改')}</button>
            <span id="rtCfgMsg" style="font-size:12.5px;"></span>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>${t('API Keys')}</h2>
            <p class="lede">
              ${t('支持多把 Key，每把可以限制可用账号。完整 Key 只在创建/轮换时显示一次，之后在「API Keys」页按需显示。')}
            </p>
            <div class="row" style="margin-bottom:10px;">
              <button class="btn" onclick="switchPage('keys')">${t('管理 API Keys')}</button>
            </div>
            <details class="note">
              <summary>${t('调用示例')}</summary>
              <div class="body">
                <pre class="pre" style="margin:0; font-size:11.5px;">curl http://your-host/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gemini-3.6-flash",
       "messages":[{"role":"user","content":"${LANG === 'es' ? '¡Hola!' : (LANG === 'en' ? 'Hello!' : '你好')}"}]}'</pre>
              </div>
            </details>
          </div>

          <div class="card">
            <h2>${t('部署配置')}</h2>
            <p class="lede">
              ${t('改这些本来就要重启进程，所以放在 docker-compose.yml 里管，不做成网页表单——凭证也不该经过浏览器。')}
            </p>
            <table id="deployTable" class="kv">
              <tbody></tbody>
            </table>
            <p class="lede" style="margin:14px 0 0;">
              ${t('gemini-web2api-go · 单二进制 · SQLite · Chrome 146 指纹 · tiktoken cl100k_base 计费')}
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
          <h2>${t('版本与更新')} <button class="btn muted" onclick="checkUpdate(true)">${t('检查更新')}</button></h2>
          <table class="kv">
            <tbody>
              <tr><td>${t('当前版本')}</td><td><b>${CURRENT_VERSION ? 'v' + escapeHtml(CURRENT_VERSION) : '—'}</b></td></tr>
              <tr><td>${t('最新版本')}</td><td id="updLatest">—</td></tr>
              <tr><td>${t('上次检查')}</td><td id="updChecked">—</td></tr>
            </tbody>
          </table>
          <label class="row" style="margin-top:12px; font-size:12.5px; cursor:pointer;">
            <input type="checkbox" class="switch" id="updAuto" ${updAutoEnabled() ? 'checked' : ''}
                   onchange="setUpdAuto(this.checked)" />
            <span>${t('打开面板时自动检查更新')}</span>
          </label>
          <p class="lede" style="margin:8px 0 0;">${t('由浏览器直接查询 GitHub，服务端不发任何请求；结果缓存 6 小时。')}</p>
          <div id="updBox"></div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>${t('项目')}</h2>
            <p class="lede">${t('把 gemini.google.com 网页端反代成 OpenAI / Gemini 兼容 API。开源，MIT 许可。')}</p>
            <table class="kv" style="margin-bottom:14px;">
              <tbody>
                <tr><td>${t('作者')}</td><td><a class="link" href="https://github.com/zexadev" target="_blank" rel="noopener">Zexa</a> <span class="muted">@zexadev</span></td></tr>
              </tbody>
            </table>
            <div class="about-links">
              <a class="btn" href="${REPO_URL}" target="_blank" rel="noopener">
                ${renderHugeIcon('star', 16)}<span>${t('去 GitHub 点 Star')}</span></a>
            </div>
            <p class="lede" style="margin:0;">${t('觉得好用就去 GitHub 仓库首页，点右上角的 Star。GitHub 的 topic 页按 Star 排序，这是别人找到这个项目的主要入口。')}</p>
          </div>

          <div class="card">
            <h2>${t('链接')}</h2>
            <table class="kv">
              <tbody>
                <tr><td>${t('仓库')}</td><td><a class="link" href="${REPO_URL}" target="_blank" rel="noopener">github.com/${REPO}</a></td></tr>
                <tr><td>${t('更新日志')}</td><td><a class="link" href="${REPO_URL}/blob/main/CHANGELOG.md" target="_blank" rel="noopener">CHANGELOG.md</a></td></tr>
                <tr><td>${t('发布页')}</td><td><a class="link" href="${REPO_URL}/releases" target="_blank" rel="noopener">Releases</a></td></tr>
                <tr><td>${t('提交问题')}</td><td><a class="link" href="${REPO_URL}/issues" target="_blank" rel="noopener">Issues</a></td></tr>
                <tr><td>${t('许可证')}</td><td><a class="link" href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener">MIT</a></td></tr>
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
    </tr>`).join('') || '<tr><td colspan="11" class="empty">' + t('还没有请求记录') + '</td></tr>';
  const size = reqPageSize();
  const total = data.total || 0;
  const page = Math.floor(reqOffset / size) + 1;
  const pages = Math.max(Math.ceil(total / size), 1);
  const from = total ? reqOffset + 1 : 0;
  const to = Math.min(reqOffset + size, total);
  document.getElementById('reqPager').innerHTML = `
    <span class="muted">${from}-${to} / ${LANG === 'es' ? 'total ' + total + ' registros' : (LANG === 'en' ? 'total ' + total + ' items' : '共 ' + total + ' 条')}</span>
    <span class="pager-btns">
      <button class="btn muted" ${reqOffset === 0 ? 'disabled' : ''}
        onclick="reqOffset=0;loadReqs()">${t('最前')}</button>
      <button class="btn muted" ${reqOffset === 0 ? 'disabled' : ''}
        onclick="reqOffset=Math.max(0,reqOffset-${size});loadReqs()">${t('上一页')}</button>
      <span class="muted" style="min-width:80px;text-align:center">${LANG === 'es' ? 'Pág. ' + page + ' / ' + pages : (LANG === 'en' ? 'Page ' + page + ' / ' + pages : '第 ' + page + ' / ' + pages + ' 页')}</span>
      <button class="btn muted" ${to >= total ? 'disabled' : ''}
        onclick="reqOffset+=${size};loadReqs()">${t('下一页')}</button>
      <button class="btn muted" ${to >= total ? 'disabled' : ''}
        onclick="reqOffset=${(pages-1)*size};loadReqs()">${t('最后')}</button>
    </span>
  `;
  if (LANG !== 'zh') {
    translateTree(tbody, LANG);
    const pager = document.getElementById('reqPager');
    if (pager) translateTree(pager, LANG);
  }
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

async function loadLogs(isBackground = false) {
  const box = document.getElementById('logContainer');
  if (!box) return;
  const source = document.getElementById('logSource')?.value || '';
  const level = document.getElementById('logLevel')?.value || '';
  const tail = document.getElementById('logTail')?.value || '100';
  const q = document.getElementById('logSearch')?.value || '';

  const params = new URLSearchParams();
  if (tail) params.set('tail', tail);
  if (source) params.set('source', source);
  if (level) params.set('level', level);
  if (q) params.set('q', q);

  try {
    const res = await api('api/logs?' + params.toString());
    const items = res.items || [];
    const summary = document.getElementById('logSummaryText');
    if (summary) {
      if (LANG === 'es') {
        summary.textContent = `Mostrando ${items.length} líneas (Total: ${res.total || items.length})`;
      } else if (LANG === 'en') {
        summary.textContent = `Showing ${items.length} entries (Total: ${res.total || items.length})`;
      } else {
        summary.textContent = `当前显示 ${items.length} 条记录（总计缓冲 ${res.total || items.length} 条）`;
      }
    }

    if (items.length === 0) {
      box.innerHTML = `<div class="empty" style="color:#64748b;">${t('暂无匹配的日志记录')}</div>`;
      return;
    }

    const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

    box.innerHTML = items.map(item => {
      let levelBadge = '';
      let msgColor = '#cbd5e1';
      if (item.level === 'ERROR') {
        levelBadge = '<span style="background:#ef4444;color:#fff;font-weight:600;padding:1px 5px;border-radius:4px;font-size:11px;margin-right:4px;">ERROR</span>';
        msgColor = '#fca5a5';
      } else if (item.level === 'WARN') {
        levelBadge = '<span style="background:#f59e0b;color:#000;font-weight:600;padding:1px 5px;border-radius:4px;font-size:11px;margin-right:4px;">WARN</span>';
        msgColor = '#fde68a';
      }

      let tagBg = '#334155';
      let tagFg = '#94a3b8';
      switch (item.source) {
        case 'cookie': tagBg = '#1e3a8a'; tagFg = '#93c5fd'; break;
        case 'rotate': tagBg = '#065f46'; tagFg = '#6ee7b7'; break;
        case 'context': tagBg = '#4c1d95'; tagFg = '#c4b5fd'; break;
        case 'bl': tagBg = '#701a75'; tagFg = '#f0abfc'; break;
        case 'proxy': tagBg = '#831843'; tagFg = '#fbcfe8'; break;
        case 'scheduler': tagBg = '#14532d'; tagFg = '#86efac'; break;
      }

      return `<div style="padding:2px 0;display:flex;align-items:flex-start;gap:6px;word-break:break-all;">
        <span style="color:#64748b;flex:none;white-space:nowrap;">[${escapeHtml(item.time)}]</span>
        <span style="background:${tagBg};color:${tagFg};padding:1px 6px;border-radius:4px;font-size:11px;white-space:nowrap;">[${escapeHtml(item.source)}]</span>
        ${levelBadge}
        <span style="color:${msgColor};overflow-wrap:anywhere;flex:1;">${escapeHtml(item.message)}</span>
      </div>`;
    }).join('');

    if (wasAtBottom || !isBackground) {
      box.scrollTop = box.scrollHeight;
    }
  } catch (e) {
    if (!isBackground) {
      box.innerHTML = `<div class="err">${t('加载日志失败：')}${escapeHtml(e.message)}</div>`;
    }
  }
}

async function copyLogText() {
  const source = document.getElementById('logSource')?.value || '';
  const level = document.getElementById('logLevel')?.value || '';
  const tail = document.getElementById('logTail')?.value || '100';
  const q = document.getElementById('logSearch')?.value || '';

  const params = new URLSearchParams({ format: 'text' });
  if (tail) params.set('tail', tail);
  if (source) params.set('source', source);
  if (level) params.set('level', level);
  if (q) params.set('q', q);

  try {
    const res = await fetch('api/logs?' + params.toString());
    const text = await res.text();
    await copyText(text);
  } catch (e) {
    flash(t('复制失败: ') + e.message);
  }
}

async function clearLogBuffer() {
  const ok = await modalConfirm({
    title: t('清空日志缓冲'),
    desc: t('确定要清空内存中的系统日志吗？这不会影响服务运行。'),
    confirmText: t('清空'),
    danger: true,
  });
  if (!ok) return;
  await api('api/logs', { method: 'DELETE' });
  flash(t('日志缓冲已清空'));
  await loadLogs();
}

// ── 运行时配置 ───────────────────────────────────────────────────────────────
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
      { k: 'request_timeout_sec', label: '上游超时（秒）', type: 'int', min: 5, max: 1200 },
      { k: 'retry_on_timeout', label: '超时后重试', type: 'bool',
        hint: '开：上游等满「上游超时」还没回完时，按重试次数再发（默认）。关：超时直接报错——等满一次都没回完，重发多半还是超时，一个请求最坏要等「超时 × 重试次数」，超长输入或慢模型（如 Argon）下能拖十几分钟。其他失败（空响应、出错话术等）照常重试' },
      { k: 'stream_keepalive_sec', label: '流式保活（秒）', type: 'int', min: 0, max: 300,
        hint: '流式请求连续这么多秒没往客户端写东西，就发一次保活，防止前面的 nginx / Cloudflare / newapi 等中间层因连接空闲回 504。建议 15。代价：保活要先开流（HTTP 200），之后再失败只能在流里报错、拿不到 502/429 状态码，依赖状态码换渠道的客户端会受影响；秒级就失败的请求不受影响。非流式请求无效。0=关（默认）' },
      { k: 'stream_idle_timeout_sec', label: '空闲超时（秒）', type: 'int', min: 0, max: 600,
        hint: '上游开流后连续这么多秒一个 chunk 都不来，就掐断当瞬时错误重试。「上游超时」是整条请求的总时限，管不到「首字节秒级就到、之后两三分钟一个字不来」这种挂法——这个专补那个缺口，让卡住的请求几十秒就换一次而不是干等到总超时。掐断会无条件重试（不受「超时后重试」开关影响）。建议 60。设得太小会误伤慢模型（如 Argon 首字节本身就慢）。0=关（默认）' },
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
      { k: 'strict_proxy_binding', label: '账号严格绑定出口', type: 'bool',
        hint: '每个号第一次用到哪个代理就绑定哪个。关：绑定的代理满了或在熔断冷却时换别的出口并重新绑定，可用性优先（默认）。开：这时只换号、不换出口，号都出不去就返回 429；同一个号始终从同一个 IP 出去。代理被删除或手动禁用时仍会重新绑定。在 Cookie 池里可以手动指定绑定' },
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
      <label for="rt_${f.k}">${t(f.label)}</label>
      ${input}
      ${f.hint ? `<div class="rthint">${escapeHtml(t(f.hint))}</div>` : ''}
    </div>`;
  };
  const toggleItem = f => `<div class="cfg-toggle">
      <input type="checkbox" class="switch" id="rt_${f.k}" ${rtCfgCache[f.k] ? 'checked' : ''}>
      <label for="rt_${f.k}">${t(f.label)}</label>
      ${f.hint ? `<div class="rthint">${escapeHtml(t(f.hint))}</div>` : ''}
    </div>`;
  document.getElementById('rtCfgForm').innerHTML = RT_GROUPS.map(g => {
    const inputs = g.fields.filter(f => f.type !== 'bool');
    const toggles = g.fields.filter(f => f.type === 'bool');
    return `
    <div class="cfg-group">
      <h3>${escapeHtml(t(g.title))}</h3>
      ${inputs.length ? `<div class="cfg-grid">${inputs.map(inputItem).join('')}</div>` : ''}
      ${toggles.length ? `<div class="cfg-toggles${inputs.length ? ' after-grid' : ''}">${toggles.map(toggleItem).join('')}</div>` : ''}
    </div>`;
  }).join('');

  const d = data.deploy || {};
  document.querySelector('#deployTable tbody').innerHTML = [
    ['监听', `${escapeHtml(d.host || '')}:${d.port}`, 'compose 的 ports + --port'],
    ['数据库', escapeHtml(d.db_path || ''), 'compose 的 volumes + --db'],
    ['Cookie 播种文件', d.cookie_file ? escapeHtml(d.cookie_file) : '<span class="badge muted">' + t('未配置') + '</span>',
     '启动时把文件内容导入 Cookie 池；之后从「Cookie 池」页面管理'],
    ['面板鉴权', d.admin_auth ? '<span class="badge ok">' + t('已开启') + '</span>'
                             : '<span class="badge fail">' + t('未设 token') + '</span>', 'compose 的 ADMIN_TOKEN'],
    ['API Key', d.api_key_locked ? '<span class="badge">' + t('部署锁定') + '</span>'
                                 : '<span class="badge ok">' + t('面板可轮换') + '</span>', 'compose 的 API_KEY'],
  ].map(r => `<tr><td title="${escapeHtml(t(r[2]))}">${t(r[0])}</td>
      <td class="pre" style="word-break:break-all;">${r[1]}</td></tr>`).join('');

  if (LANG !== 'zh') {
    translateTree(document.getElementById('rtCfgForm'), LANG);
    translateTree(document.querySelector('#deployTable tbody'), LANG);
  }
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
    title: t('添加代理'),
    desc: t('一个代理 = 一个独立 IP slot，享有独立的并发/RPM/RPH 配额。'),
    fields: [
      { name: 'name', label: t('名称'), placeholder: 'vps-uk-1', required: true,
        hint: t('随便起，admin 面板里用来区分') },
      { name: 'url', label: t('代理 URL'), placeholder: 'http://user:pass@1.2.3.4:8080', required: true,
        hint: t('支持 http:// / https:// / socks5:// 协议') },
    ],
    submitText: t('添加'),
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
    title: t('删除代理'),
    desc: LANG === 'es' ? `¿Estás seguro de eliminar el proxy #${id}? Esta acción no se puede deshacer. Los proxys reservados por una cookie deben desvincularse primero.` : (LANG === 'en' ? `Delete proxy #${id}? This cannot be undone. Proxies exclusively bound to a Cookie must be unbound first.` : `确定删除代理 #${id}？此操作不可撤销。被 Cookie 独占绑定的代理需要先解绑。`),
    confirmText: t('删除'),
    danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/proxies/' + id, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('删除失败：') + t(j.error || ('HTTP ' + r.status)));
  flash(t('已删除'));
  await refreshPage();
}
async function toggleProxy(id) {
  await api('api/proxies/' + id + '/toggle', { method: 'POST' });
  await refreshPage();
}
async function resetProxy(id) {
  await api('api/proxies/' + id + '/reset', { method: 'POST' });
  flash(t('已重置失败计数'));
  await refreshPage();
}

// Cookie 池 ────────────────────────────────────────────────────────────────
const COOKIE_KEYS = [
  { k: '__Secure-1PSID', hint: '主会话' },
  { k: 'SAPISID', req: true, hint: '算授权头用，缺了会被当匿名' },
  { k: '__Secure-1PSIDTS', hint: '约 30 分钟过期，保活会自动换发' },
  { k: 'SID' }, { k: 'HSID' }, { k: 'SSID' }, { k: 'APISID' },
  { k: 'OSID', hint: 'gemini.google.com 自己的登录 cookie，缺了会被跳去登录页' },
];

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
  let extras = {};

  const data = await buildModal({
    title: t('导入 Cookie'),
    wide: true,
    desc: t('浏览器 F12 → Application → Cookies → 选 <code>https://gemini.google.com</code>。逐项抄或整串粘贴都行，两种填法可随时切换，已填的内容会带过去。'),
    bodyHTML: `
      <div class="field">
        <label>${t('标签')}</label>
        <input data-name="label" type="text" placeholder="${t('例如账号邮箱，可留空')}" />
        <div class="hint">${t('仅用于面板里区分账号，不参与请求。')}</div>
      </div>

      <div class="field">
        <label>${t('账号序号')}</label>
        <input data-name="authuser" type="text" inputmode="numeric" value="0" />
        <div class="hint">${t('浏览器里同时登了多个 Google 号才需要改：打开那个号的 Gemini，地址栏是 /u/1/ 就填 1，没有 /u/ 就是 0。同一串 cookie 想当几个号用，就导入几次、各填各的序号。')}</div>
      </div>

      <div class="segbar" data-role="seg">
        <button type="button" data-mode="raw" class="on">${t('整串粘贴（推荐）')}</button>
        <button type="button" data-mode="fields">${t('逐项填写')}</button>
      </div>

      <div data-pane="fields" style="display:none;">
        <div class="ck-grid">
          ${COOKIE_KEYS.map(c => `
            <div class="field${c.k.length > 12 ? ' wide' : ''}">
              <label>${escapeHtml(c.k)}${c.req ? ' <span class="req">*</span>' : ''}</label>
              <input data-ck="${escapeHtml(c.k)}" type="text" autocomplete="off" spellcheck="false"
                     placeholder="${escapeHtml(t(c.hint || ''))}" />
            </div>`).join('')}
        </div>
        <div class="ck-extra" data-role="extras"></div>
        <div class="ck-extra">${t('前三项是同类项目实践里的最小可用集合，下面四项补齐更稳。 抓包实测浏览器每次实际会发 <b>20 多个</b> cookie，而我们把整串原样转发 （代码里只解析 SAPISID 用来算授权头），所以 <b>整串粘贴比逐项填更接近真实浏览器</b>；逐项模式适合手头只有零散几项时用。')}</div>
      </div>

      <div data-pane="raw">
        <div class="field">
          <textarea data-name="cookie" rows="6" spellcheck="false"
            placeholder="SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=...; __Secure-1PSIDTS=..."></textarea>
          <div class="hint">${t('整行粘贴，分号分隔。至少要含 SAPISID 和 __Secure-1PSID。 建议用 Firefox 导出（Chrome 新版本的会话绑在设备上，续不了）。DevTools 里全选复制即可， 多余的项会一并保留 —— 发得越全越像真实浏览器。')}</div>
        </div>
      </div>

      <div class="field" style="margin-top:14px;">
        <label>${t('备注')}</label>
        <input data-name="note" type="text" placeholder="${t('可留空')}" />
      </div>`,
    submitText: t('导入'),
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
          ? (LANG === 'es'
              ? `${n} elemento${n > 1 ? 's' : ''} adicional${n > 1 ? 'es' : ''} no listado${n > 1 ? 's' : ''} arriba (${Object.keys(extras).slice(0, 4).join(', ')}${n > 4 ? ' …' : ''}) se conservarán.`
              : (LANG === 'en'
                  ? `${n} additional item${n > 1 ? 's' : ''} not listed above (${Object.keys(extras).slice(0, 4).join(', ')}${n > 4 ? ' …' : ''}) will be kept.`
                  : `另有 ${n} 项未在上面列出（${Object.keys(extras).slice(0, 4).join(', ')}${n > 4 ? ' …' : ''}），会一并保留。`))
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
        };
      });
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
      if (authuser === null) return { error: t('账号序号要填 0 到 9 的整数') };
      const isRaw = overlay.querySelector('[data-role=seg] button.on').dataset.mode === 'raw';
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
      if (!cookie) return { error: t('Cookie 不能为空') };
      if (!cookie.includes('SAPISID')) return { error: t('cookie 里没有 SAPISID，多半没复制全') };
      return { label, cookie, note, authuser };
    },
  });
  if (!data) return;
  // 只提醒不拦：OSID 2026-11 才变成必需，判据只来自一个号的实测，硬拦可能挡掉能用的号。
  if (!/(^|;\s*)OSID=/.test(data.cookie)) {
    const go = await modalConfirm({
      title: t('缺 OSID'),
      desc: t('这串 cookie 里没有 OSID。gemini.google.com 现在要求这一项，缺了请求会被跳去登录页。请在已登录的 gemini.google.com 页面重新导出（F12 → 网络 → 任一发往 gemini.google.com 的请求 → 复制为 cURL）。'),
      confirmText: t('仍然导入'),
    });
    if (!go) return;
  }
  const r = await fetch('api/cookies', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const j = await r.json();
  if (j.error) return flash(t('导入失败：') + t(j.error));
  flash(LANG === 'es' ? 'Cookie #' + j.id + ' importada' : (LANG === 'en' ? 'Cookie #' + j.id + ' imported' : 'Cookie 已导入 #' + j.id));
  await refreshPage();
}

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
      ? (LANG === 'es' ? ' · IP en enfriamiento' : (LANG === 'en' ? ' · IP cooling' : ' · IP 冷却中'))
      : p.state === 'disabled'
        ? (LANG === 'es' ? ' · deshabilitado' : (LANG === 'en' ? ' · disabled' : ' · 已禁用'))
        : '';
    const owner = p.exclusive_account_id && p.exclusive_account_id !== id
      ? (LANG === 'es' ? ` · reservado por #${p.exclusive_account_id}` : (LANG === 'en' ? ` · owned by #${p.exclusive_account_id}` : ` · 已被 #${p.exclusive_account_id} 独占`))
      : '';
    return `<option value="${p.id}" ${p.id === proxyID ? 'selected' : ''}>${escapeHtml(p.name || ('#' + p.id))} — ${escapeHtml(p.url)}${state}${owner}</option>`;
  }).join('');

  const ok = await buildModal({
    title: t('编辑 Cookie') + ' #' + id,
    wide: true,
    desc: t('改标签、备注、账号序号和出口绑定。要换 cookie 请删掉重新导入。'),
    bodyHTML: `
      <div class="field">
        <label>${t('标签')}</label>
        <input data-name="label" type="text" value="${escapeHtml(label || '')}" placeholder="${t('账号邮箱')}" />
      </div>
      <div class="field">
        <label>${t('账号序号')}</label>
        <input data-name="authuser" type="text" inputmode="numeric" value="${authuser || 0}" />
        <div class="hint">${t('浏览器里同时登了多个 Google 号时用：地址栏 /u/1/ 填 1，没有 /u/ 填 0。')}</div>
      </div>
      <div class="field">
        <label>${t('出口')}</label>
        <select data-name="proxy_id">
          <option value="0" ${!proxyID ? 'selected' : ''}>${t('不绑定（按调度自动选择共享出口）')}</option>
          ${proxyOptions}
        </select>
        <div class="hint">${t('绑定后优先用这个出口。勾选独占后，这个 IP 只允许本 Cookie 使用，其他账号和匿名请求都不会用它；IP 冷却或容量满时本 Cookie 暂时不可用，不会换别的 IP。')}</div>
      </div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="proxy_exclusive" ${proxyExclusive ? 'checked' : ''} ${!proxyID ? 'disabled' : ''} />
        <span>${t('独占此 IP')}</span>
      </label>
      <div class="field" style="margin-top:12px;">
        <label>${t('备注')}</label>
        <input data-name="note" type="text" value="${escapeHtml(note || '')}" placeholder="${t('可留空')}" />
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
    submitText: t('保存'),
    onSubmit: async (overlay) => {
      const au = parseAuthUser(overlay.querySelector('[data-name=authuser]').value);
      if (au === null) return { error: t('账号序号要填 0 到 9 的整数') };
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
    title: t('删除 Cookie'),
    desc: LANG === 'es' ? `¿Estás seguro de eliminar la cuenta #${id}? Esta acción no se puede deshacer y las solicitudes ya no la usarán.` : (LANG === 'en' ? `Delete account #${id}? This cannot be undone; requests will no longer use it.` : `确定删除账号 #${id}？此操作不可撤销，删除后请求不再用它。`),
    confirmText: t('删除'), danger: true,
  });
  if (!ok) return;
  await api('api/cookies/' + id, { method: 'DELETE' });
  flash(t('已删除'));
  await refreshPage();
}

async function doLogout() {
  const ok = await modalConfirm({
    title: t('退出登录'),
    desc: t('退出后需要重新输入管理员 token 才能进来。服务本身不受影响，API 照常提供。'),
    confirmText: t('退出'),
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
  while (sel.options.length > 2) sel.remove(2);
  try {
    const data = await api('api/proxies');
    (data.items || []).filter(p => p.enabled).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.text = (LANG === 'en' ? 'Proxy: ' : '代理: ') + t(p.name);
      sel.appendChild(opt);
    });
  } catch (e) {}
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
    const proxyDesc = (t(r.proxy_name) || '-') + (r.use_direct ? '' : (r.proxy_id ? ' (' + t('代理') + ' #' + r.proxy_id + ')' : ''));
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
    if (LANG !== 'zh') translateTree(box, LANG);
  } catch (e) {
    box.innerHTML = `<div class="err">${t('测试请求失败：')} ${escapeHtml(e.message)}</div>`;
  }
}

// API key actions ──────────────────────────────────────────────────────────

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => flash(t('已复制到剪贴板')))
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
  try { document.execCommand('copy'); flash(t('已复制（兼容模式）')); }
  catch (e) { flash(t('复制失败')); }
  ta.remove();
}

async function showKeyOnce(key, title) {
  if (!key) return;
  await buildModal({
    title: t(title || 'API Key'),
    desc: t('完整 Key 只在这里显示，请现在复制保存。'),
    bodyHTML: `
      <div class="field">
        <label>Key</label>
        <div class="row">
          <input data-role="key" type="text" readonly value="${escapeHtml(key)}"
                 style="flex:1;min-width:0;font-family:ui-monospace,monospace" />
          <button class="btn muted" data-role="copy">${t('复制')}</button>
        </div>
      </div>`,
    submitText: t('完成'),
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
      <span class="badge ${a.status === 'enabled' ? 'ok' : 'muted'}">${a.status === 'enabled' ? t('启用') : t('停用')}</span>
      ${a.proxy_id ? `<span class="badge ${a.proxy_exclusive ? 'warn' : 'muted'}">${escapeHtml(a.proxy_name || ('#' + a.proxy_id))}${a.proxy_exclusive ? ' · ' + t('独占') : ''}</span>` : ''}
      ${a.available === false ? '<span class="badge fail">' + t('IP 不可用') + '</span>' : ''}
    </label>`).join('');
  return rows || '<div class="empty">' + t('Cookie 池是空的') + '</div>';
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
    title: t('新增 API Key'), wide: true,
    desc: t('Key 留空会自动生成。关闭「允许全部账号」后只使用勾选的账号；一个都不勾时只能走匿名能力。'),
    bodyHTML: `
      <div class="field"><label>${t('名称')}</label>
        <input data-name="name" type="text" placeholder="${t('例如 team-a')}" /></div>
      <div class="field"><label>${t('Key（留空自动生成）')}</label>
        <input data-name="key" type="text" autocomplete="off" placeholder="${t('至少 20 字符，或留空')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="allow_all" checked /><span>${t('允许全部账号')}</span>
      </label>
      <div data-role="accts" style="display:none;margin:10px 0 12px;">
        <div class="hint" style="margin-bottom:6px;">${t('只允许以下账号（可多选）：')}</div>
        <div style="max-height:220px;overflow:auto;border:1px solid #dadce0;border-radius:8px;padding:8px;">
          ${keyAccountListHTML([])}
        </div>
      </div>
      <div class="field"><label>${t('备注')}</label>
        <input data-name="note" type="text" placeholder="${t('可留空')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="enabled" checked /><span>${t('启用')}</span>
      </label>`,
    onReady: keyModalSync,
    submitText: t('创建'),
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
  await showKeyOnce(j.key, t('API Key 已生成'));
  await refreshPage();
}

async function editKey(id) {
  const k = keysListCache.find(x => x.id === id);
  if (!k) return;
  if (!keysAccountsCache.length) {
    try { keysAccountsCache = (await api('api/cookies')).items || []; } catch (e) {}
  }
  const data = await buildModal({
    title: t('编辑 API Key') + ' #' + id, wide: true,
    desc: t('改名称、启用状态和可用账号。要换 Key 值用下面的「自定义 Key」或列表里的「轮换」。'),
    bodyHTML: `
      <div class="field"><label>${t('名称')}</label>
        <input data-name="name" type="text" value="${escapeHtml(k.name || '')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="allow_all" ${k.allow_all ? 'checked' : ''} /><span>${t('允许全部账号')}</span>
      </label>
      <div data-role="accts" style="display:none;margin:10px 0 12px;">
        <div class="hint" style="margin-bottom:6px;">${t('只允许以下账号（可多选）：')}</div>
        <div style="max-height:220px;overflow:auto;border:1px solid #dadce0;border-radius:8px;padding:8px;">
          ${keyAccountListHTML(k.account_ids || [])}
        </div>
      </div>
      <div class="field"><label>${t('自定义 Key（留空不改）')}</label>
        <input data-name="key" type="text" autocomplete="off" placeholder="${t('留空保持当前 Key')}" />
        <div class="hint">${t('改 Key 值会让旧 Key 立即失效。')}</div></div>
      <div class="field"><label>${t('备注')}</label>
        <input data-name="note" type="text" value="${escapeHtml(k.note || '')}" /></div>
      <label class="row" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-name="enabled" ${k.enabled ? 'checked' : ''} /><span>${t('启用')}</span>
      </label>`,
    onReady: keyModalSync,
    submitText: t('保存'),
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
  await showKeyOnce(j.key, id === 0 ? t('部署 Key') : t('API Key'));
}

async function rotateKeyById(id) {
  const ok = await modalConfirm({
    title: t('轮换 API Key'),
    desc: t('旧 Key 立即失效，所有使用它的客户端都要更换。确定继续？'),
    confirmText: t('轮换'), danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/keys/' + id + '/rotate', { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('轮换失败：') + t(j.error || ('HTTP ' + r.status)));
  await showKeyOnce(j.key, t('新的 API Key'));
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
    title: t('删除 API Key'),
    desc: LANG === 'es' ? `¿Estás seguro de eliminar la Key #${id}? Los clientes que la usen perderán el acceso de inmediato, esta acción no se puede deshacer.` : (LANG === 'en' ? `Delete Key #${id}? Clients using it will immediately lose access. This cannot be undone.` : `确定删除 Key #${id}？使用它的客户端会立即失去访问权限，此操作不可撤销。`),
    confirmText: t('删除'), danger: true,
  });
  if (!ok) return;
  const r = await fetch('api/keys/' + id, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return flash(t('删除失败：') + t(j.error || ('HTTP ' + r.status)));
  flash(t('已删除'));
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
    if (onReady) onReady(overlay);
    if (LANG !== 'zh') translateTree(overlay, LANG);

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
      if (result === false) return;
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
    submitText: t('确定'),
    onSubmit: (overlay) => {
      const v = overlay.querySelector('input').value;
      if (!v) return { error: t('不能为空') };
      return v;
    },
  });
}

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
        if (f.required && !v) return { error: LANG === 'es' ? `"${t(f.label)}" es requerido` : (LANG === 'en' ? `"${t(f.label)}" is required` : `「${f.label}」不能为空`) };
        if (f.minLength && v.length < f.minLength) return { error: LANG === 'es' ? `"${t(f.label)}" debe tener al menos ${f.minLength} caracteres` : (LANG === 'en' ? `"${t(f.label)}" must be at least ${f.minLength} characters` : `「${f.label}」至少 ${f.minLength} 字符`) };
        out[f.name] = v;
      }
      return out;
    },
  });
}

// ─── Routing / shell ────────────────────────────────────────────────────────

let currentPage = null;
let pageSeq = 0;
let keysListCache = [];
let keysAccountsCache = [];

async function switchPage(name, force = false) {
  if (!force && name === currentPage) return;
  const seq = ++pageSeq;
  currentPage = name;

  document.querySelectorAll('nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = t(PAGE_TITLES[name] || name);
  const main = document.getElementById('main');

  const slow = setTimeout(() => {
    if (seq === pageSeq) main.innerHTML = '<div class="empty">' + t('加载中…') + '</div>';
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
  if (seq !== pageSeq) return;
  main.innerHTML = html;
  if (LANG !== 'zh') translateTree(main, LANG);
  if (name === 'about') renderUpdate();

  if (name === 'dashboard') {
    await loadChart('24h');
    document.getElementById('rangeSel').onchange = (e) => loadChart(e.target.value);
    await populateTestProxies();
  }
  if (name === 'playground') {
    await initPlayground();
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
  if (name === 'logs') {
    document.getElementById('logSource').onchange = () => loadLogs();
    document.getElementById('logLevel').onchange = () => loadLogs();
    document.getElementById('logTail').onchange = () => loadLogs();
    document.getElementById('logSearch').oninput = () => {
      clearTimeout(window.logSearchDebounce);
      window.logSearchDebounce = setTimeout(() => loadLogs(), 300);
    };
    await loadLogs();
    if (window.logTimer) clearInterval(window.logTimer);
    window.logTimer = setInterval(() => {
      if (currentPage === 'logs') {
        const auto = document.getElementById('logAutoRefresh');
        if (auto && auto.checked) {
          loadLogs(true);
        }
      } else {
        clearInterval(window.logTimer);
      }
    }, 2000);
  } else {
    if (window.logTimer) {
      clearInterval(window.logTimer);
      window.logTimer = null;
    }
  }
}

function refreshPage() { return switchPage(currentPage, true); }

const NAV = [
  ['dashboard', '概览'],
  ['playground', 'Playground'],
  ['requests', '请求记录'],
  ['logs', '系统日志'],
  ['proxies', '代理池'],
  ['cookies', 'Cookie 池'],
  ['keys', 'API Keys'],
  ['settings', '设置'],
  ['about', '关于'],
];
const PAGE_TITLES = {
  dashboard: '概览', playground: 'Playground', requests: '请求记录', logs: '系统日志', proxies: '代理池', cookies: 'Cookie 池',
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
        <button class="icon-btn" onclick="toggleSidebar()" title="${t('收起 / 展开')}" aria-label="${t('收起或展开侧边栏')}">
          ${renderHugeIcon('menu', 20)}
        </button>
        <span class="brand-text"><span class="spark"></span>gemini-web2api</span>
      </div>
      <nav>
        ${NAV.map(([k, label]) => `
          <button data-page="${k}" onclick="switchPage('${k}')" title="${t(label)}">
            ${renderHugeIcon(k, 20)}
            <span class="nav-label">${t(label)}</span>
          </button>`).join('')}
      </nav>
      <div class="side-foot">
        <div id="sideStat"></div>
        <div class="sf-sep"></div>
        <button class="logout-btn" onclick="doLogout()" title="${t('退出登录')}">
          ${renderHugeIcon('logout', 18)}
          <span class="nav-label">${t('退出登录')}</span>
        </button>
      </div>
    </aside>
    <div class="content">
      <div class="topbar">
        <h1 class="page-title" id="pageTitle">${t(PAGE_TITLES[currentPage || 'dashboard'] || '概览')}</h1>
        <div class="topbar-right">
          <button class="upd-pill" id="updPill" style="display:none" onclick="switchPage('about')"
                  title="${t('查看更新')}"><span>${t('有新版本')}</span><b id="updPillVer"></b></button>
          <button class="icon-btn" id="themeBtn" onclick="toggleTheme()"
                  title="${t('切换主题')}" aria-label="${t('切换主题')}">
            ${renderHugeIcon(THEME === 'dark' ? 'sun' : 'moon', 18)}
          </button>
          <a class="icon-btn" href="${REPO_URL}" target="_blank" rel="noopener"
             title="${t('GitHub 仓库')}" aria-label="GitHub">
            ${renderHugeIcon('github', 18)}
          </a>
          <button class="btn notranslate" id="langBtn" onclick="toggleLang()" style="padding:5px 10px;font-size:12px" title="${t('切换语言 / Switch language')}">${getLangLabel()}</button>
          <span class="dot" id="healthDot"></span>
          <span class="muted" id="healthText">${t('运行中')}</span>
        </div>
      </div>
      <main id="main"></main>
    </div>
  `;
  switchPage(currentPage || 'dashboard', true);
  loadSideStat();
  checkUpdate(false);
  updateLangBtn();
}

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
      ['模型', root ? root.models.length + (LANG === 'es' ? ' modelos' : (LANG === 'en' ? ' models' : ' 个')) : '—'],
      ['Cookie', ck && ck.items && ck.items.length ? ck.items.length + (LANG === 'es' ? ' cuentas' : (LANG === 'en' ? ' accounts' : ' 个')) : t('匿名')],
      ['IP slot', usage ? (usage.items || []).length + (LANG === 'es' ? ' slots' : (LANG === 'en' ? ' slots' : ' 个')) : '—'],
    ].map(([k, v]) => `<div class="sf-row"><span>${t(k)}</span><b>${v}</b></div>`).join('');
  } catch (e) { box.innerHTML = ''; }
}

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div style="position:fixed;top:16px;right:20px;display:flex;gap:8px;align-items:center;">
      <button class="icon-btn" id="themeBtn" onclick="toggleTheme()"
              title="${t('切换主题')}" aria-label="${t('切换主题')}">
        ${renderHugeIcon(THEME === 'dark' ? 'sun' : 'moon', 18)}
      </button>
      <button class="btn notranslate" id="langBtn" onclick="toggleLang()" style="padding:5px 10px;font-size:12px" title="${t('切换语言 / Switch language')}">${getLangLabel()}</button>
    </div>
    <div class="login-box">
      <h1><span class="spark" style="width:20px;height:20px;background:var(--g-sweep);
        border-radius:4px;display:inline-block;
        clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)"></span>
        gemini-web2api</h1>
      <input id="tokenInput" type="password" placeholder="${t('管理员 Token')}" />
      <button class="btn" onclick="doLogin()">${t('登录')}</button>
      <div id="loginErr" class="err"></div>
    </div>`;
  if (LANG !== 'zh') translateTree(document.getElementById('app'), LANG);
  updateLangBtn();
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
  if (r.ok) {
    renderShell();
    updateLangBtn();
  }
  else document.getElementById('loginErr').textContent = t('Token 错误');
}

// ── 检查更新 ─────────────────────────────────────────────────────────────
const REPO = 'ElJoker63/gemini-web2api-go';
const REPO_URL = 'https://github.com/' + REPO;
const UPD_TTL_MS = 6 * 3600 * 1000;
let CURRENT_VERSION = '';
let UPD_ERR = '';
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

function verCmp(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

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
      if (UPD_ERR) flash(t('检查失败，浏览器连不上 GitHub'));
      else flash(verCmp(c.tag, CURRENT_VERSION) > 0 ? t('发现新版本') : t('已是最新版本'));
    }
  }
  renderUpdate();
}

function renderUpdate() {
  const c = updCacheRead();
  const hasNew = !!(c && c.tag && CURRENT_VERSION && verCmp(c.tag, CURRENT_VERSION) > 0);
  const pill = document.getElementById('updPill');
  if (pill) {
    pill.style.display = hasNew ? '' : 'none';
    const pillVer = document.getElementById('updPillVer');
    if (pillVer) pillVer.textContent = hasNew ? ' v' + c.tag : '';
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
      <h3><span>${t('发现新版本')}</span> v${escapeHtml(c.tag)}</h3>
      <div class="muted" style="font-size:12px;">${c.published ? new Date(c.published).toLocaleDateString() : ''}</div>
      <details class="note" open style="margin-top:8px;">
        <summary>${t('更新内容')}</summary>
        <div class="pre upd-notes">${escapeHtml(c.body)}</div>
      </details>
      <div class="label">${t('Docker 部署')}</div>
      <div class="row cmd-row">
        <code>${escapeHtml(dockerCmd)}</code>
        <button class="btn muted" onclick="copyText(${escapeHtml(JSON.stringify(dockerCmd))})">${t('复制')}</button>
      </div>
      <div class="label">${t('二进制部署')}</div>
      <p class="hint" style="margin-bottom:6px;">${t('下载对应平台的文件，替换旧的二进制后重启即可；数据在 data/ 目录，不受影响。')}</p>
      <ul class="asset-list">
        ${bins.map(a => `<li><a class="link" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a></li>`).join('')}
        ${sums ? `<li><a class="link" href="${escapeHtml(sums.url)}" target="_blank" rel="noopener">${escapeHtml(sums.name)}</a> <span class="muted">· <span>${t('校验和')}</span></span></li>` : ''}
      </ul>
      <div style="margin-top:14px; display:flex; gap:10px; align-items:center;">
        <button id="btnAutoUpdate" class="btn primary" onclick="triggerAutoUpdate()">${t('一键更新二进制')}</button>
        <a class="btn" href="${escapeHtml(c.url || REPO_URL + '/releases')}" target="_blank" rel="noopener">${t('在 GitHub 查看')}</a>
      </div>
      <div id="updStatusMsg" style="margin-top:10px;"></div>
    </div>`;
  if (LANG !== 'zh') translateTree(box, LANG);
}

async function triggerAutoUpdate() {
  const btn = document.getElementById('btnAutoUpdate');
  const msg = document.getElementById('updStatusMsg');
  if (btn) btn.disabled = true;
  if (msg) msg.innerHTML = '<span class="muted">' + t('正在下载并替换二进制，请稍候…') + '</span>';
  try {
    const res = await api('/admin/api/update', { method: 'POST' });
    if (res && res.status === 'ok') {
      if (msg) msg.innerHTML = '<span class="badge ok">' + escapeHtml(t(res.message)) + '</span>';
      flash(t('更新成功！请重启服务。'));
    } else {
      throw new Error((res && res.error) || 'Update failed');
    }
  } catch (err) {
    if (msg) msg.innerHTML = '<span class="err">' + t('更新失败：') + escapeHtml(t(err.message || String(err))) + '</span>';
    flash(t('更新失败'));
    if (btn) btn.disabled = false;
  }
}

// ── Playground Engine ────────────────────────────────────────────────────────
const PG_TOOL_PRESETS = {
  none: null,
  weather: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Obtener el clima actual y pronóstico para una ubicación",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "Nombre de la ciudad, ej. Madrid, Tokio, Buenos Aires" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Unidad métrica o imperial" }
          },
          required: ["location"]
        }
      }
    }
  ],
  web_search: [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Buscar información reciente en la web",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Término de búsqueda" }
          },
          required: ["query"]
        }
      }
    }
  ],
  calc: [
    {
      type: "function",
      function: {
        name: "calculate",
        description: "Calcular una expresión matemática aritmética o científica",
        parameters: {
          type: "object",
          properties: {
            expression: { type: "string", description: "Expresión matemática, ej: 144 / 12 * 5" }
          },
          required: ["expression"]
        }
      }
    }
  ]
};

let pgState = {
  messages: [],
  abortCtrl: null,
  busy: false,
};

function pgFormatMarkdown(text) {
  if (!text) return '';
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  const parts = s.split(/(<pre[\s\S]*?<\/pre>)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\n/g, '<br>');
  }
  return parts.join('');
}

function pgRenderToolCalls(container, toolCalls) {
  if (!container || !toolCalls || !toolCalls.length) return;
  container.innerHTML = toolCalls.map(tc => `
    <div class="pg-tool-call">
      <div style="font-weight:600;color:var(--g-blue);margin-bottom:2px">🔧 ${t('Tool Call')}: <code>${escapeHtml(tc.name || 'anonymous')}</code></div>
      <div style="font-size:11.5px;color:var(--text);white-space:pre-wrap;font-family:var(--mono)">${escapeHtml(tc.arguments || '')}</div>
    </div>
  `).join('');
}

async function initPlayground() {
  const sel = document.getElementById('pgModelSel');
  if (!sel) return;

  let models = [];
  try {
    const root = await fetch('../', { credentials: 'include' }).then(r => r.json()).catch(() => null);
    if (root && root.models && root.models.length) {
      models = root.models;
    }
  } catch (e) {}

  if (!models.length) {
    models = [
      'gemini-3.6-flash', 'gemini-4-argon', 'gemini-3.7-flash-thinking', 'gemini-3.7-flash',
      'gemini-4-carbon', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite-thinking',
      'gemini-3.8-flash', 'gemini-4-argon-thinking-medium', 'gemini-4-hydrogen',
      'gemini-3.6-flash-thinking', 'gemini-3.8-flash-thinking', 'gemini-4-hydrogen-thinking',
      'gemini-canvas', 'gemini-image', 'gemini-music', 'gemini-video'
    ];
  }

  const flash = [];
  const thinking = [];
  const nextgen = [];
  const media = [];
  const others = [];

  for (const m of models) {
    if (m.includes('thinking')) thinking.push(m);
    else if (m.includes('flash') || m.includes('lite')) flash.push(m);
    else if (m.includes('argon') || m.includes('carbon') || m.includes('hydrogen')) nextgen.push(m);
    else if (m.includes('image') || m.includes('music') || m.includes('video') || m.includes('canvas')) media.push(m);
    else others.push(m);
  }

  const makeOptGroup = (label, list) => {
    if (!list.length) return '';
    return `<optgroup label="${label}">${list.map(m => `<option value="${m}">${m}</option>`).join('')}</optgroup>`;
  };

  sel.innerHTML = [
    makeOptGroup(t('⚡ Flash (Rápidos)'), flash),
    makeOptGroup(t('🧠 Thinking (Razonamiento profundo)'), thinking),
    makeOptGroup(t('🚀 Next-Gen (Argon / Carbon / Hydrogen)'), nextgen),
    makeOptGroup(t('🎨 Multimedia & Canvas'), media),
    makeOptGroup(t('Modelos adicionales'), others),
  ].join('');

  if (flash.includes('gemini-3.6-flash')) sel.value = 'gemini-3.6-flash';
  else if (models.length) sel.value = models[0];

  pgOnModelChange();
  pgRenderMessages();
}

function pgRenderMessages() {
  const box = document.getElementById('pgMessages');
  if (!box) return;
  if (!pgState.messages.length) return;
  const welcome = document.getElementById('pgWelcome');
  if (welcome) welcome.style.display = 'none';

  box.innerHTML = pgState.messages.map(m => {
    if (m.role === 'user') {
      return `
        <div class="pg-msg user">
          <div class="pg-bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
        </div>
      `;
    } else {
      const thoughtHTML = m.reasoning ? `
        <details class="pg-thought">
          <summary>${renderHugeIcon('star', 12)} ${t('Razonamiento (Thinking)')}</summary>
          <div class="pg-thought-content">${escapeHtml(m.reasoning)}</div>
        </details>
      ` : '';
      const toolsHTML = (m.tool_calls && m.tool_calls.length) ? m.tool_calls.map(tc => `
        <div class="pg-tool-call">
          <div style="font-weight:600;color:var(--g-blue);margin-bottom:2px">🔧 ${t('Tool Call')}: <code>${escapeHtml(tc.name || 'anonymous')}</code></div>
          <div style="font-size:11.5px;color:var(--text);white-space:pre-wrap;font-family:var(--mono)">${escapeHtml(tc.arguments || '')}</div>
        </div>
      `).join('') : '';

      return `
        <div class="pg-msg assistant">
          <div class="pg-bubble">
            ${thoughtHTML}
            ${toolsHTML}
            <div>${pgFormatMarkdown(m.content || (toolsHTML ? '' : '(Sin texto)'))}</div>
          </div>
          <div class="pg-msg-meta">
            <span>${escapeHtml(m.model || '')}</span> · <span>${m.latency || ''}s</span>
          </div>
        </div>
      `;
    }
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function pgToggleSysPrompt() {
  const w = document.getElementById('pgSysWrap');
  if (!w) return;
  w.style.display = w.style.display === 'none' ? 'block' : 'none';
  if (w.style.display === 'block') {
    document.getElementById('pgSysPrompt').focus();
  }
}

function pgClearChat() {
  if (pgState.busy) pgStopGeneration();
  pgState.messages = [];
  const box = document.getElementById('pgMessages');
  if (box) {
    box.innerHTML = `
      <div class="pg-welcome" id="pgWelcome">
        <div style="width:48px;height:48px;background:var(--g-sweep);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;clip-path:polygon(50% 0,61% 39%,100% 50%,61% 61%,50% 100%,39% 61%,0 50%,39% 39%)"></div>
        <h3 style="font-size:16px;font-weight:500;margin-bottom:6px">${t('Gemini Web2API Playground')}</h3>
        <p style="font-size:13px;color:var(--muted);max-width:440px;margin-bottom:16px;line-height:1.5">${t('Prueba y experimenta directamente con todos los modelos de Gemini, razonamiento (thinking), llamadas a herramientas y streaming.')}</p>
        <div class="pg-suggestions">
          <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('¿Cuáles son las principales diferencias entre Gemini 1.5, 2.0 y 2.5 Flash?')}')">💡 ${t('Diferencias entre modelos Gemini')}</button>
          <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('Escribe un script en Python con concurrencia para verificar el estado de una lista de URLs.')}')">🐍 ${t('Script Python concurrente')}</button>
          <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('¿Cuál es el clima actual en Tokio y qué ropa me recomiendas llevar? Usa la herramienta.')}')">🌦️ ${t('Prueba de herramientas (Tools)')}</button>
          <button class="pg-sug-btn" onclick="pgUseSuggestion('${t('Si tengo 3 manzanas y me como 2, luego compro 5 y le regalo 1 a un amigo, ¿cuántas manzanas tengo? Explica paso a paso.')}')">🧠 ${t('Razonamiento paso a paso')}</button>
        </div>
      </div>
    `;
  }
  const tokInfo = document.getElementById('pgTokensInfo');
  if (tokInfo) tokInfo.textContent = '';
  const st = document.getElementById('pgStatus');
  if (st) st.textContent = t('Listo para interactuar');
}

function pgUseSuggestion(text) {
  const inp = document.getElementById('pgInput');
  if (inp) {
    inp.value = text;
    pgAutoResize(inp);
    pgSendMessage();
  }
}

function pgAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function pgInputKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    pgSendMessage();
  }
}

function pgOnModelChange() {
  const m = document.getElementById('pgModelSel')?.value || '';
  const badge = document.getElementById('pgCurModelBadge');
  if (badge) badge.textContent = m;
}

function pgOnToolPresetChange() {
  const v = document.getElementById('pgToolPreset')?.value;
  const wrap = document.getElementById('pgCustomToolsWrap');
  if (wrap) wrap.style.display = v === 'custom' ? 'block' : 'none';
}

function pgResetSettings() {
  const temp = document.getElementById('pgTemp');
  if (temp) { temp.value = 0.7; document.getElementById('pgTempVal').textContent = '0.7'; }
  const streamSw = document.getElementById('pgStreamSwitch');
  if (streamSw) streamSw.checked = true;
  const mtSw = document.getElementById('pgMultiTurnSwitch');
  if (mtSw) mtSw.checked = true;
  const tp = document.getElementById('pgToolPreset');
  if (tp) { tp.value = 'none'; pgOnToolPresetChange(); }
  const key = document.getElementById('pgApiKey');
  if (key) key.value = '';
}

function pgStopGeneration() {
  if (pgState.abortCtrl) {
    pgState.abortCtrl.abort();
    pgState.abortCtrl = null;
  }
  pgSetBusy(false);
  const st = document.getElementById('pgStatus');
  if (st) st.textContent = t('Detenido por el usuario');
}

function pgSetBusy(b) {
  pgState.busy = b;
  const sendBtn = document.getElementById('pgSendBtn');
  const stopBtn = document.getElementById('pgStopBtn');
  if (sendBtn) sendBtn.style.display = b ? 'none' : 'inline-flex';
  if (stopBtn) stopBtn.style.display = b ? 'inline-flex' : 'none';
  const inp = document.getElementById('pgInput');
  if (inp && !b) inp.focus();
}

async function pgSendMessage() {
  if (pgState.busy) return;
  const inputEl = document.getElementById('pgInput');
  const userText = (inputEl.value || '').trim();
  if (!userText) return;

  inputEl.value = '';
  pgAutoResize(inputEl);

  const welcome = document.getElementById('pgWelcome');
  if (welcome) welcome.style.display = 'none';

  pgState.messages.push({ role: 'user', content: userText });

  const msgBox = document.getElementById('pgMessages');
  const userDiv = document.createElement('div');
  userDiv.className = 'pg-msg user';
  userDiv.innerHTML = `<div class="pg-bubble">${escapeHtml(userText).replace(/\n/g, '<br>')}</div>`;
  msgBox.appendChild(userDiv);

  const model = document.getElementById('pgModelSel')?.value || 'gemini-3.6-flash';
  const asstDiv = document.createElement('div');
  asstDiv.className = 'pg-msg assistant';
  asstDiv.innerHTML = `
    <div class="pg-bubble">
      <details class="pg-thought" style="display:none" open>
        <summary>${renderHugeIcon('star', 12)} ${t('Razonamiento (Thinking)')}</summary>
        <div class="pg-thought-content"></div>
      </details>
      <div class="pg-tools-holder"></div>
      <div class="pg-text-holder"><span class="pg-cursor"></span></div>
    </div>
    <div class="pg-msg-meta">
      <span>${escapeHtml(model)}</span> · <span class="pg-meta-time">...</span>
    </div>
  `;
  msgBox.appendChild(asstDiv);
  msgBox.scrollTop = msgBox.scrollHeight;

  const thoughtWrap = asstDiv.querySelector('.pg-thought');
  const thoughtText = asstDiv.querySelector('.pg-thought-content');
  const toolsHolder = asstDiv.querySelector('.pg-tools-holder');
  const textHolder = asstDiv.querySelector('.pg-text-holder');
  const metaTime = asstDiv.querySelector('.pg-meta-time');

  const isStream = document.getElementById('pgStreamSwitch')?.checked ?? true;
  const isMultiTurn = document.getElementById('pgMultiTurnSwitch')?.checked ?? true;
  const temp = parseFloat(document.getElementById('pgTemp')?.value || '0.7');
  const sysPrompt = (document.getElementById('pgSysPrompt')?.value || '').trim();
  const customKey = (document.getElementById('pgApiKey')?.value || '').trim();

  let reqMessages = [];
  if (sysPrompt) {
    reqMessages.push({ role: 'system', content: sysPrompt });
  }
  if (isMultiTurn) {
    for (const m of pgState.messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        reqMessages.push({ role: m.role, content: m.content || '' });
      }
    }
  } else {
    reqMessages.push({ role: 'user', content: userText });
  }

  const payload = {
    model: model,
    messages: reqMessages,
    temperature: temp,
    stream: isStream,
  };

  const toolPreset = document.getElementById('pgToolPreset')?.value || 'none';
  if (toolPreset === 'custom') {
    try {
      const customTools = JSON.parse(document.getElementById('pgCustomTools')?.value || '[]');
      if (Array.isArray(customTools) && customTools.length > 0) payload.tools = customTools;
    } catch (e) {
      toast('Error JSON: ' + e.message);
    }
  } else if (PG_TOOL_PRESETS[toolPreset]) {
    payload.tools = PG_TOOL_PRESETS[toolPreset];
  }

  const headers = { 'Content-Type': 'application/json' };
  if (customKey) {
    headers['Authorization'] = 'Bearer ' + customKey;
  }

  pgSetBusy(true);
  const st = document.getElementById('pgStatus');
  if (st) st.textContent = t('Generando respuesta...');
  const startTime = performance.now();
  let fullContent = '';
  let fullReasoning = '';
  let toolCalls = [];

  pgState.abortCtrl = new AbortController();

  try {
    const resp = await fetch('../v1/chat/completions', {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(payload),
      signal: pgState.abortCtrl.signal,
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
      const errMsg = errData.error?.message || errData.error || ('HTTP ' + resp.status);
      throw new Error(errMsg);
    }

    if (isStream) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const raw = trimmed.slice(6);
          if (raw === '[DONE]') break;
          try {
            const parsed = JSON.parse(raw);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              thoughtWrap.style.display = 'block';
              thoughtText.textContent = fullReasoning;
            }
            if (delta.content) {
              fullContent += delta.content;
              textHolder.innerHTML = pgFormatMarkdown(fullContent) + '<span class="pg-cursor"></span>';
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                }
                if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              }
              pgRenderToolCalls(toolsHolder, toolCalls);
            }
          } catch (e) {}
        }
        msgBox.scrollTop = msgBox.scrollHeight;
      }
    } else {
      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if (msg) {
        if (msg.reasoning_content) {
          fullReasoning = msg.reasoning_content;
          thoughtWrap.style.display = 'block';
          thoughtText.textContent = fullReasoning;
        }
        if (msg.content) {
          fullContent = msg.content;
        }
        if (msg.tool_calls) {
          toolCalls = msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || ''
          }));
          pgRenderToolCalls(toolsHolder, toolCalls);
        }
      }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    textHolder.innerHTML = pgFormatMarkdown(fullContent || (toolCalls.length ? '' : '(Sin respuesta de texto)'));
    metaTime.textContent = elapsed + 's';
    if (st) st.textContent = t('Listo para interactuar');

    pgState.messages.push({
      role: 'assistant',
      content: fullContent,
      reasoning: fullReasoning,
      tool_calls: toolCalls,
      model: model,
      latency: elapsed
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      textHolder.innerHTML = pgFormatMarkdown(fullContent) + ' <span style="color:var(--muted);font-style:italic">[' + t('Detenido') + ']</span>';
      if (st) st.textContent = t('Detenido por el usuario');
    } else {
      textHolder.innerHTML = `<span style="color:var(--fail)">❌ ${escapeHtml(err.message)}</span>`;
      if (st) st.textContent = t('Error al generar respuesta');
    }
  } finally {
    pgSetBusy(false);
    pgState.abortCtrl = null;
    msgBox.scrollTop = msgBox.scrollHeight;
  }
}

function pgShowCodeModal() {
  const model = document.getElementById('pgModelSel')?.value || 'gemini-3.6-flash';
  const isStream = document.getElementById('pgStreamSwitch')?.checked ?? true;
  const temp = parseFloat(document.getElementById('pgTemp')?.value || '0.7');
  const sysPrompt = (document.getElementById('pgSysPrompt')?.value || '').trim();
  const customKey = (document.getElementById('pgApiKey')?.value || '').trim() || '<YOUR_API_KEY>';

  let messages = [];
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt });
  if (pgState.messages.length) {
    for (const m of pgState.messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content || '' });
      }
    }
  } else {
    messages.push({ role: 'user', content: 'Hello, how can you help me?' });
  }

  const payload = {
    model: model,
    messages: messages,
    temperature: temp,
    stream: isStream,
  };

  const toolPreset = document.getElementById('pgToolPreset')?.value || 'none';
  if (toolPreset !== 'none' && PG_TOOL_PRESETS[toolPreset]) {
    payload.tools = PG_TOOL_PRESETS[toolPreset];
  }

  const jsonStr = JSON.stringify(payload, null, 2);
  const curlCmd = `curl -X POST http://localhost:8844/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${customKey}" \\\n  -d '${jsonStr.replace(/'/g, "'\\''")}'`;

  const pyCode = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="http://localhost:8844/v1",\n    api_key="${customKey}",\n)\n\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=${JSON.stringify(messages, null, 4)},\n    temperature=${temp},\n    stream=${isStream ? 'True' : 'False'},\n)\n\n${isStream ? "for chunk in response:\n    if chunk.choices and chunk.choices[0].delta.content:\n        print(chunk.choices[0].delta.content, end='', flush=True)" : "print(response.choices[0].message.content)"}\n`;

  const modalHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;border-bottom:1px solid var(--outline-soft);padding-bottom:8px">
      <button class="btn notranslate" style="padding:4px 12px;font-size:12px" onclick="document.getElementById('pgCurlBox').style.display='block';document.getElementById('pgPyBox').style.display='none';">cURL</button>
      <button class="btn notranslate" style="padding:4px 12px;font-size:12px;background:var(--surface-hi);color:var(--text)" onclick="document.getElementById('pgCurlBox').style.display='none';document.getElementById('pgPyBox').style.display='block';">Python (OpenAI SDK)</button>
    </div>
    <div id="pgCurlBox">
      <textarea readonly rows="12" style="font-family:var(--mono);font-size:11.5px;width:100%">${escapeHtml(curlCmd)}</textarea>
    </div>
    <div id="pgPyBox" style="display:none">
      <textarea readonly rows="12" style="font-family:var(--mono);font-size:11.5px;width:100%">${escapeHtml(pyCode)}</textarea>
    </div>
  `;

  buildModal({
    title: t('Código de ejemplo / API Code'),
    desc: t('Ejecuta la misma petición en terminal o integración con OpenAI SDK:'),
    bodyHTML: modalHTML,
    submitText: t('Copiar cURL'),
    onSubmit: () => {
      navigator.clipboard.writeText(curlCmd);
      toast(t('Código copiado al portapapeles'));
      return true;
    }
  });
}

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
  [/^本地 RPH 限额\s*(\d+)$/, (m, p1) => (LANG === 'es' ? 'Límite local RPH ' : 'Local RPH limit ') + p1],
  [/^连续失败\s*(\d+)\s*次，熔断冷却中$/, (m, p1) => (LANG === 'es' ? `Falló ${p1} veces consecutivas, enfriamiento activo` : `Failed ${p1} consecutive times, circuit breaker cooling`)],
  [/^冷却\s*(\d+)s$/, (m, p1) => (LANG === 'es' ? `Enfriamiento ${p1}s` : `Cooldown ${p1}s`)],
  [/^代理\s*#(\d+)$/, (m, p1) => (LANG === 'es' ? 'Proxy #' : 'Proxy #') + p1],
  [/^Cookie\s*已导入\s*#(\d+)$/, (m, p1) => (LANG === 'es' ? `Cookie #${p1} importada` : `Cookie #${p1} imported`)],
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

function translateTree(root, lang = LANG) {
  if (!root) return;
  if (typeof lang === 'boolean') lang = LANG;
  const isTranslated = lang === 'en' || lang === 'es';
  const dict = I18N_DATA[lang] || {};
  const norm = s => String(s).trim().replace(/\s+/g, ' ');

  // 1. Text nodes
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (n.parentElement && (n.parentElement.closest('#langBtn') || n.parentElement.closest('.notranslate'))) continue;
    const raw = n.nodeValue;
    let orig = ZH_ORIG.get(n);
    if (!orig) {
      orig = raw;
      ZH_ORIG.set(n, orig);
    }
    const key = norm(orig);
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
        const leading = orig.match(/^\s*/)[0];
        const trailing = orig.match(/\s*$/)[0];
        n.nodeValue = leading + tr + trailing;
      }
    } else {
      n.nodeValue = orig;
    }
  }

  // 2. Element attributes
  const scope = root.querySelectorAll ? root.querySelectorAll('[title],[placeholder],[aria-label]') : [];
  scope.forEach(el => {
    I18N_ATTRS.forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const dz = 'data-zh-' + attr;
      let orig = el.getAttribute(dz);
      if (!orig) {
        orig = el.getAttribute(attr);
        el.setAttribute(dz, orig);
      }
      if (isTranslated) {
        const val = norm(orig);
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
        if (tr) el.setAttribute(attr, tr);
      } else {
        el.setAttribute(attr, orig);
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

function getLangLabel(l = LANG) {
  return l === 'es' ? 'ES' : (l === 'en' ? 'EN' : '中文');
}

function updateLangBtn() {
  const b = document.getElementById('langBtn');
  if (b) {
    b.textContent = getLangLabel();
    const titleText = t('切换语言 / Switch language');
    b.title = titleText;
    b.setAttribute('title', titleText);
  }
  document.documentElement.lang = LANG === 'es' ? 'es' : (LANG === 'en' ? 'en' : 'zh-CN');
  document.title = LANG === 'es'
    ? 'gemini-web2api Panel de Administración'
    : (LANG === 'en' ? 'gemini-web2api Admin Panel' : 'gemini-web2api 管理面板');
}

async function toggleLang() {
  LANG = LANG === 'zh' ? 'en' : (LANG === 'en' ? 'es' : 'zh');
  try { localStorage.setItem('lang', LANG); } catch (e) {}
  await loadLocale(LANG);
  if (document.querySelector('.login-box')) {
    renderLogin();
  } else {
    renderShell();
  }
  updateLangBtn();
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
