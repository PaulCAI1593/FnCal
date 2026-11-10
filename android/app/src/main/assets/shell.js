/*
 * FnCal 安卓外壳 v0.1.0 · 注入脚本
 *
 * 网页里的导出（.ics / JSON 备份 / 诊断包）常是 Blob 下载；WebView 默认的
 * Blob 下载会失败。这里在页面加载时注入，拦截 Blob 链接的点击：
 *   1. 记录 URL.createObjectURL 返回的 mime；
 *   2. 链接 href 以 blob: 开头时，fetch 成字节、转 base64；
 *   3. 调原生 window.FnCalSave.save(name, mime, base64) 写 Downloads/FnCal。
 *
 * 通过 WebView.evaluateJavascript 在 onPageStarted / onPageFinished 注入，
 * 用一个 window 标记防止重复安装。
 *
 * 0.3.8：加 fetch 超时（15 秒）与失败诊断上报（window.FnCalDiag）。
 */
(function () {
    'use strict';

    if (window.__fncalShellInstalled) return;
    window.__fncalShellInstalled = true;

    var mimeByUrl = {};

    var origCreateObjectURL = window.URL && URL.createObjectURL;
    if (typeof origCreateObjectURL === 'function') {
        URL.createObjectURL = function (obj) {
            var url = origCreateObjectURL.call(URL, obj);
            try {
                if (obj && obj.type) mimeByUrl[url] = obj.type;
            } catch (e) {
                /* 记录失败不影响下载 */
            }
            return url;
        };
    }

    /*
     * 0.3.8：请求超时与诊断。
     *
     * 包一层 window.fetch：15 秒没完成就 abort；失败或超时后调
     * window.FnCalDiag.report 写一条诊断（原生侧只留最近 5 条，同一 URL 只留最新）。
     * blob: / data: 只在本机读字节，不是网络请求，直接放行、不记录。
     */
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
            var url = '';
            try {
                url = typeof input === 'string' ? input : (input && input.url) || '';
            } catch (e) {
                url = '';
            }
            if (/^(blob|data|file):/i.test(url)) {
                return origFetch.apply(window, arguments);
            }
            var method = (init && init.method) || (input && input.method) || 'GET';
            var started = Date.now();
            var timedOut = false;
            var cancelled = false;
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = setTimeout(function () {
                timedOut = true;
                if (controller) controller.abort();
            }, 15000);
            var options = {};
            try {
                if (init) {
                    for (var key in init) options[key] = init[key];
                }
            } catch (e) {
                /* 复制失败时用空对象，fetch 仍按默认参数发 */
            }
            if (controller) options.signal = controller.signal;
            var callerSignal = init && init.signal;
            if (callerSignal && typeof callerSignal.addEventListener === 'function') {
                if (callerSignal.aborted) cancelled = true;
                else {
                    callerSignal.addEventListener('abort', function () {
                        cancelled = true;
                        if (controller) controller.abort();
                    });
                }
            }
            function finish() {
                clearTimeout(timer);
            }
            function report(status, message) {
                try {
                    if (window.FnCalDiag && typeof window.FnCalDiag.report === 'function') {
                        window.FnCalDiag.report(
                            JSON.stringify({
                                url: url,
                                method: method,
                                status: status,
                                ms: Date.now() - started,
                                message: message,
                            }),
                        );
                    }
                } catch (e) {
                    /* 原生接口不可用时保持静默 */
                }
            }
            return origFetch
                .call(window, input, options)
                .then(function (response) {
                    finish();
                    if (!response.ok) report(response.status, 'HTTP ' + response.status);
                    return response;
                })
                .catch(function (error) {
                    finish();
                    if (!cancelled) {
                        var message = timedOut
                            ? '请求超时（15 秒）'
                            : (error && error.message) || '网络错误';
                        report(0, message);
                    }
                    throw error;
                });
        };
    }

    function extensionFor(mime) {
        if (!mime) return '.bin';
        if (mime.indexOf('calendar') !== -1) return '.ics';
        if (mime.indexOf('json') !== -1) return '.json';
        if (mime.indexOf('zip') !== -1) return '.zip';
        if (mime.indexOf('pdf') !== -1) return '.pdf';
        if (mime.indexOf('text/') === 0) return '.txt';
        return '.bin';
    }

    function timestamp() {
        var d = new Date();
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    function defaultName(mime) {
        var title = (document.title || 'FnCal').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!title) title = 'FnCal';
        if (title.length > 60) title = title.slice(0, 60);
        return title + '-' + timestamp() + extensionFor(mime);
    }

    function toBase64(buffer) {
        var bytes = new Uint8Array(buffer);
        var chunk = 0x8000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += chunk) {
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
        }
        return window.btoa(parts.join(''));
    }

    function saveBlobUrl(url, name) {
        if (!window.FnCalSave || typeof window.FnCalSave.save !== 'function') return false;
        var mime = mimeByUrl[url] || '';
        window.fetch(url)
            .then(function (response) {
                if (!mime && response.headers) {
                    var header = response.headers.get('content-type');
                    if (header) mime = header.split(';')[0];
                }
                return response.arrayBuffer();
            })
            .then(function (buffer) {
                var base64 = toBase64(buffer);
                window.FnCalSave.save(name || defaultName(mime), mime, base64);
            })
            .catch(function () {
                /* 读不到字节：用空数据回调原生，让原生弹出「保存失败」，避免点了没反应 */
                try {
                    if (window.FnCalSave && typeof window.FnCalSave.save === 'function') {
                        window.FnCalSave.save('', '', '');
                    }
                } catch (e) {
                    /* 原生端不可用时保持静默 */
                }
            });
        return true;
    }

    var origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        try {
            if (this.href && this.href.indexOf('blob:') === 0) {
                if (saveBlobUrl(this.href, this.getAttribute('download') || this.download || '')) {
                    return;
                }
            }
        } catch (e) {
            /* 回到原生点击 */
        }
        return origAnchorClick.apply(this, arguments);
    };

    document.addEventListener(
        'click',
        function (event) {
            var node = event.target;
            while (node && node.nodeName !== 'A') node = node.parentNode;
            if (!node || !node.href || node.href.indexOf('blob:') !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            saveBlobUrl(node.href, node.getAttribute('download') || node.download || '');
        },
        true,
    );
})();
