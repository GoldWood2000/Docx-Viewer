(function () {
    'use strict';

    var aiPanel = document.getElementById('aiPanel');
    var aiTabsBar = document.getElementById('aiTabsBar');
    var aiNewTab = document.getElementById('aiNewTab');
    var aiMessages = document.getElementById('aiMessages');
    var aiChatInput = document.getElementById('aiChatInput');
    var aiChatSend = document.getElementById('aiChatSend');

    var settingsProvider = document.getElementById('settingsProvider');
    var settingsApiBase = document.getElementById('settingsApiBase');
    var settingsApiKey = document.getElementById('settingsApiKey');
    var settingsModel = document.getElementById('settingsModel');
    var settingsSave = document.getElementById('chatSettingsSave');
    var settingsReset = document.getElementById('chatSettingsReset');
    var configToggle = document.getElementById('sidebarConfigToggle');
    var configPanel = document.getElementById('sidebarConfigPanel');

    var tabs = [];
    var activeTabId = null;
    var isStreaming = false;
    var currentSectionId = null;

    var DEFAULTS = {
        openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o' },
        anthropic: { base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' }
    };

    var serverConfig = null;

    function fetchServerConfig() {
        fetch('/api/ai-config').then(function (res) { return res.json(); }).then(function (cfg) {
            if (cfg && (cfg.apiKey || cfg.apiBase || cfg.model)) {
                serverConfig = cfg;
                updateConfigToggleState();
                updatePlaceholders();
            }
        }).catch(function () { /* best-effort */ });
    }

    // --- Settings (sidebar) ---
    function loadSettings() {
        return {
            provider: localStorage.getItem('kb-ai-provider') || '',
            apiBase: localStorage.getItem('kb-ai-base') || '',
            apiKey: localStorage.getItem('kb-ai-key') || '',
            model: localStorage.getItem('kb-ai-model') || ''
        };
    }

    function saveSettings(s) {
        if (s.provider) { localStorage.setItem('kb-ai-provider', s.provider); } else { localStorage.removeItem('kb-ai-provider'); }
        if (s.apiBase) { localStorage.setItem('kb-ai-base', s.apiBase); } else { localStorage.removeItem('kb-ai-base'); }
        if (s.apiKey) { localStorage.setItem('kb-ai-key', s.apiKey); } else { localStorage.removeItem('kb-ai-key'); }
        if (s.model) { localStorage.setItem('kb-ai-model', s.model); } else { localStorage.removeItem('kb-ai-model'); }
        updateConfigToggleState();
    }

    function getEffectiveSettings() {
        var s = loadSettings();
        var provider = s.provider || (serverConfig && serverConfig.provider) || 'openai';
        var def = DEFAULTS[provider] || DEFAULTS.openai;
        return {
            provider: provider,
            apiBase: s.apiBase || (serverConfig && serverConfig.apiBase) || def.base,
            apiKey: s.apiKey || (serverConfig && serverConfig.apiKey) || '',
            model: s.model || (serverConfig && serverConfig.model) || def.model
        };
    }

    function hasApiKey() {
        var s = loadSettings();
        return !!(s.apiKey || (serverConfig && serverConfig.apiKey));
    }

    function updateConfigToggleState() {
        if (hasApiKey()) {
            configToggle.classList.remove('needs-config');
        } else {
            configToggle.classList.add('needs-config');
        }
    }

    function updatePlaceholders() {
        var p = settingsProvider.value || (serverConfig && serverConfig.provider) || 'openai';
        var def = DEFAULTS[p] || DEFAULTS.openai;
        settingsApiBase.placeholder = (serverConfig && serverConfig.apiBase) || def.base;
        settingsModel.placeholder = (serverConfig && serverConfig.model) || def.model;
        settingsApiKey.placeholder = (serverConfig && serverConfig.apiKey) ? '(配置文件已设置)' : 'sk-...';
    }

    function loadSettingsIntoForm() {
        var s = loadSettings();
        settingsProvider.value = s.provider || (serverConfig && serverConfig.provider) || 'openai';
        settingsApiBase.value = s.apiBase;
        settingsApiKey.value = s.apiKey;
        settingsModel.value = s.model;
        updatePlaceholders();
    }

    function openSidebarConfig() {
        loadSettingsIntoForm();
        configPanel.style.display = '';
        configToggle.classList.add('expanded');
    }

    function closeSidebarConfig() {
        configPanel.style.display = 'none';
        configToggle.classList.remove('expanded');
    }

    configToggle.addEventListener('click', function () {
        if (configPanel.style.display === 'none') {
            openSidebarConfig();
        } else {
            closeSidebarConfig();
        }
    });

    settingsProvider.addEventListener('change', updatePlaceholders);

    settingsSave.addEventListener('click', function () {
        saveSettings({
            provider: settingsProvider.value,
            apiBase: settingsApiBase.value.trim(),
            apiKey: settingsApiKey.value.trim(),
            model: settingsModel.value.trim()
        });
        closeSidebarConfig();
    });

    settingsReset.addEventListener('click', function () {
        localStorage.removeItem('kb-ai-provider');
        localStorage.removeItem('kb-ai-base');
        localStorage.removeItem('kb-ai-key');
        localStorage.removeItem('kb-ai-model');
        loadSettingsIntoForm();
        updateConfigToggleState();
    });

    // --- Tabs ---
    function genId() {
        return 'tab-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    }

    function createTab() {
        var tab = { id: genId(), title: '新对话', messages: [], sectionId: null };
        tabs.push(tab);
        switchTab(tab.id);
        saveTabs();
        return tab;
    }

    function closeTab(id) {
        var idx = tabs.findIndex(function (t) { return t.id === id; });
        if (idx === -1) { return; }
        tabs.splice(idx, 1);
        if (tabs.length === 0) {
            createTab();
        } else if (activeTabId === id) {
            switchTab(tabs[Math.min(idx, tabs.length - 1)].id);
        } else {
            renderTabs();
        }
        saveTabs();
    }

    function switchTab(id) {
        activeTabId = id;
        renderTabs();
        renderMessages();
        aiChatInput.focus();
    }

    function getActiveTab() {
        return tabs.find(function (t) { return t.id === activeTabId; });
    }

    function renderTabs() {
        var html = '';
        tabs.forEach(function (tab) {
            var cls = tab.id === activeTabId ? ' active' : '';
            html += '<div class="kb-chat-tab' + cls + '" data-id="' + tab.id + '">' +
                '<span class="kb-chat-tab-title">' + escapeHtml(tab.title) + '</span>' +
                '<button class="kb-chat-tab-close" data-close="' + tab.id + '">&times;</button>' +
                '</div>';
        });
        aiTabsBar.innerHTML = html;

        aiTabsBar.querySelectorAll('.kb-chat-tab').forEach(function (el) {
            el.addEventListener('click', function (e) {
                if (e.target.closest('.kb-chat-tab-close')) { return; }
                switchTab(el.getAttribute('data-id'));
            });
        });

        aiTabsBar.querySelectorAll('.kb-chat-tab-close').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                closeTab(btn.getAttribute('data-close'));
            });
        });
    }

    function saveTabs() {
        try {
            var data = tabs.map(function (t) {
                return { id: t.id, title: t.title, messages: t.messages.slice(-50), sectionId: t.sectionId };
            });
            localStorage.setItem('kb-chat-tabs', JSON.stringify(data));
        } catch (e) { /* quota exceeded */ }
    }

    function loadTabs() {
        try {
            var raw = localStorage.getItem('kb-chat-tabs');
            if (raw) {
                tabs = JSON.parse(raw);
                if (tabs.length > 0) {
                    activeTabId = tabs[0].id;
                    renderTabs();
                    renderMessages();
                    return;
                }
            }
        } catch (e) { /* corrupted */ }
        createTab();
    }

    // --- Messages (no avatars) ---
    function renderMessages() {
        var tab = getActiveTab();
        if (!tab || tab.messages.length === 0) {
            aiMessages.innerHTML =
                '<div class="kb-chat-empty">' +
                '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
                '<p>输入问题查询知识库</p>' +
                '</div>';
            return;
        }

        var html = '';
        tab.messages.forEach(function (msg) {
            if (msg.role === 'user') {
                html += '<div class="kb-chat-msg user">' +
                    '<div class="kb-chat-bubble">' + escapeHtml(msg.content) + '</div>' +
                    '</div>';
            } else if (msg.role === 'assistant') {
                html += '<div class="kb-chat-msg assistant">' +
                    '<div class="kb-chat-bubble">' + renderMarkdown(msg.content) + '</div>' +
                    '</div>';
            } else if (msg.role === 'error') {
                html += '<div class="kb-chat-error">' + escapeHtml(msg.content) + '</div>';
            }
        });

        aiMessages.innerHTML = html;
        aiMessages.scrollTop = aiMessages.scrollHeight;
    }

    function appendStreamChunk(content) {
        var bubbles = aiMessages.querySelectorAll('.kb-chat-msg.assistant .kb-chat-bubble');
        var lastBubble = bubbles[bubbles.length - 1];
        if (!lastBubble) { return; }

        var tab = getActiveTab();
        if (!tab) { return; }
        var lastMsg = tab.messages[tab.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content += content;
            lastBubble.innerHTML = renderMarkdown(lastMsg.content) + '<span class="kb-chat-cursor"></span>';
            aiMessages.scrollTop = aiMessages.scrollHeight;
        }
    }

    function finishStream() {
        var cursors = aiMessages.querySelectorAll('.kb-chat-cursor');
        cursors.forEach(function (c) { c.remove(); });
        isStreaming = false;
        aiChatSend.disabled = false;
        aiChatInput.focus();

        var tab = getActiveTab();
        if (tab && tab.messages.length >= 2) {
            var lastIdx = tab.messages.length - 1;
            var assistantMsg = tab.messages[lastIdx];
            var userMsg = null;
            for (var i = lastIdx - 1; i >= 0; i--) {
                if (tab.messages[i].role === 'user') {
                    userMsg = tab.messages[i];
                    break;
                }
            }
            if (userMsg && assistantMsg.role === 'assistant' && assistantMsg.content) {
                saveQA(userMsg.content, assistantMsg.content, tab.sectionId);
            }
        }

        saveTabs();
    }

    function saveQA(question, answer, sectionId) {
        fetch('/api/qa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question,
                answer: answer,
                section_id: sectionId || null
            })
        }).catch(function () { /* best-effort */ });
    }

    // --- Stream helper ---
    function streamChat(messages, tab) {
        var settings = getEffectiveSettings();

        fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: messages,
                apiBase: settings.apiBase,
                apiKey: settings.apiKey,
                model: settings.model,
                provider: settings.provider
            })
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('Server error: ' + response.status);
            }

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function read() {
                reader.read().then(function (result) {
                    if (result.done) {
                        finishStream();
                        return;
                    }

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line.startsWith('data: ')) { continue; }
                        var data = line.slice(6);
                        if (data === '[DONE]') {
                            finishStream();
                            return;
                        }
                        try {
                            var parsed = JSON.parse(data);
                            if (parsed.error) {
                                tab.messages.pop();
                                tab.messages.push({ role: 'error', content: parsed.error });
                                renderMessages();
                                finishStream();
                                return;
                            }
                            if (parsed.content) {
                                appendStreamChunk(parsed.content);
                            }
                        } catch (e) { /* skip */ }
                    }

                    read();
                }).catch(function (err) {
                    tab.messages.pop();
                    tab.messages.push({ role: 'error', content: err.message });
                    renderMessages();
                    finishStream();
                });
            }

            read();
        }).catch(function (err) {
            tab.messages.pop();
            tab.messages.push({ role: 'error', content: err.message });
            renderMessages();
            finishStream();
        });
    }

    // --- Send ---
    function sendMessage() {
        var text = aiChatInput.value.trim();
        if (!text || isStreaming) { return; }

        if (!hasApiKey()) {
            openSidebarConfig();
            return;
        }

        var tab = getActiveTab();
        if (!tab) { return; }

        tab.messages.push({ role: 'user', content: text });

        if (tab.messages.filter(function (m) { return m.role === 'user'; }).length === 1) {
            tab.title = text.substring(0, 20) + (text.length > 20 ? '...' : '');
            renderTabs();
        }

        aiChatInput.value = '';
        aiChatInput.style.height = 'auto';

        tab.messages.push({ role: 'assistant', content: '' });
        renderMessages();

        var lastBubble = aiMessages.querySelectorAll('.kb-chat-msg.assistant .kb-chat-bubble');
        lastBubble = lastBubble[lastBubble.length - 1];
        if (lastBubble) { lastBubble.innerHTML = '<span class="kb-chat-cursor"></span>'; }

        isStreaming = true;
        aiChatSend.disabled = true;

        var apiMessages = tab.messages
            .filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
            .map(function (m) { return { role: m.role, content: m.content }; });

        streamChat(apiMessages, tab);
    }

    // --- Auto-send (called from app.js when section is loaded with a query) ---
    function autoSendQuery(query, sectionId) {
        if (!hasApiKey()) {
            openSidebarConfig();
            return;
        }

        var normalizedQuery = query.trim();
        for (var i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            if (t.messages.length > 0 && t.messages[0].role === 'user'
                && t.messages[0].content.trim() === normalizedQuery) {
                switchTab(t.id);
                return;
            }
        }

        var tab = createTab();
        tab.title = query.substring(0, 20) + (query.length > 20 ? '...' : '');
        tab.sectionId = sectionId;
        renderTabs();

        tab.messages.push({ role: 'user', content: query });
        tab.messages.push({ role: 'assistant', content: '' });
        renderMessages();

        var lastBubble = aiMessages.querySelectorAll('.kb-chat-msg.assistant .kb-chat-bubble');
        lastBubble = lastBubble[lastBubble.length - 1];
        if (lastBubble) { lastBubble.innerHTML = '<span class="kb-chat-cursor"></span>'; }

        isStreaming = true;
        aiChatSend.disabled = true;

        streamChat([{ role: 'user', content: query }], tab);
    }

    // --- Global API for app.js ---
    window.kbShowAiPanel = function (query, sectionId) {
        currentSectionId = sectionId || null;
        if (query) {
            autoSendQuery(query, sectionId);
        }
    };

    window.kbHideAiPanel = function () {
        // AI panel is always visible in section view; no-op
    };

    window.kbAskAboutSelection = function (text) {
        if (!text || !text.trim()) { return; }
        if (!hasApiKey()) {
            openSidebarConfig();
            return;
        }

        var prompt = '请根据以下选中内容结合上下文进行分析：\n\n' + text.trim();

        var tab = createTab();
        tab.title = text.trim().substring(0, 20) + (text.trim().length > 20 ? '...' : '');
        tab.sectionId = currentSectionId;
        renderTabs();

        tab.messages.push({ role: 'user', content: prompt });
        tab.messages.push({ role: 'assistant', content: '' });
        renderMessages();

        var lastBubble = aiMessages.querySelectorAll('.kb-chat-msg.assistant .kb-chat-bubble');
        lastBubble = lastBubble[lastBubble.length - 1];
        if (lastBubble) { lastBubble.innerHTML = '<span class="kb-chat-cursor"></span>'; }

        isStreaming = true;
        aiChatSend.disabled = true;

        streamChat([{ role: 'user', content: prompt }], tab);
    };

    // --- Event listeners ---
    aiChatSend.addEventListener('click', sendMessage);

    aiChatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    aiChatInput.addEventListener('input', function () {
        aiChatInput.style.height = 'auto';
        aiChatInput.style.height = Math.min(aiChatInput.scrollHeight, 120) + 'px';
    });

    aiNewTab.addEventListener('click', function () {
        var tab = createTab();
        tab.sectionId = currentSectionId;
    });

    // --- Markdown renderer ---
    function renderMarkdown(text) {
        if (!text) { return ''; }

        text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
            return '<pre><code>' + escapeHtml(code.trim()) + '</code></pre>';
        });

        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

        var blocks = text.split(/\n\n+/);
        var html = '';

        for (var i = 0; i < blocks.length; i++) {
            var block = blocks[i].trim();
            if (!block) { continue; }

            if (/^#{1,6}\s/.test(block)) {
                var level = block.match(/^(#{1,6})\s/)[1].length;
                html += '<h' + level + '>' + block.replace(/^#{1,6}\s/, '') + '</h' + level + '>';
                continue;
            }

            if (/^[-*]\s/m.test(block)) {
                var items = block.split(/\n/).filter(function (l) { return l.trim(); });
                html += '<ul>' + items.map(function (item) {
                    return '<li>' + item.replace(/^[-*]\s+/, '') + '</li>';
                }).join('') + '</ul>';
                continue;
            }

            if (/^\d+\.\s/m.test(block)) {
                var oitems = block.split(/\n/).filter(function (l) { return l.trim(); });
                html += '<ol>' + oitems.map(function (item) {
                    return '<li>' + item.replace(/^\d+\.\s+/, '') + '</li>';
                }).join('') + '</ol>';
                continue;
            }

            if (block.startsWith('<pre>')) {
                html += block;
                continue;
            }

            html += '<p>' + block.replace(/\n/g, '<br>') + '</p>';
        }

        return html;
    }

    window.kbRenderMarkdown = renderMarkdown;

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // --- Init ---
    fetchServerConfig();
    updateConfigToggleState();
    loadTabs();
})();
