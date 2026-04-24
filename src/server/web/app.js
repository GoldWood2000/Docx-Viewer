(function () {
    'use strict';

    const searchInput = document.getElementById('searchInput');
    const searchStatus = document.getElementById('searchStatus');
    const welcomeView = document.getElementById('welcomeView');
    const resultsView = document.getElementById('resultsView');
    const paginationView = document.getElementById('paginationView');
    const sectionView = document.getElementById('sectionView');
    const sectionContent = document.getElementById('sectionContent');
    const sectionBreadcrumb = document.getElementById('sectionBreadcrumb');
    const backToResults = document.getElementById('backToResults');
    const matchNav = document.getElementById('matchNav');
    const matchInfo = document.getElementById('matchInfo');
    const matchPrev = document.getElementById('matchPrev');
    const matchNext = document.getElementById('matchNext');
    const outlinePanel = document.getElementById('outlinePanel');
    const outlineContent = document.getElementById('outlineContent');
    const outlineToggle = document.getElementById('outlineToggle');
    const themeToggle = document.getElementById('themeToggle');
    const statsInfo = document.getElementById('statsInfo');

    let currentQuery = '';
    let currentPage = 1;
    let lastResults = null;
    let currentMatchIndex = 0;
    let totalMatches = 0;

    // Theme
    function initTheme() {
        const saved = localStorage.getItem('kb-theme');
        if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.body.classList.add('theme-dark');
        }
    }

    themeToggle.addEventListener('click', function () {
        document.body.classList.toggle('theme-dark');
        localStorage.setItem('kb-theme', document.body.classList.contains('theme-dark') ? 'dark' : 'light');
    });

    initTheme();

    // Outline toggle
    outlineToggle.addEventListener('click', function () {
        outlinePanel.classList.toggle('hidden');
        localStorage.setItem('kb-outline', outlinePanel.classList.contains('hidden') ? 'hidden' : 'visible');
    });

    if (localStorage.getItem('kb-outline') === 'hidden') {
        outlinePanel.classList.add('hidden');
    }

    // Load outline
    function buildOutlineTree(items) {
        var root = [];
        var stack = [];

        items.forEach(function (item) {
            var node = { item: item, children: [] };
            while (stack.length > 0 && stack[stack.length - 1].item.heading_level >= item.heading_level) {
                stack.pop();
            }
            if (stack.length > 0) {
                stack[stack.length - 1].children.push(node);
            } else {
                root.push(node);
            }
            stack.push(node);
        });

        return root;
    }

    function renderOutlineNodes(nodes) {
        var html = '';
        nodes.forEach(function (node) {
            var item = node.item;
            var hasChildren = node.children.length > 0;
            var level = item.heading_level;

            if (hasChildren) {
                html += '<div class="kb-outline-group">';
                html += '<div class="kb-outline-parent level-' + level + '" data-id="' + item.id + '">';
                html += '<svg class="kb-outline-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
                html += '<span class="kb-outline-label" title="' + escapeHtml(item.heading) + '">' + escapeHtml(item.heading) + '</span>';
                html += '</div>';
                html += '<div class="kb-outline-children">';
                html += renderOutlineNodes(node.children);
                html += '</div>';
                html += '</div>';
            } else {
                html += '<div class="kb-outline-item level-' + level + '" data-id="' + item.id + '" title="' + escapeHtml(item.heading) + '">' +
                    escapeHtml(item.heading) + '</div>';
            }
        });
        return html;
    }

    function loadOutline() {
        fetch('/api/outline')
            .then(function (r) { return r.json(); })
            .then(function (items) {
                var tree = buildOutlineTree(items);
                outlineContent.innerHTML = renderOutlineNodes(tree);

                var saved = {};
                try { saved = JSON.parse(localStorage.getItem('kb-outline-state') || '{}'); } catch (e) { /* ignore */ }
                outlineContent.querySelectorAll('.kb-outline-group').forEach(function (group) {
                    var parent = group.querySelector('.kb-outline-parent');
                    var parentId = parent.getAttribute('data-id');
                    var level = parseInt(parent.className.match(/level-(\d)/)?.[1] || '1');
                    if (parentId in saved) {
                        if (!saved[parentId]) { group.classList.add('collapsed'); }
                    } else if (level >= 2) {
                        group.classList.add('collapsed');
                    }
                });

                outlineContent.addEventListener('click', function (e) {
                    var arrow = e.target.closest('.kb-outline-arrow');
                    var parent = e.target.closest('.kb-outline-parent');
                    if (arrow && parent) {
                        var group = parent.parentElement;
                        group.classList.toggle('collapsed');
                        saveOutlineState();
                        e.stopPropagation();
                        return;
                    }
                    if (parent) {
                        var id = parent.getAttribute('data-id');
                        loadSection(parseInt(id));
                        return;
                    }
                    var target = e.target.closest('.kb-outline-item');
                    if (target) {
                        var id = target.getAttribute('data-id');
                        loadSection(parseInt(id));
                    }
                });
            });
    }

    function saveOutlineState() {
        var state = {};
        outlineContent.querySelectorAll('.kb-outline-group').forEach(function (group) {
            var parentId = group.querySelector('.kb-outline-parent').getAttribute('data-id');
            state[parentId] = !group.classList.contains('collapsed');
        });
        localStorage.setItem('kb-outline-state', JSON.stringify(state));
    }

    // Load stats
    function loadStats() {
        fetch('/api/stats')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.total_sections) {
                    statsInfo.textContent = data.total_sections + ' sections';
                }
            });
    }

    // Search
    var searchTimer = null;

    searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            var q = searchInput.value.trim();
            if (q.length >= 1) {
                currentQuery = q;
                currentPage = 1;
                performSearch(q, 1);
            } else {
                showWelcome();
            }
        }, 300);
    });

    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            clearTimeout(searchTimer);
            var q = searchInput.value.trim();
            if (q.length >= 1) {
                currentQuery = q;
                currentPage = 1;
                performSearch(q, 1);
            }
        }
        if (e.key === 'Escape') {
            searchInput.value = '';
            showWelcome();
        }
    });

    function performSearch(query, page) {
        var startTime = performance.now();

        fetch('/api/search?q=' + encodeURIComponent(query) + '&page=' + page + '&limit=20')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var elapsed = (performance.now() - startTime).toFixed(0);
                lastResults = data;
                currentPage = page;

                if (data.error) {
                    searchStatus.innerHTML = '<span style="color:var(--fg-secondary)">Search error: ' + escapeHtml(data.error) + '</span>';
                    return;
                }

                searchStatus.innerHTML = 'Found <span class="count">' + data.total + '</span> results ' +
                    '<span class="time">(' + elapsed + 'ms)</span>' +
                    (data.searchMode === 'hybrid' ? ' <span class="kb-search-mode">混合搜索</span>' : '');

                showResults(data);
            })
            .catch(function () {
                searchStatus.textContent = 'Search failed. Please try again.';
            });
    }

    function showWelcome() {
        welcomeView.style.display = '';
        resultsView.style.display = 'none';
        paginationView.style.display = 'none';
        sectionView.style.display = 'none';
        searchStatus.innerHTML = '';
        lastResults = null;
    }

    function showResults(data) {
        welcomeView.style.display = 'none';
        sectionView.style.display = 'none';
        resultsView.style.display = '';

        var hasQA = data.qaResults && data.qaResults.length > 0;
        var hasSections = data.results && data.results.length > 0;

        if (!hasQA && !hasSections) {
            resultsView.innerHTML = '<div class="kb-welcome"><p>No results found. Try a different keyword.</p></div>';
            paginationView.style.display = 'none';
            return;
        }

        var html = '';

        if (hasQA) {
            html += '<div class="kb-qa-section">';
            html += '<div class="kb-qa-section-header">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
                ' Cached AI Answers' +
                '</div>';
            data.qaResults.forEach(function (qa) {
                html += '<div class="kb-result-card kb-qa-card" data-qa-id="' + qa.id + '">' +
                    '<div class="kb-qa-card-header">' +
                    '<span class="kb-qa-badge">QA</span>' +
                    '<span class="kb-qa-question">' + escapeHtml(qa.question) + '</span>' +
                    '<button class="kb-qa-delete" data-qa-delete="' + qa.id + '" title="Delete">&times;</button>' +
                    '</div>' +
                    '<div class="kb-result-snippet">' + escapeHtml((qa.answer || '').substring(0, 200)) + (qa.answer && qa.answer.length > 200 ? '...' : '') + '</div>' +
                    '<div class="kb-result-breadcrumb">' + escapeHtml(qa.created_at || '') + '</div>' +
                    '</div>';
            });
            html += '</div>';
        }

        if (hasSections) {
            var processKeywords = ['流程', '步骤', '操作', '方法', '指南', '教程', '配置', '设置', '如何', '怎么', '办理'];
            var processResults = [];
            var faqResults = [];

            data.results.forEach(function (r) {
                var text = (r.heading || '') + ' ' + (r.parent_heading || '');
                var isProcess = processKeywords.some(function (kw) { return text.indexOf(kw) !== -1; });
                if (isProcess) { processResults.push(r); } else { faqResults.push(r); }
            });

            function renderCards(list) {
                return list.map(function (r) {
                    var breadcrumb = r.parent_heading
                        ? '<span>' + escapeHtml(r.parent_heading) + '</span> &rsaquo; ' + escapeHtml(r.heading)
                        : escapeHtml(r.heading);
                    var badge = '';
                    if (r.match_type === 'semantic') {
                        badge = '<span class="kb-match-badge kb-match-semantic" title="语义匹配">语义</span>';
                    } else if (r.match_type === 'both') {
                        badge = '<span class="kb-match-badge kb-match-both" title="关键词+语义匹配">混合</span>';
                    } else if (r.match_type === 'keyword') {
                        badge = '<span class="kb-match-badge kb-match-keyword" title="关键词匹配">关键词</span>';
                    }
                    return '<div class="kb-result-card" data-id="' + r.id + '">' +
                        '<div class="kb-result-heading">' + badge + escapeHtml(r.heading) + '</div>' +
                        '<div class="kb-result-breadcrumb">' + breadcrumb + '</div>' +
                        '<div class="kb-result-snippet">' + (r.snippet || '') + '</div>' +
                        '</div>';
                }).join('');
            }

            if (faqResults.length > 0) {
                html += '<div class="kb-category-section">' +
                    '<div class="kb-category-header">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></svg>' +
                    ' 常见问题 <span class="kb-category-count">' + faqResults.length + '</span>' +
                    '</div>' +
                    renderCards(faqResults) +
                    '</div>';
            }

            if (processResults.length > 0) {
                html += '<div class="kb-category-section">' +
                    '<div class="kb-category-header">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
                    ' 流程 <span class="kb-category-count">' + processResults.length + '</span>' +
                    '</div>' +
                    renderCards(processResults) +
                    '</div>';
            }
        }

        resultsView.innerHTML = html;

        // QA card click handlers
        if (hasQA) {
            var qaData = data.qaResults;
            resultsView.querySelectorAll('.kb-qa-card').forEach(function (card) {
                card.addEventListener('click', function () {
                    var qaId = card.getAttribute('data-qa-id');
                    var qa = qaData.find(function (q) { return String(q.id) === qaId; });
                    if (qa) { showQaDetail(qa); }
                });
            });

            resultsView.querySelectorAll('.kb-qa-delete').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var qaId = btn.getAttribute('data-qa-delete');
                    if (confirm('Delete this cached answer?')) {
                        fetch('/api/qa/' + qaId, { method: 'DELETE' })
                            .then(function () { performSearch(currentQuery, currentPage); })
                            .catch(function () { /* best-effort */ });
                    }
                });
            });
        }

        // Section card click handlers
        resultsView.querySelectorAll('.kb-result-card:not(.kb-qa-card)').forEach(function (card) {
            card.addEventListener('click', function () {
                var id = parseInt(card.getAttribute('data-id'));
                loadSection(id);
            });
        });

        renderPagination(data);
    }

    function renderPagination(data) {
        if (data.totalPages <= 1) {
            paginationView.style.display = 'none';
            return;
        }

        paginationView.style.display = '';
        var html = '';

        html += '<button class="kb-page-btn" ' + (data.page <= 1 ? 'disabled' : '') +
            ' data-page="' + (data.page - 1) + '">Prev</button>';

        var start = Math.max(1, data.page - 2);
        var end = Math.min(data.totalPages, data.page + 2);

        for (var i = start; i <= end; i++) {
            html += '<button class="kb-page-btn' + (i === data.page ? ' active' : '') +
                '" data-page="' + i + '">' + i + '</button>';
        }

        html += '<span class="kb-page-info">' + data.page + ' / ' + data.totalPages + '</span>';

        html += '<button class="kb-page-btn" ' + (data.page >= data.totalPages ? 'disabled' : '') +
            ' data-page="' + (data.page + 1) + '">Next</button>';

        paginationView.innerHTML = html;

        paginationView.querySelectorAll('.kb-page-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (!btn.disabled) {
                    var p = parseInt(btn.getAttribute('data-page'));
                    performSearch(currentQuery, p);
                    document.querySelector('.kb-main').scrollTo(0, 0);
                }
            });
        });
    }

    function loadSection(id) {
        welcomeView.style.display = 'none';
        resultsView.style.display = 'none';
        paginationView.style.display = 'none';
        sectionView.style.display = '';
        sectionContent.innerHTML = '<div class="kb-loading"><div class="kb-spinner"></div>Loading...</div>';

        fetch('/api/section/' + id)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.error) {
                    sectionContent.innerHTML = '<p>Error: ' + escapeHtml(data.error) + '</p>';
                    return;
                }

                var crumb = data.parent_heading
                    ? '<span>' + escapeHtml(data.parent_heading) + '</span> &rsaquo; ' + escapeHtml(data.heading)
                    : '<span>' + escapeHtml(data.heading) + '</span>';
                sectionBreadcrumb.innerHTML = crumb;

                var html = data.html_content;
                if (currentQuery) {
                    html = highlightText(html, currentQuery);
                }
                sectionContent.innerHTML = html;
                externalizeLinks(sectionContent);

                outlineContent.querySelectorAll('.kb-outline-item, .kb-outline-parent').forEach(function (item) {
                    item.classList.toggle('active', parseInt(item.getAttribute('data-id')) === id);
                });

                var activeEl = outlineContent.querySelector('.kb-outline-item.active, .kb-outline-parent.active');
                if (activeEl) {
                    var group = activeEl.closest('.kb-outline-group');
                    var changed = false;
                    while (group) {
                        if (group.classList.contains('collapsed')) {
                            group.classList.remove('collapsed');
                            changed = true;
                        }
                        group = group.parentElement ? group.parentElement.closest('.kb-outline-group') : null;
                    }
                    if (changed) { saveOutlineState(); }
                    activeEl.scrollIntoView({ block: 'nearest' });
                }

                var marks = sectionContent.querySelectorAll('mark');
                totalMatches = marks.length;
                currentMatchIndex = 0;

                if (totalMatches > 0 && currentQuery) {
                    matchNav.style.display = '';
                    navigateToMatch(0);
                } else {
                    matchNav.style.display = 'none';
                }

                if (currentQuery && window.kbShowAiPanel) {
                    window.kbShowAiPanel(currentQuery, id);
                }
            });
    }

    window.kbLoadSection = loadSection;

    function showQaDetail(qa) {
        welcomeView.style.display = 'none';
        resultsView.style.display = 'none';
        paginationView.style.display = 'none';
        sectionView.style.display = '';
        matchNav.style.display = 'none';

        sectionBreadcrumb.innerHTML = '<span class="kb-qa-badge">QA</span> ' + escapeHtml(qa.question);

        var answerHtml = window.kbRenderMarkdown ? window.kbRenderMarkdown(qa.answer) : escapeHtml(qa.answer);
        var html = '<div class="kb-qa-answer">' + answerHtml + '</div>';
        if (qa.section_id) {
            html += '<div class="kb-qa-source"><button class="kb-back-btn" id="qaViewSource">View source section</button></div>';
        }
        html += '<div style="margin-top:12px;font-size:12px;color:var(--fg-secondary)">' + escapeHtml(qa.created_at || '') + '</div>';
        sectionContent.innerHTML = html;
        externalizeLinks(sectionContent);

        if (qa.section_id) {
            var btn = document.getElementById('qaViewSource');
            if (btn) {
                btn.addEventListener('click', function () {
                    loadSection(qa.section_id);
                });
            }
        }

        if (window.kbHideAiPanel) { window.kbHideAiPanel(); }
    }

    // Selection-to-AI tooltip
    var selTooltip = document.getElementById('selectionTooltip');
    var selAskBtn = document.getElementById('selAskAi');
    var selectedText = '';

    document.addEventListener('mouseup', function (e) {
        var sel = window.getSelection();
        var text = sel ? sel.toString().trim() : '';
        var sectionDoc = document.querySelector('.kb-section-doc');

        if (text.length > 2 && sectionDoc && sectionDoc.contains(sel.anchorNode)) {
            selectedText = text;
            var range = sel.getRangeAt(0);
            var rect = range.getBoundingClientRect();
            selTooltip.style.left = (rect.left + rect.width / 2 - 50) + 'px';
            selTooltip.style.top = (rect.bottom + 6) + 'px';
            selTooltip.style.display = '';
        } else if (!e.target.closest('.kb-sel-tooltip')) {
            selTooltip.style.display = 'none';
        }
    });

    selAskBtn.addEventListener('click', function () {
        if (selectedText && window.kbAskAboutSelection) {
            window.kbAskAboutSelection(selectedText);
        }
        selTooltip.style.display = 'none';
        window.getSelection().removeAllRanges();
    });

    document.addEventListener('mousedown', function (e) {
        if (!e.target.closest('.kb-sel-tooltip')) {
            selTooltip.style.display = 'none';
        }
    });

    function navigateToMatch(index) {
        var marks = sectionContent.querySelectorAll('mark');
        if (marks.length === 0) { return; }

        // Clamp index
        if (index < 0) { index = marks.length - 1; }
        if (index >= marks.length) { index = 0; }
        currentMatchIndex = index;

        // Remove previous current-match class
        var prev = sectionContent.querySelector('mark.current-match');
        if (prev) { prev.classList.remove('current-match'); }

        // Add current-match class for pulse effect
        var target = marks[index];
        target.classList.add('current-match');

        // Update match info
        matchInfo.innerHTML = '<span class="current">' + (index + 1) + '</span> / ' + marks.length;

        var scrollEl = document.querySelector('.kb-section-doc') || document.querySelector('.kb-main');
        requestAnimationFrame(function () {
            var markRect = target.getBoundingClientRect();
            var scrollRect = scrollEl.getBoundingClientRect();
            scrollEl.scrollTo({
                top: scrollEl.scrollTop + (markRect.top - scrollRect.top) - scrollRect.height / 3,
                behavior: 'smooth'
            });
        });
    }

    matchPrev.addEventListener('click', function () {
        navigateToMatch(currentMatchIndex - 1);
    });

    matchNext.addEventListener('click', function () {
        navigateToMatch(currentMatchIndex + 1);
    });

    backToResults.addEventListener('click', function () {
        matchNav.style.display = 'none';
        if (window.kbHideAiPanel) { window.kbHideAiPanel(); }
        if (lastResults) {
            sectionView.style.display = 'none';
            resultsView.style.display = '';
            paginationView.style.display = '';
            outlineContent.querySelectorAll('.kb-outline-item.active, .kb-outline-parent.active').forEach(function (el) {
                el.classList.remove('active');
            });
        } else {
            showWelcome();
        }
    });

    function highlightText(html, query) {
        if (!query) { return html; }
        var parts = [];
        var inTag = false;
        var textStart = 0;

        for (var i = 0; i < html.length; i++) {
            if (html[i] === '<') {
                if (!inTag && i > textStart) {
                    parts.push(highlightInText(html.substring(textStart, i), query));
                }
                inTag = true;
                textStart = i;
            } else if (html[i] === '>' && inTag) {
                parts.push(html.substring(textStart, i + 1));
                inTag = false;
                textStart = i + 1;
            }
        }
        if (textStart < html.length) {
            if (inTag) {
                parts.push(html.substring(textStart));
            } else {
                parts.push(highlightInText(html.substring(textStart), query));
            }
        }
        return parts.join('');
    }

    function highlightInText(text, query) {
        var lower = text.toLowerCase();
        var qLower = query.toLowerCase();
        var result = '';
        var lastIdx = 0;
        var idx = lower.indexOf(qLower);

        while (idx !== -1) {
            result += escapeHtml(text.substring(lastIdx, idx));
            result += '<mark>' + escapeHtml(text.substring(idx, idx + query.length)) + '</mark>';
            lastIdx = idx + query.length;
            idx = lower.indexOf(qLower, lastIdx);
        }
        result += escapeHtml(text.substring(lastIdx));
        return result;
    }

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function externalizeLinks(container) {
        container.querySelectorAll('a[href]').forEach(function (a) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });
    }

    // Lightbox with zoom/pan
    var lightbox = document.getElementById('lightbox');
    var lightboxImg = document.getElementById('lightboxImg');
    var lbViewport = document.getElementById('lbViewport');
    var lbZoomLevel = document.getElementById('lbZoomLevel');
    var lbZoomIn = document.getElementById('lbZoomIn');
    var lbZoomOut = document.getElementById('lbZoomOut');
    var lbReset = document.getElementById('lbReset');
    var lbClose = document.getElementById('lbClose');

    var lb = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, minScale: 0.1, maxScale: 10 };

    function lbUpdateTransform() {
        lightboxImg.style.transform = 'translate(' + lb.x + 'px, ' + lb.y + 'px) scale(' + lb.scale + ')';
        lbZoomLevel.textContent = Math.round(lb.scale * 100) + '%';
    }

    function lbFitImage() {
        var vw = lbViewport.clientWidth;
        var vh = lbViewport.clientHeight;
        var iw = lightboxImg.naturalWidth || 800;
        var ih = lightboxImg.naturalHeight || 600;
        var fitScale = Math.min(vw * 0.9 / iw, vh * 0.9 / ih, 1);
        lb.scale = fitScale;
        lb.x = (vw - iw * fitScale) / 2;
        lb.y = (vh - ih * fitScale) / 2;
        lbUpdateTransform();
    }

    function openLightbox(src) {
        lightboxImg.src = src;
        lightbox.classList.add('visible');
        if (lightboxImg.complete && lightboxImg.naturalWidth) {
            lbFitImage();
        }
    }

    lightboxImg.addEventListener('load', function () {
        if (lightbox.classList.contains('visible')) {
            lbFitImage();
        }
    });

    function closeLightbox() {
        lightbox.classList.remove('visible');
        lightboxImg.src = '';
        lb.scale = 1; lb.x = 0; lb.y = 0;
    }

    function lbZoomTo(newScale, cx, cy) {
        newScale = Math.max(lb.minScale, Math.min(lb.maxScale, newScale));
        var ratio = newScale / lb.scale;
        lb.x = cx - ratio * (cx - lb.x);
        lb.y = cy - ratio * (cy - lb.y);
        lb.scale = newScale;
        lbUpdateTransform();
    }

    // Scroll wheel zoom (zoom toward cursor)
    lbViewport.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = lbViewport.getBoundingClientRect();
        var cx = e.clientX - rect.left;
        var cy = e.clientY - rect.top;
        var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        lbZoomTo(lb.scale * factor, cx, cy);
    }, { passive: false });

    // Drag to pan
    lbViewport.addEventListener('mousedown', function (e) {
        if (e.button !== 0) { return; }
        lb.dragging = true;
        lb.startX = e.clientX;
        lb.startY = e.clientY;
        lb.origX = lb.x;
        lb.origY = lb.y;
        lbViewport.classList.add('dragging');
        e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
        if (!lb.dragging) { return; }
        lb.x = lb.origX + (e.clientX - lb.startX);
        lb.y = lb.origY + (e.clientY - lb.startY);
        lbUpdateTransform();
    });

    document.addEventListener('mouseup', function () {
        if (lb.dragging) {
            lb.dragging = false;
            lbViewport.classList.remove('dragging');
        }
    });

    // Touch: pinch zoom + drag
    var lbTouches = { dist: 0, scale: 1, cx: 0, cy: 0, x: 0, y: 0 };

    lbViewport.addEventListener('touchstart', function (e) {
        if (e.touches.length === 1) {
            lb.dragging = true;
            lb.startX = e.touches[0].clientX;
            lb.startY = e.touches[0].clientY;
            lb.origX = lb.x;
            lb.origY = lb.y;
        } else if (e.touches.length === 2) {
            lb.dragging = false;
            var dx = e.touches[0].clientX - e.touches[1].clientX;
            var dy = e.touches[0].clientY - e.touches[1].clientY;
            lbTouches.dist = Math.hypot(dx, dy);
            lbTouches.scale = lb.scale;
            var rect = lbViewport.getBoundingClientRect();
            lbTouches.cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            lbTouches.cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            lbTouches.x = lb.x;
            lbTouches.y = lb.y;
        }
        e.preventDefault();
    }, { passive: false });

    lbViewport.addEventListener('touchmove', function (e) {
        if (e.touches.length === 1 && lb.dragging) {
            lb.x = lb.origX + (e.touches[0].clientX - lb.startX);
            lb.y = lb.origY + (e.touches[0].clientY - lb.startY);
            lbUpdateTransform();
        } else if (e.touches.length === 2) {
            var dx = e.touches[0].clientX - e.touches[1].clientX;
            var dy = e.touches[0].clientY - e.touches[1].clientY;
            var newDist = Math.hypot(dx, dy);
            var newScale = lbTouches.scale * (newDist / lbTouches.dist);
            lbZoomTo(newScale, lbTouches.cx, lbTouches.cy);
        }
        e.preventDefault();
    }, { passive: false });

    lbViewport.addEventListener('touchend', function () {
        lb.dragging = false;
    });

    // Toolbar buttons
    lbZoomIn.addEventListener('click', function () {
        var rect = lbViewport.getBoundingClientRect();
        lbZoomTo(lb.scale * 1.3, rect.width / 2, rect.height / 2);
    });

    lbZoomOut.addEventListener('click', function () {
        var rect = lbViewport.getBoundingClientRect();
        lbZoomTo(lb.scale / 1.3, rect.width / 2, rect.height / 2);
    });

    lbReset.addEventListener('click', lbFitImage);
    lbClose.addEventListener('click', closeLightbox);

    // Close on backdrop click (not on image/toolbar)
    lightbox.querySelector('.kb-lightbox-backdrop').addEventListener('click', closeLightbox);

    // Double-click to toggle between fit and 100%
    lbViewport.addEventListener('dblclick', function (e) {
        var rect = lbViewport.getBoundingClientRect();
        var cx = e.clientX - rect.left;
        var cy = e.clientY - rect.top;
        if (Math.abs(lb.scale - 1) > 0.05) {
            lbZoomTo(1, cx, cy);
        } else {
            lbFitImage();
        }
    });

    document.addEventListener('click', function (e) {
        var img = e.target.closest('.kb-document img');
        if (img && img.src) {
            e.stopPropagation();
            openLightbox(img.src);
        }
    });

    // Keyboard shortcuts (after lightbox is defined)
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
        if (e.key === 'Escape') {
            closeLightbox();
        }
        // +/- to zoom in lightbox
        if (lightbox.classList.contains('visible')) {
            var rect = lbViewport.getBoundingClientRect();
            var cx = rect.width / 2;
            var cy = rect.height / 2;
            if (e.key === '=' || e.key === '+') { lbZoomTo(lb.scale * 1.2, cx, cy); }
            if (e.key === '-') { lbZoomTo(lb.scale / 1.2, cx, cy); }
            if (e.key === '0') { lbFitImage(); }
        }
    });

    // Init
    loadOutline();
    loadStats();
})();
