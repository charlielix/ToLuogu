// ==UserScript==
// @name         ToLG - 洛谷原题查找
// @namespace    https://github.com/charlielix/ToLuogu
// @version      10.8
// @author       charlielix
// @license      MIT
// @homepageURL  https://github.com/charlielix/ToLuogu
// @supportURL   https://github.com/charlielix/ToLuogu/issues
// @downloadURL  https://raw.githubusercontent.com/charlielix/ToLuogu/main/main.js
// @updateURL    https://raw.githubusercontent.com/charlielix/ToLuogu/main/main.js
// @description  提取题面后按优先级依次尝试：①标题搜索 + 模型从候选挑选 ②完整题面交给模型给题号 ③洛谷题面全文搜索（content=true）。模型/地址/Key 可在脚本菜单里自定义。英行OJ 另有专注模式：隐藏侧栏，递交/在线编程移到标签栏，并可一键复制题面 Markdown
// @match        *://www.xinyoudui.com/ac/contest/*/problem/*
// @match        *://ac.xinyoudui.com/*
// @match        *://yingxing.club/*
// @match        *://*.yingxing.club/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      *
// @connect      www.luogu.com.cn
// @connect      api.deepseek.com
// @connect      fecdn.luogu.com.cn
// ==/UserScript==

(function() {
    'use strict';

    console.log('[OJ→洛谷] 脚本启动 v10.8');

    // ========== 设置：模型 / API 配置 ==========
    const DEFAULT_MODEL = 'deepseek-chat';
    const DEFAULT_BASE_URL = 'https://api.deepseek.com';
    const FOCUS_MODE_KEY = 'oj_focus_mode';   // OJ 专注模式开关（持久化）
    const FOCUS_ANIM_MS = 280;                // 专注模式进出动效时长

    // ========== 通用工具 ==========
    // 批量设置内联样式（统一 important，覆盖站点样式）
    function applyStyles(el, styles) {
        Object.keys(styles).forEach(key => el.style.setProperty(key, styles[key], 'important'));
    }

    function escapeHtml(value) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(value == null ? '' : value).replace(/[&<>"']/g, ch => map[ch]);
    }


    function getConfig() {
        return {
            // 兼容老版本存在 deepseek_api_key 里的 key
            apiKey: GM_getValue('llm_api_key', '') || GM_getValue('deepseek_api_key', ''),
            format: GM_getValue('llm_format', 'openai'),          // openai | anthropic
            baseUrl: GM_getValue('llm_base_url', DEFAULT_BASE_URL),
            fullUrl: GM_getValue('llm_full_url', false),
            model: GM_getValue('llm_model', DEFAULT_MODEL)
        };
    }

    function saveConfig(cfg) {
        GM_setValue('llm_api_key', (cfg.apiKey || '').trim());
        GM_setValue('llm_format', cfg.format === 'anthropic' ? 'anthropic' : 'openai');
        GM_setValue('llm_base_url', (cfg.baseUrl || '').trim());
        GM_setValue('llm_full_url', !!cfg.fullUrl);
        GM_setValue('llm_model', (cfg.model || '').trim());
        GM_setValue('deepseek_api_key', '');   // 老配置清掉，避免两份 key
    }

    function getApiKey() {
        return getConfig().apiKey;
    }

    // 按当前配置拼出请求地址 / 请求头 / 请求体
    function buildLLMRequest(prompt, opts = {}) {
        const cfg = getConfig();
        const isAnthropic = cfg.format === 'anthropic';
        const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.1;
        const maxTokens = opts.maxTokens || 200;

        let url = cfg.baseUrl || DEFAULT_BASE_URL;
        if (!cfg.fullUrl) {
            // 不勾"完整 URL"时，按格式补上路径
            url = url.replace(/\/+$/, '') + (isAnthropic ? '/v1/messages' : '/chat/completions');
        }

        const headers = { "Content-Type": "application/json" };
        let body;

        if (isAnthropic) {
            headers["x-api-key"] = cfg.apiKey;
            headers["anthropic-version"] = "2023-06-01";
            headers["anthropic-dangerous-direct-browser-access"] = "true";
            body = {
                model: cfg.model,
                max_tokens: maxTokens,
                temperature,
                messages: [{ role: "user", content: prompt }]
            };
        } else {
            headers["Authorization"] = "Bearer " + cfg.apiKey;
            body = {
                model: cfg.model,
                messages: [{ role: "user", content: prompt }],
                temperature,
                max_tokens: maxTokens
            };
        }

        return { url, headers, data: JSON.stringify(body), isAnthropic };
    }

    // 从两种格式的返回里取出模型输出的纯文本
    function readLLMAnswer(result, isAnthropic) {
        if (result && result.error) {
            throw new Error(result.error.message || JSON.stringify(result.error));
        }
        if (isAnthropic) {
            const blocks = (result && result.content) || [];
            const textBlock = blocks.find(b => b.type === 'text') || blocks[0];
            return ((textBlock && textBlock.text) || '').trim();
        }
        const choice = result && result.choices && result.choices[0];
        return ((choice && choice.message && choice.message.content) || '').trim();
    }

    // 统一发一次对话请求，resolve 出模型输出的纯文本
    function callLLM(prompt, opts) {
        return new Promise((resolve, reject) => {
            if (!getApiKey()) { reject(new Error('NO_API_KEY')); return; }
            const req = buildLLMRequest(prompt, opts);

            GM_xmlhttpRequest({
                method: "POST",
                url: req.url,
                headers: req.headers,
                data: req.data,
                onload: function(response) {
                    let result;
                    try {
                        result = JSON.parse(response.responseText);
                    } catch (e) {
                        reject(new Error(`解析模型响应失败: ${e.message}`));
                        return;
                    }
                    console.log('[OJ→洛谷] 模型原始返回:', result);
                    try {
                        resolve(readLLMAnswer(result, req.isAnthropic));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: function(err) {
                    reject(new Error(`模型请求失败: ${err.statusText || '网络错误'}`));
                }
            });
        });
    }

    // ========== 设置面板（模型 / 地址 / Key） ==========
    function openSettingsDialog() {
        const cfg = getConfig();
        const old = document.getElementById('xyd-llm-settings-panel');
        if (old) old.remove();

        const fieldStyle = 'width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d9d9d9;border-radius:6px;font-size:13px;background:#fff;color:#333;';
        const labelStyle = 'display:block;font-size:12px;color:#666;margin:10px 0 3px;';

        const box = document.createElement('div');
        box.id = 'xyd-llm-settings-panel';
        box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999999;width:430px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;color:#333;overflow:hidden;';
        box.innerHTML = `
            <div style="padding:14px 18px;background:linear-gradient(135deg,#4a90e2,#357abd);color:#fff;font-weight:bold;">模型与 API 设置</div>
            <div style="padding:4px 18px 12px;">
                <label style="${labelStyle}">API 格式</label>
                <select id="xyd-cfg-format" style="${fieldStyle}">
                    <option value="openai">OpenAI Chat Completions 格式</option>
                    <option value="anthropic">Anthropic Messages 格式</option>
                </select>

                <label style="${labelStyle}">请求地址</label>
                <input id="xyd-cfg-url" style="${fieldStyle}" placeholder="${DEFAULT_BASE_URL}">
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:6px;">
                    <input type="checkbox" id="xyd-cfg-full"> 完整 URL（不再自动拼接 /chat/completions）
                </label>

                <label style="${labelStyle}">模型 ID</label>
                <input id="xyd-cfg-model" style="${fieldStyle}" placeholder="如 deepseek-chat / gpt-4o-mini">

                <label style="${labelStyle}">API Key</label>
                <input id="xyd-cfg-key" type="password" style="${fieldStyle}" placeholder="sk-...">
            </div>
            <div style="padding:0 18px 16px;display:flex;justify-content:flex-end;gap:8px;">
                <button id="xyd-cfg-cancel" style="padding:7px 16px;border:1px solid #d9d9d9;background:#fff;color:#333;border-radius:6px;cursor:pointer;">取消</button>
                <button id="xyd-cfg-save" style="padding:7px 16px;border:none;background:#4a90e2;color:#fff;border-radius:6px;cursor:pointer;font-weight:bold;">保存</button>
            </div>
        `;
        document.body.appendChild(box);

        box.querySelector('#xyd-cfg-format').value = cfg.format;
        box.querySelector('#xyd-cfg-url').value = cfg.baseUrl;
        box.querySelector('#xyd-cfg-full').checked = !!cfg.fullUrl;
        box.querySelector('#xyd-cfg-model').value = cfg.model;
        box.querySelector('#xyd-cfg-key').value = cfg.apiKey;

        const close = () => box.remove();
        box.querySelector('#xyd-cfg-cancel').addEventListener('click', close);
        box.querySelector('#xyd-cfg-save').addEventListener('click', () => {
            saveConfig({
                apiKey: box.querySelector('#xyd-cfg-key').value,
                format: box.querySelector('#xyd-cfg-format').value,
                baseUrl: box.querySelector('#xyd-cfg-url').value,
                fullUrl: box.querySelector('#xyd-cfg-full').checked,
                model: box.querySelector('#xyd-cfg-model').value
            });
            close();
            alert('已保存');
        });
    }

    GM_registerMenuCommand('⚙️ 模型与 API 设置', openSettingsDialog);

    // ========== 全局状态 ==========
    let currentProblemTitle = '';
    let mainRunning = false;

    // ========== 等待元素 ==========
    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { observer.disconnect(); resolve(el); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); reject(new Error('等待超时')); }, timeout);
        });
    }

    // ========== 站点识别 ==========
    // 信友队（xinyoudui.com）与英行OJ（信星社 / Hydro，yingxing.club）的 DOM 完全不同
    const SITE = /(^|\.)yingxing\.club$/i.test(location.hostname) ? 'xinxingshe' : 'xinyoudui';

    function getTitleSelector() {
        return SITE === 'xinxingshe'
            ? '.problem-content .section__title'   // 英行OJ：题面区里的标题（不带 A./B. 序号）
            : 'h4.ac-ant-typography';              // OJ：信友队
    }

    function getTitleEl() {
        return document.querySelector(getTitleSelector());
    }

    function cleanTitle(raw) {
        return (raw || '').replace(/^\d+\.\s*/, '').replace(/^[A-Za-z]\.\s*/, '').trim();
    }

    // DOM 节点 -> 纯文本（保留段落换行）
    function domToText(descEl) {
        if (!descEl) return '';
        const clone = descEl.cloneNode(true);
        clone.querySelectorAll('button, .html2md-panel, .ac-ant-typography-copy, .toolbar, script, style').forEach(el => el.remove());
        clone.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
        clone.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, pre').forEach(el => {
            el.insertAdjacentText('beforebegin', '\n');
            el.insertAdjacentText('afterend', '\n');
        });
        return clone.innerText || clone.textContent || '';
    }

    // 去掉 markdown 语法噪声
    function markdownToText(md) {
        return (md || '')
            .replace(/```[a-zA-Z0-9_]*/g, '')
            .replace(/^#{1,6}\s*/gm, '')
            .replace(/\*\*/g, '');
    }

    // 只做换行/空白规整，不截断——题面要原样喂给 DeepSeek
    function normalizeStatement(text) {
        return (text || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t\u3000]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ========== 提取题面：信友队 ==========
    function extractOJInfo() {
        const titleEl = document.querySelector('h4.ac-ant-typography');
        const title = cleanTitle(titleEl ? titleEl.innerText : '');

        let fullText = domToText(document.querySelector('._description_tixlz_51'));
        if (!fullText.trim()) fullText = document.body.innerText || '';

        return { title, statement: normalizeStatement(fullText) };
    }

    // ========== 提取题面：英行OJ（信星社 / Hydro） ==========
    function readXinxingsheContext() {
        const raw = window.UiContextNew
            || (window.XinXingSheHydroBootstrap && window.XinXingSheHydroBootstrap.UiContextNew);
        if (!raw) return null;
        if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch (e) { return null; }
        }
        return raw;
    }

    // 页面数据里的题目对象（标题、markdown 原文、配置都在这里）
    function readPdoc() {
        const ctx = readXinxingsheContext();
        return (ctx && ctx.pdoc) || null;
    }

    function extractXinxingsheInfo() {
        const pdoc = readPdoc();

        // 标题：优先取页面数据里的 title，其次取题面区的标题
        let title = (pdoc && pdoc.title) || '';
        if (!title) {
            const el = getTitleEl();
            title = el ? el.innerText : '';
        }

        // 题面：优先取页面数据里的 markdown 原文（最完整），其次退回 DOM
        let statement = '';
        if (pdoc && typeof pdoc.content === 'string') {
            statement = markdownToText(pdoc.content);
        }
        if (!statement.trim()) {
            statement = domToText(document.querySelector('.problem-content .section__body.typo'));
        }
        if (!statement.trim()) {
            statement = document.body.innerText || '';
        }

        return {
            title: cleanTitle(title),
            statement: normalizeStatement(statement)
        };
    }

    function extractProblemInfo() {
        return SITE === 'xinxingshe' ? extractXinxingsheInfo() : extractOJInfo();
    }

    // ========== 洛谷网页搜索接口 ==========
    const LUOGU_PROBLEM_URL = 'https://www.luogu.com.cn/problem';

    // 洛谷接口通用请求头
    const LUOGU_HEADERS = {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.luogu.com.cn/problem/list",
        "x-lentille-request": "content-only",
        "x-requested-with": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
    };

    // opts.content = true 时附带 content=true，让洛谷在题面正文里一起搜（题面全文检索）
    function searchProblems(keyword, opts = {}) {
        const useContent = !!opts.content;
        return new Promise((resolve) => {
            const url = `https://www.luogu.com.cn/problem/list?type=all&keyword=${encodeURIComponent(keyword)}`
                + `${useContent ? '&content=true' : ''}&page=1`;

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: LUOGU_HEADERS,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        const items = data?.data?.problems?.result || [];

                        const problems = items.map(item => ({
                            id: item.pid,
                            title: item.name,
                            difficulty: item.difficulty,
                            sourceUrl: `${LUOGU_PROBLEM_URL}/${item.pid}`
                        }));
                        console.log(`[OJ→洛谷] 洛谷网页搜索（keyword="${keyword}"${useContent ? ', 含题面正文' : ''}）到 ${problems.length} 条，前 3 条:`,
                            problems.slice(0, 3).map(p => `${p.id} ${p.title}`));
                        resolve(problems);
                    } catch (e) {
                        console.error('[OJ→洛谷] 洛谷网页搜索解析失败:', e);
                        console.log('[OJ→洛谷] 原始返回前 500 字:', response.responseText.substring(0, 500));
                        resolve([]);
                    }
                },
                onerror: function(err) {
                    console.error('[OJ→洛谷] 洛谷网页搜索请求失败:', err);
                    resolve([]);
                }
            });
        });
    }

    // ========== 本地相似度匹配（无 API Key 时使用） ==========

    // 归一化：转小写、去标点、压缩空白
    function normalize(str) {
        return (str || '')
            .toLowerCase()
            .replace(/[\s\u3000]+/g, '')
            .replace(/[，。！？；：、“”‘’（）【】《》,.!?;:'"()\[\]<>]/g, '')
            .trim();
    }

    // 取字符 bigram 集合（中文、英文通吃，比按空格分词更稳）
    function bigrams(str) {
        const s = normalize(str);
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) {
            set.add(s.slice(i, i + 2));
        }
        if (s.length === 1) set.add(s);
        return set;
    }

    // Dice 系数：2 * |A ∩ B| / (|A| + |B|)，范围 0~1
    function diceCoefficient(a, b) {
        const A = bigrams(a);
        const B = bigrams(b);
        if (A.size === 0 || B.size === 0) return 0;
        let inter = 0;
        for (const g of A) if (B.has(g)) inter++;
        return (2 * inter) / (A.size + B.size);
    }

    // 从标题里剥掉比赛前缀，如 [CTSC2017]xxx → xxx
    function stripPrefix(title) {
        return (title || '').replace(/^\s*[\[【（(][^\]】）)]*[\]】）)]\s*/, '').trim();
    }

    // 提取题面里的关键词（取中文/英数片段，长度>=2，去停用词，统计频率）
    function extractKeywords(statement) {
        const stopWords = new Set([
            '题目', '描述', '输入', '输出', '格式', '样例', '数据', '规模', '范围',
            '对于', '其中', '表示', '一个', '整数', '第一', '第二', '接下来', '如下',
            'the', 'and', 'for', 'with', 'input', 'output', 'sample', 'data'
        ]);
        const tokens = (statement || '')
            .toLowerCase()
            .match(/[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9]{1,}/g) || [];
        const freq = new Map();
        for (const t of tokens) {
            if (stopWords.has(t)) continue;
            freq.set(t, (freq.get(t) || 0) + 1);
        }
        return freq;
    }

    // 综合打分：标题相似度(权重高) + 题面关键词命中
    function scoreCandidate(info, candidate) {
        const xydTitle = info.title;
        const lglTitle = candidate.title;

        // 1) 原始标题 vs 洛谷标题
        const titleSim = diceCoefficient(xydTitle, lglTitle);
        // 2) 去前缀后再比一次，取较高
        const titleSimStripped = diceCoefficient(stripPrefix(xydTitle), stripPrefix(lglTitle));
        const bestTitleSim = Math.max(titleSim, titleSimStripped);

        // 3) 题面关键词是否出现在洛谷标题里（标题是强信号）
        const keywords = extractKeywords(info.statement);
        let keywordHit = 0;
        let keywordTotal = 0;
        const normLglTitle = normalize(lglTitle);
        for (const [kw, cnt] of keywords) {
            // 只取出现次数较多、长度较长的关键词参与
            if (kw.length < 2) continue;
            keywordTotal += cnt;
            if (normLglTitle.includes(normalize(kw))) {
                keywordHit += cnt;
            }
        }
        const keywordScore = keywordTotal > 0 ? keywordHit / keywordTotal : 0;

        // 综合（标题占大头）
        const total = bestTitleSim * 0.75 + keywordScore * 0.25;
        return {
            total,
            titleSim: bestTitleSim,
            keywordScore
        };
    }

    // 本地匹配：返回排序后的 candidates（带 _score）
    function localMatch(info, candidates) {
        const scored = candidates.map(c => {
            const s = scoreCandidate(info, c);
            return { ...c, _score: s.total, _detail: s };
        });
        scored.sort((a, b) => b._score - a._score);
        console.log('[OJ→洛谷] 本地相似度匹配结果（前 5）:',
            scored.slice(0, 5).map(c => `${c.id} ${c.title}  score=${c._score.toFixed(3)}`));

        // 阈值：太低就认为没匹配上
        const THRESHOLD = 0.15;
        return scored.filter(c => c._score >= THRESHOLD).slice(0, 3);
    }

    // ========== 模型语义匹配（在候选里挑） ==========
    async function askDeepSeek(xydStatement, candidates) {
        if (!getApiKey()) throw new Error('NO_API_KEY');

        const candidateList = candidates
            .map(c => `- ${c.id}: ${c.title}`)
            .join('\n');

        const prompt = `你是一个信息学竞赛题目匹配专家。我会给你一道题目的完整描述，以及洛谷上的若干候选题目。请判断这道题最可能对应洛谷上的哪道题。

【OJ题目描述】
${xydStatement}

【洛谷候选题目】
${candidateList}

【任务】
请只返回最匹配的洛谷题目ID（如 P1001），不要输出其他任何内容。
如果没有任何一道题匹配，返回 "NONE"。
如果有多道题可能匹配，按匹配度从高到低返回，用逗号分隔（最多3个）。
优先选择标题简洁、难度较低、不带比赛前缀（如 [CTSC2017]）的题目。`;

        const content = await callLLM(prompt, { temperature: 0.1, maxTokens: 200 });
        console.log('[OJ→洛谷] 模型返回:', content);

        if (!content || /NONE/i.test(content)) return [];
        return content.split(/[,，\s]+/).filter(s => s.trim()).map(s => s.trim());
    }

    // ========== 从模型回复里抠出洛谷题号 ==========
    // 支持 P1001、B2001、CF25E、AT_abc001_a、SP1234 等格式
    function parsePidList(content) {
        const c = (content || '').trim();
        if (!c || /NONE/i.test(c)) return [];
        const tokens = c.match(/\b[A-Za-z][A-Za-z0-9_]{1,15}\b/g) || [];
        const pids = [];
        for (const t of tokens) {
            if (!/\d/.test(t)) continue;          // 必须含数字，排除 NONE / Test 这类纯单词
            if (!pids.includes(t)) pids.push(t);
            if (pids.length >= 3) break;
        }
        return pids;
    }

    // ========== ② 完整题面直接喂给模型，让它给出洛谷题号 ==========
    async function askDeepSeekDirect(statement, title) {
        if (!getApiKey()) throw new Error('NO_API_KEY');

        const prompt = `你是信息学竞赛题目检索专家。下面这道题很可能来自洛谷（Luogu），但题面里的题目名可能被改写过。
请你根据题面内容，直接判断它对应洛谷上的哪道题，并给出洛谷题号（形如 P1001、B2001、CF25E、AT_abc001_a）。

【题目名称】
${title || '（未知）'}

【完整题面】
${statement}

【输出要求】
1. 只输出洛谷题号，不要输出任何解释、不要加代码块、不要加中文说明。
2. 最多 3 个，按可能性从高到低用英文逗号分隔，例如：P2880,P1198。
3. 完全没有把握时只输出 NONE。
4. 严禁编造题号：不确定的宁可不给。`;

        const content = await callLLM(prompt, { temperature: 0, maxTokens: 80 });
        console.log('[OJ→洛谷] 模型直答返回:', content);
        return parsePidList(content);
    }

    // ========== ③ 最低优先级：拿题面原文片段去洛谷做全文搜索（content=true） ==========
    // 就截题面首段的一小段原文当检索词，不搞多档
    function statementKeyword(statement) {
        const skipLine = /^(题目描述|题目背景|输入格式|输出格式|样例|样例输入|样例输出|说明|提示|数据范围|限制|description|input|output|samples?|limitation)$/i;
        const lines = (statement || '')
            .split('\n')
            .map(s => s.trim())
            .filter(s => s && !skipLine.test(s) && !/^#/.test(s));
        const first = lines.find(s => s.length >= 8) || lines[0] || '';
        return first.slice(0, 30);
    }

    // 候选题目 -> 展示用结果
    function toMatch(c) {
        return { id: c.id, title: c.title, url: c.sourceUrl };
    }

    async function contentSearch(info) {
        const keyword = statementKeyword(info.statement) || info.title;
        if (!keyword) return [];

        console.log(`[OJ→洛谷] 题面全文搜索 "${keyword}"...`);
        const list = await searchProblems(keyword, { content: true });

        return list.slice(0, 3).map(toMatch);
    }

    // ========== 取洛谷题号对应的题目名（结果里要显示"题号 题目名"） ==========
    function fetchProblemTitle(pid) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `${LUOGU_PROBLEM_URL}/${encodeURIComponent(pid)}`,
                headers: LUOGU_HEADERS,
                onload: function(response) {
                    const text = response.responseText || '';
                    if (response.status === 404) { resolve(''); return; }
                    try {
                        const d = JSON.parse(text);
                        const p = (d && d.currentData && d.currentData.problem)
                            || (d && d.data && d.data.problem)
                            || (d && d.problem);
                        if (p && p.title) { resolve(p.title); return; }
                    } catch (e) { /* 落到下面的兜底解析 */ }

                    const tm = text.match(/"title"\s*:\s*"([^"]{1,120})"/);
                    resolve(tm ? tm[1] : '');
                },
                onerror: function() { resolve(''); }
            });
        });
    }

    // ========== 按优先级依次尝试 ==========
    // ① 原来的方法（最高）：标题搜洛谷 -> DeepSeek 从候选里挑 -> 本地相似度兜底
    // ② 完整题面直接喂 DeepSeek，让它给出洛谷题号（DS 觉得候选里都不对时走这步）
    // ③ 题面全文搜索（content=true）
    // 都不行才拿 ① 的本地相似度结果兜底
    async function findOriginalProblem(info) {
        // ① 原来的方法
        console.log('[OJ→洛谷] ① 按标题搜索洛谷...');
        const candidates = await searchProblems(info.title);
        let localMatches = [];

        if (candidates.length) {
            localMatches = localMatch(info, candidates).map(c => ({
                ...toMatch(c),
                _label: `相似度 ${(c._score * 100).toFixed(0)}%`
            }));

            if (getApiKey()) {
                try {
                    const matchedPids = await askDeepSeek(info.statement, candidates);
                    const matches = matchedPids
                        .map(pid => candidates.find(c => c.id === pid))
                        .filter(Boolean)
                        .map(toMatch);
                    if (matches.length) return { method: 'deepseek-candidates', matches };
                    console.log('[OJ→洛谷] ① DeepSeek 觉得候选里没有对的，把决定权交给它');
                } catch (e) {
                    console.warn('[OJ→洛谷] ① DeepSeek 调用失败:', e.message);
                }
            }
        }

        // ② 完整题面直接喂 DeepSeek
        if (getApiKey()) {
            try {
                console.log('[OJ→洛谷] ② 把完整题面交给 DeepSeek 给题号...');
                const pids = await askDeepSeekDirect(info.statement, info.title);
                if (pids.length) {
                    // 顺手把洛谷上的题目名取回来，结果显示成"题号 题目名"
                    const matches = await Promise.all(pids.map(async (pid) => ({
                        id: pid,
                        title: await fetchProblemTitle(pid),
                        url: `${LUOGU_PROBLEM_URL}/${pid}`
                    })));
                    return { method: 'deepseek-direct', matches };
                }
                console.log('[OJ→洛谷] ② DeepSeek 没给出题号');
            } catch (e) {
                console.warn('[OJ→洛谷] ② DeepSeek 直答失败:', e.message);
            }
        }

        // ③ 题面全文搜索
        console.log('[OJ→洛谷] ③ 用题面片段在洛谷做全文搜索...');
        const contentMatches = await contentSearch(info);
        if (contentMatches.length) return { method: 'content', matches: contentMatches };

        // 兜底：① 里的本地相似度结果
        if (localMatches.length) return { method: 'local', matches: localMatches };
        return { method: 'none', matches: [] };
    }

    // ========== 弹窗展示匹配结果 ==========
    const METHOD_META = {
        'deepseek-direct': { tag: '（模型直答）', desc: '已把完整题面交给模型，由其直接给出洛谷题号' },
        'content': { tag: '（题面全文搜索）', desc: '用题面片段在洛谷做了全文检索' },
        'deepseek-candidates': { tag: '（模型语义匹配）', desc: '按标题搜出候选后由模型判断' },
        'local': { tag: '（本地相似度）', desc: '按标题搜出候选后用本地相似度排序' },
        'none': { tag: '（无结果）', desc: '未能在洛谷找到匹配的原题' }
    };

    function showMatchPanel(matches, title, searchUrl, method) {
        const oldPanel = document.getElementById('xyd-luogu-match-panel');
        if (oldPanel) oldPanel.remove();
        const oldOverlay = document.getElementById('xyd-luogu-match-overlay');
        if (oldOverlay) oldOverlay.remove();

        const panel = document.createElement('div');
        panel.id = 'xyd-luogu-match-panel';
        panel.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 9999999;
            width: 520px;
            max-width: 90vw;
            max-height: 80vh;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 8px 40px rgba(0,0,0,0.25);
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            color: #333;
        `;

        const overlay = document.createElement('div');
        overlay.id = 'xyd-luogu-match-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 9999998;
            background: rgba(0,0,0,0.35);
        `;
        overlay.addEventListener('click', () => {
            panel.remove();
            overlay.remove();
        });

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid #f0f0f0;
            background: linear-gradient(135deg, #4a90e2, #357abd);
            color: #fff;
        `;
        header.innerHTML = `
            <div style="font-size: 16px; font-weight: bold;">
                🔍 洛谷原题匹配结果
                <span style="font-size: 12px; font-weight: normal; opacity: 0.9;">
                    ${(METHOD_META[method] || METHOD_META.none).tag}
                </span>
            </div>
            <div style="cursor: pointer; font-size: 20px; line-height: 1;" id="xyd-match-close">×</div>
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            padding: 20px;
            max-height: 60vh;
            overflow-y: auto;
        `;

        if (matches.length === 0) {
            content.innerHTML = `
                <div style="text-align: center; padding: 20px 0; color: #999;">
                    <div style="font-size: 40px; margin-bottom: 10px;">😕</div>
                    <div>未在洛谷找到匹配的原题</div>
                    <div style="margin-top: 16px;">
                        <a href="${escapeHtml(searchUrl)}" target="_blank"
                           style="display: inline-block; padding: 8px 16px; background: #4a90e2; color: #fff; border-radius: 6px; text-decoration: none; font-weight: bold;">
                            手动搜索洛谷
                        </a>
                    </div>
                </div>
            `;
        } else {
            const meta = METHOD_META[method] || METHOD_META.none;
            let html = `<div style="margin-bottom: 14px; color: #666;">
                ${meta.desc}，判断「<b>${escapeHtml(title)}</b>」可能对应以下洛谷题目：
            </div>`;

            matches.forEach((m, i) => {
                const scoreColor = i === 0 ? '#52c41a' : '#faad14';
                const scoreText = i === 0 ? '最佳匹配' : '备选';
                const scoreNum = m._label
                    ? `<span style="color:#999;font-size:12px;margin-left:6px;">${m._label}</span>`
                    : '';
                html += `
                    <a href="${escapeHtml(m.url)}" target="_blank"
                       style="display: block; padding: 14px 16px; margin-bottom: 10px;
                              border: 1px solid #e8e8e8; border-radius: 8px;
                              text-decoration: none; color: #333;
                              transition: all 0.2s;"
                       onmouseover="this.style.borderColor='#4a90e2';this.style.boxShadow='0 2px 12px rgba(74,144,226,0.15)'"
                       onmouseout="this.style.borderColor='#e8e8e8';this.style.boxShadow='none'">
                        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                            <span style="min-width: 0;">
                                <span style="font-size: 16px; font-weight: bold; color: #4a90e2;">${escapeHtml(m.id)}</span> <span style="font-size: 14px; color: #333;">${escapeHtml(m.title)}</span>
                            </span>
                            <span style="font-size: 12px; color: ${scoreColor}; font-weight: bold; flex: none;">${scoreText}${scoreNum}</span>
                        </div>
                    </a>
                `;
            });

            html += `
                <div style="margin-top: 16px; text-align: center;">
                    <a href="${escapeHtml(searchUrl)}" target="_blank"
                       style="color: #999; font-size: 13px; text-decoration: none;">
                        手动搜索洛谷 →
                    </a>
                </div>
            `;
            content.innerHTML = html;
        }

        panel.appendChild(header);
        panel.appendChild(content);
        document.body.appendChild(overlay);
        document.body.appendChild(panel);

        document.getElementById('xyd-match-close').addEventListener('click', () => {
            panel.remove();
            overlay.remove();
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                panel.remove();
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    // ========== 定位 tags 容器 ==========
    function findTagsContainer() {
        let el = document.querySelector('._tags_yuqeq_67');
        if (el) return el;
        const tag = [...document.querySelectorAll('.ac-ant-tag')]
            .find(t => t.textContent.includes('题目ID'));
        if (tag && tag.parentElement) return tag.parentElement;
        return null;
    }

    // 英行OJ：题面标签栏里那个"内存限制"标签（如 512MiB）
    function findMemoryTag() {
        const tags = document.querySelectorAll('.problem__tags .problem__tag-item');
        for (const t of tags) {
            if (/\d+\s*MiB/i.test(t.textContent || '')) return t;
        }
        return document.querySelector('.problem__tags .icon-comparison');
    }

    // ========== 按钮样式 ==========
    // 信友队站点的内联小按钮基础样式
    const SMALL_BUTTON_STYLE = {
        'box-sizing': 'border-box',
        'display': 'inline-block',
        'margin': '0',
        'margin-inline-end': '8px',
        'padding': '0 7px',
        'height': 'auto',
        'font-family': 'inherit',
        'font-size': '12px',
        'font-weight': '400',
        'line-height': '20px',
        'white-space': 'nowrap',
        'vertical-align': 'middle',
        'position': 'relative',
        'cursor': 'pointer',
        'opacity': '1',
        'transition': 'all 0.2s',
        'border-radius': '4px'
    };

    function styleSmallButton(btn, color, background) {
        applyStyles(btn, SMALL_BUTTON_STYLE);
        applyStyles(btn, {
            'text-align': 'start',
            'border': `1px solid ${color}`,
            'background': background,
            'color': color
        });
    }

    // 英行OJ 站点标签样式的按钮
    function createTagButton(id, label, opts = {}) {
        const btn = document.createElement('span');
        btn.id = id;
        btn.className = opts.iconClass ? `problem__tag-item icon ${opts.iconClass}` : 'problem__tag-item';
        btn.textContent = label;
        if (opts.title) btn.title = opts.title;
        applyStyles(btn, { 'cursor': 'pointer', 'user-select': 'none' });
        if (opts.active) {
            applyStyles(btn, { 'background': '#D96B32', 'border-color': '#D96B32', 'color': '#fff' });
        }
        return btn;
    }

    // ========== 创建按钮图标（洛谷 SVG，失败回退 🔍） ==========
    function createLuoguIcon() {
        const icon = document.createElement('img');
        icon.src = 'https://fecdn.luogu.com.cn/columba/static.325908fec383795b.logo-single-color.svg';
        icon.alt = '洛谷';
        icon.referrerPolicy = 'no-referrer';
        applyStyles(icon, {
            'width': '14px',
            'height': '14px',
            'vertical-align': '-2px',
            'margin-inline-end': '4px',
            'display': 'inline-block'
        });

        icon.addEventListener('error', () => {
            console.warn('[OJ→洛谷] 洛谷图标加载失败，回退为 🔍');
            const fallback = document.createElement('span');
            fallback.textContent = '🔍 ';
            fallback.className = 'xyd-luogu-icon-fallback';
            applyStyles(fallback, {
                'font-size': '12px',
                'vertical-align': 'middle',
                'margin-inline-end': '2px'
            });
            if (icon.parentNode) icon.parentNode.replaceChild(fallback, icon);
        });

        return icon;
    }

    // ========== 创建按钮 ==========
    function createButton(titleEl) {
        const oldBtn = document.getElementById('xyd-luogu-search-btn');
        if (oldBtn) oldBtn.remove();

        const isTagStyle = SITE === 'xinxingshe';   // 英行OJ：直接套用站点自己的题目标签样式
        const btn = document.createElement(isTagStyle ? 'span' : 'button');
        btn.id = 'xyd-luogu-search-btn';
        btn.title = '查找本题的洛谷原题：先按标题在洛谷搜候选让模型挑，其次把完整题面交给模型，最后题面全文搜索';

        const icon = createLuoguIcon();
        const label = document.createElement('span');
        label.className = 'xyd-luogu-btn-label';
        label.textContent = '查找洛谷原题';

        btn.appendChild(icon);
        btn.appendChild(label);

        if (isTagStyle) {
            // 与 512MiB 那个标签同款样式
            btn.className = 'problem__tag-item';
            applyStyles(btn, { 'cursor': 'pointer', 'user-select': 'none' });
        } else {
            styleSmallButton(btn, '#52c41a', '#f6ffed');

            if (!document.getElementById('xyd-luogu-search-btn-style')) {
                const style = document.createElement('style');
                style.id = 'xyd-luogu-search-btn-style';
                style.textContent = `
                #xyd-luogu-search-btn:hover {
                    background: #d9f7be !important;
                    border-color: #52c41a !important;
                    color: #52c41a !important;
                }
                #xyd-luogu-search-btn:active {
                    background: #b7eb8f !important;
                    border-color: #389e0d !important;
                    color: #389e0d !important;
                }
                #xyd-luogu-search-btn > img,
                #xyd-luogu-search-btn > .xyd-luogu-icon-fallback {
                    flex: none;
                }
            `;
                document.head.appendChild(style);
            }
        }

        // 英行OJ：插在 512MiB 内存标签的右边
        if (SITE === 'xinxingshe') {
            const memTag = findMemoryTag();
            if (memTag && memTag.parentNode) {
                memTag.parentNode.insertBefore(btn, memTag.nextSibling);
                return btn;
            }
            const tagsEl = document.querySelector('.problem__tags');
            if (tagsEl) {
                tagsEl.appendChild(btn);
                return btn;
            }
            const problemTitleEl = getTitleEl();
            if (problemTitleEl && problemTitleEl.parentNode) {
                problemTitleEl.parentNode.insertBefore(btn, problemTitleEl.nextSibling);
            }
            return btn;
        }

        // 信友队：插在标签栏里，找不到就插在标题后面
        const tagsEl = findTagsContainer();
        if (tagsEl) {
            tagsEl.appendChild(btn);
            return btn;
        }

        if (titleEl.parentNode) {
            titleEl.parentNode.insertBefore(btn, titleEl.nextSibling);
        } else {
            titleEl.appendChild(btn);
        }
        return btn;
    }

    // ========== 绑定按钮事件 ==========
    function bindButtonEvent(btn, info) {
        const searchUrl = `https://www.luogu.com.cn/problem/list?keyword=${encodeURIComponent(info.title)}`;
        const label = btn.querySelector('.xyd-luogu-btn-label');
        let busy = false;

        btn.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            if (label) label.textContent = '搜索中...';
            btn.disabled = true;

            try {
                const result = await findOriginalProblem(info);
                showMatchPanel(result.matches, info.title, searchUrl, result.method);
            } catch (e) {
                console.error('[OJ→洛谷] 匹配异常:', e);
                showMatchPanel([], info.title, searchUrl, 'none');
                alert(`匹配失败：${e.message}`);
            } finally {
                if (label) label.textContent = '查找洛谷原题';
                btn.disabled = false;
                busy = false;
            }
        });
    }

    // ========== 专注模式（英行OJ） ==========
    // 开启后：隐藏右侧栏，题面撑满整行；侧栏里的「递交」「进入在线编程模式」
    // 以站点标签样式挪到题目标签栏「标签>」右边（对应草图里的 1、2 号位）
    // 开启动效（两拍）：侧栏原位淡出滑走 -> 藏侧栏、主栏平滑撑满；按钮同时淡入
    // 退出动效（两拍）：按钮淡出、主栏平滑缩回 -> 侧栏原位淡入滑回
    const SIDE_ANIM = `opacity ${FOCUS_ANIM_MS}ms ease, transform ${FOCUS_ANIM_MS}ms ease`;
    const WIDTH_ANIM = `width ${FOCUS_ANIM_MS}ms ease, flex-basis ${FOCUS_ANIM_MS}ms ease, max-width ${FOCUS_ANIM_MS}ms ease`;
    let focusAnimTimer = null;   // 进/出动效共用的收尾定时器，来回切换时互相打断

    function isFocusMode() {
        return SITE === 'xinxingshe' && !!GM_getValue(FOCUS_MODE_KEY, false);
    }

    // 清掉元素上的动效内联样式
    function clearAnimStyles(el) {
        ['opacity', 'transform', 'transition'].forEach(prop => el.style.removeProperty(prop));
    }

    // 淡出后再从 DOM 移除（闭包持有引用，不会误删后注入的同 ID 新元素）
    function fadeOutRemove(el) {
        applyStyles(el, {
            'transition': 'opacity .18s ease, transform .18s ease',
            'opacity': '0',
            'transform': 'translateX(10px)'
        });
        setTimeout(() => el.remove(), 190);
    }

    // 进入动效：按钮从右侧淡入回位（与退出淡出对称）
    function slideInShow(el) {
        applyStyles(el, {
            'transition': 'opacity .18s ease, transform .18s ease',
            'opacity': '0',
            'transform': 'translateX(10px)'
        });
        void el.offsetWidth;   // 强制回流，让初始态先生效
        applyStyles(el, { 'opacity': '1', 'transform': 'none' });
        setTimeout(() => {
            if (el.style.opacity === '0') return;   // 已被退出淡出接管
            clearAnimStyles(el);
        }, 240);
    }

    // 侧栏 + 主栏的 DOM 定位
    function queryFocusLayout() {
        const sidebar = document.querySelector('.section--problem-sidebar');
        const sideCol = sidebar ? sidebar.closest('.medium-3.columns') : null;
        let mainCol = null;
        if (sideCol) {
            // 主栏 = 侧栏左边那列（专注模式开着时它已是 medium-12，两种都要认）
            const prev = sideCol.previousElementSibling;
            mainCol = prev && /medium-(9|12)/.test(prev.className)
                ? prev
                : sideCol.parentElement.querySelector('.medium-9.columns, .medium-12.columns');
        }
        return { sidebar, sideCol, mainCol };
    }

    function removeFocusActionButtons(animate) {
        ['xyd-focus-submit', 'xyd-focus-ide'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (animate) fadeOutRemove(el);
            else el.remove();
        });
    }

    function renderFocusToggle(tagsEl, on) {
        const oldToggle = document.getElementById('xyd-focus-toggle');
        if (oldToggle) oldToggle.remove();

        const toggle = createTagButton('xyd-focus-toggle', on ? '专注中' : '专注模式', {
            active: on,
            title: on ? '退出专注模式（恢复侧栏）' : '专注模式：隐藏侧栏，递交/在线编程移到标签栏'
        });
        toggle.addEventListener('click', () => {
            GM_setValue(FOCUS_MODE_KEY, !isFocusMode());
            setupFocusMode();
        });

        // 开关按钮放在「查找洛谷原题」右边
        const luoguBtn = document.getElementById('xyd-luogu-search-btn');
        if (luoguBtn && luoguBtn.parentNode) {
            luoguBtn.insertAdjacentElement('afterend', toggle);
        } else {
            tagsEl.appendChild(toggle);
        }
    }

    function renderFocusActionButtons(sidebar, tagsEl, animate) {
        // ① 递交（取侧栏里的递交链接）
        const submitLink = sidebar.querySelector('a[href*="/submit"]');
        if (submitLink && submitLink.getAttribute('href')) {
            const submitBtn = createTagButton('xyd-focus-submit', '递交', {
                iconClass: 'icon-send',
                title: '递交本题'
            });
            submitBtn.addEventListener('click', () => {
                location.href = submitLink.getAttribute('href');
            });
            tagsEl.appendChild(submitBtn);
            if (animate) slideInShow(submitBtn);
        }

        // ② 在线编程（触发侧栏"进入在线编程模式"，Alt+E 同款）
        const scratchLink = sidebar.querySelector('a[name="problem-sidebar__open-scratchpad"]');
        if (scratchLink) {
            const ideBtn = createTagButton('xyd-focus-ide', '在线编程', {
                iconClass: 'icon-enlarge',
                title: '进入在线编程模式 (Alt+E)'
            });
            ideBtn.addEventListener('click', () => scratchLink.click());
            tagsEl.appendChild(ideBtn);
            if (animate) slideInShow(ideBtn);
        }
    }

    // 进入布局（两拍）：侧栏淡出滑走 -> 藏侧栏、主栏撑满
    function playFocusEnter(sideCol, mainCol) {
        // 第一拍：侧栏在原位淡出滑走（主栏暂不撑开，避免两列同时超宽）
        applyStyles(sideCol, { 'transition': SIDE_ANIM, 'opacity': '0', 'transform': 'translateX(14px)' });
        clearTimeout(focusAnimTimer);
        focusAnimTimer = setTimeout(() => {
            // 第二拍：藏起侧栏，主栏平滑撑满
            applyStyles(sideCol, { 'display': 'none' });
            clearAnimStyles(sideCol);
            applyStyles(mainCol, { 'transition': WIDTH_ANIM });
            mainCol.classList.remove('medium-9');
            mainCol.classList.add('medium-12');
            focusAnimTimer = setTimeout(() => mainCol.style.removeProperty('transition'), FOCUS_ANIM_MS + 60);
        }, FOCUS_ANIM_MS + 40);
    }

    // 退出布局（两拍）：主栏缩回 -> 侧栏淡入滑回
    function playFocusExit(sideCol, mainCol) {
        // 第一拍：主栏平滑缩回（侧栏保持隐藏，避免两列宽度叠加超出一行）
        applyStyles(mainCol, { 'transition': WIDTH_ANIM });
        mainCol.classList.remove('medium-12');
        mainCol.classList.add('medium-9');
        clearTimeout(focusAnimTimer);
        focusAnimTimer = setTimeout(() => {
            mainCol.style.removeProperty('transition');

            // 第二拍：侧栏淡入 + 从右滑回原位
            sideCol.style.removeProperty('display');
            applyStyles(sideCol, {
                'opacity': '0',
                'transform': 'translateX(14px)',
                'transition': SIDE_ANIM
            });
            void sideCol.offsetWidth;   // 强制回流，让「初始不可见」先生效
            applyStyles(sideCol, { 'opacity': '1', 'transform': 'none' });
            focusAnimTimer = setTimeout(() => clearAnimStyles(sideCol), FOCUS_ANIM_MS + 60);
        }, FOCUS_ANIM_MS + 60);
    }

    // 即时布局（页面加载 / SPA 切题，不播动效）
    function applyFocusLayoutInstant(sideCol, mainCol) {
        clearTimeout(focusAnimTimer);
        clearAnimStyles(sideCol);
        mainCol.style.removeProperty('transition');
        applyStyles(sideCol, { 'display': 'none' });
        mainCol.classList.remove('medium-9');
        mainCol.classList.add('medium-12');
    }

    function applyNormalLayoutInstant(sideCol, mainCol) {
        clearTimeout(focusAnimTimer);
        mainCol.classList.remove('medium-12');
        mainCol.classList.add('medium-9');
        sideCol.style.removeProperty('display');
        clearAnimStyles(sideCol);
        mainCol.style.removeProperty('transition');
    }

    function setupFocusMode() {
        if (SITE !== 'xinxingshe') return;

        const tagsEl = document.querySelector('.problem__tags');
        if (!tagsEl) return;

        const on = isFocusMode();
        const hadToggle = !!document.getElementById('xyd-focus-toggle');
        const hadButtons = !!document.getElementById('xyd-focus-submit') || !!document.getElementById('xyd-focus-ide');
        // 还留着提交/编程按钮 → 刚才是开启状态，现在要关 → 播放退出动效
        // 开关在而按钮不在 → 刚才是关闭状态，现在要开 → 播放进入动效
        const exiting = !on && hadButtons;
        const entering = on && hadToggle && !hadButtons;

        removeFocusActionButtons(exiting);
        renderFocusToggle(tagsEl, on);

        const { sidebar, sideCol, mainCol } = queryFocusLayout();
        // 页面结构对不上时只留开关，不动布局
        if (!sideCol || !mainCol) return;

        if (on) {
            if (entering) playFocusEnter(sideCol, mainCol);
            else applyFocusLayoutInstant(sideCol, mainCol);
            renderFocusActionButtons(sidebar, tagsEl, entering);
        } else if (exiting) {
            playFocusExit(sideCol, mainCol);
        } else {
            applyNormalLayoutInstant(sideCol, mainCol);
        }
    }

    // ========== 复制题面 Markdown ==========
    // 英行OJ 直接取 pdoc.content 的 markdown 原文（最完整）；信友队退回提取的题面文本
    // 并把 pdoc.config 里的时间/内存限制补进 Limitation 节（没有该节就追加）
    function fmtLimitRange(min, max, unit) {
        if (min == null && max == null) return '';
        if (min == null) min = max;
        if (max == null) max = min;
        return min === max ? `${min}${unit}` : `${min}${unit} ~ ${max}${unit}`;
    }

    function buildLimitsMarkdown(pdoc) {
        const cfg = pdoc && pdoc.config;
        if (!cfg) return '';
        const lines = [];
        const time = fmtLimitRange(cfg.timeMin, cfg.timeMax, 'ms');
        const mem = fmtLimitRange(cfg.memoryMin, cfg.memoryMax, 'MiB');
        if (time) lines.push(`- 时间限制：${time}`);
        if (mem) lines.push(`- 内存限制：${mem}`);
        return lines.join('\n');
    }

    function buildStatementMarkdown(info) {
        let body = '';
        let limits = '';
        if (SITE === 'xinxingshe') {
            const pdoc = readPdoc();
            if (pdoc && typeof pdoc.content === 'string' && pdoc.content.trim()) {
                body = pdoc.content.trim();
            }
            limits = buildLimitsMarkdown(pdoc);
        }
        if (!body.trim()) body = info.statement || '';

        if (limits) {
            const headingRe = /^#{1,6}[ \t]*Limitation\b.*$/im;
            if (headingRe.test(body)) {
                // 已有 Limitation 节：把限制补到节标题下面
                body = body.replace(headingRe, m => `${m}\n\n${limits}`);
            } else {
                body += `\n\n## Limitation\n\n${limits}`;
            }
        }
        return info.title ? `# ${info.title}\n\n${body}` : body;
    }

    function setupCopyStatement(info) {
        const oldBtn = document.getElementById('xyd-copy-statement-btn');
        if (oldBtn) oldBtn.remove();

        let btn;
        if (SITE === 'xinxingshe') {
            btn = createTagButton('xyd-copy-statement-btn', '复制题面', {
                title: '以 Markdown 复制完整题面（标题 + 题面原文 + 时限/内存）'
            });
        } else {
            btn = document.createElement('button');
            btn.id = 'xyd-copy-statement-btn';
            btn.title = '复制题面文本';
            styleSmallButton(btn, '#4a90e2', '#f3f9ff');
            btn.textContent = '复制题面';
        }

        // 插在「专注模式」开关（英行OJ）或「查找洛谷原题」（信友队）后面
        const anchor = document.getElementById('xyd-focus-toggle')
            || document.getElementById('xyd-luogu-search-btn');
        if (!anchor || !anchor.parentNode) return;
        anchor.insertAdjacentElement('afterend', btn);

        let copyTimer = null;
        btn.addEventListener('click', () => {
            GM_setClipboard(buildStatementMarkdown(info));
            btn.textContent = '已复制 ✓';
            clearTimeout(copyTimer);
            copyTimer = setTimeout(() => { btn.textContent = '复制题面'; }, 1200);
        });
    }

    // ========== 主流程 ==========
    async function main() {
        if (mainRunning) return;
        mainRunning = true;

        try {
            const titleEl = await waitForElement(getTitleSelector(), 15000);
            const info = extractProblemInfo();

            if (!info.title) {
                console.log('[OJ→洛谷] 题目名为空，终止');
                return;
            }

            if (info.title === currentProblemTitle && document.getElementById('xyd-luogu-search-btn')) {
                console.log(`[OJ→洛谷] 题目未变 ("${info.title}")，跳过`);
                return;
            }

            currentProblemTitle = info.title;
            console.log(`[OJ→洛谷] 题目名: "${info.title}"，题面 ${info.statement.length} 字`);

            const btn = createButton(titleEl);
            bindButtonEvent(btn, info);
            setupFocusMode();        // 英行OJ：专注模式开关与布局
            setupCopyStatement(info);   // 复制题面 Markdown

        } catch (err) {
            console.error('[OJ→洛谷] 主流程异常:', err);
        } finally {
            mainRunning = false;
        }
    }

    // ========== 监听题目切换（SPA 场景） ==========
    function watchProblemChange() {
        let lastSeenTitle = '';

        const observer = new MutationObserver(() => {
            const titleEl = getTitleEl();
            if (!titleEl) return;

            const title = cleanTitle(titleEl.innerText);
            if (!title) return;

            const btnExists = document.getElementById('xyd-luogu-search-btn');

            if (title !== lastSeenTitle || !btnExists) {
                lastSeenTitle = title;
                console.log(`[OJ→洛谷] 检测到题目变化: "${title}"，重新注入按钮`);
                setTimeout(main, 300);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ========== 脚本入口 ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            main();
            watchProblemChange();
        });
    } else {
        main();
        watchProblemChange();
    }
})();