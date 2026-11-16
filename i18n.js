/* Đa ngôn ngữ dùng chung cho app và Getting Started.
   Chuỗi nằm trong language/<mã>.lang (key=value, "#" là chú thích, "\n" xuống dòng).
   Gắn lên HTML:
     data-i18n="khoá"        -> textContent
     data-i18n-html="khoá"   -> innerHTML (cho chuỗi có <kbd>, <b>...)
     data-i18n-aria="khoá"   -> aria-label + title
     data-i18n-label="khoá"  -> thuộc tính label (md-filter-chip...)
   I18N.ready là Promise xong khi đã nạp file ngôn ngữ. */
(function () {
  var KEY = 'camera.lang', LANGS = ['vi', 'en'], dict = {};

  function detect() {
    try {
      /* Người dùng bản cũ (vietnamese.html / english.html): giữ lại lựa chọn */
      var old = localStorage.getItem('preferredLang');
      if (old) {
        localStorage.removeItem('preferredLang');
        var l = /^english/.test(old) ? 'en' : 'vi';
        localStorage.setItem(KEY, l);
        return l;
      }
      var s = localStorage.getItem(KEY);
      if (LANGS.indexOf(s) >= 0) return s;
    } catch (e) { /* bỏ qua */ }
    return /^vi/i.test(navigator.language || '') ? 'vi' : 'en';
  }

  function parse(text) {
    var out = {};
    text.split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf('=');
      if (i < 1 || /^\s*#/.test(line)) return;
      out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/\\n/g, '\n');
    });
    return out;
  }

  var I18N = window.I18N = {
    lang: detect(),
    langs: LANGS,
    t: function (key, vars) {
      var s = dict[key];
      if (s === undefined) return key;
      return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? vars[k] : m; }) : s;
    },
    apply: function (root) {
      root = root || document;
      document.documentElement.lang = I18N.lang;
      root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = I18N.t(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = I18N.t(el.dataset.i18nHtml); });
      root.querySelectorAll('[data-i18n-label]').forEach(function (el) { el.setAttribute('label', I18N.t(el.dataset.i18nLabel)); });
      root.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
        var s = I18N.t(el.dataset.i18nAria);
        el.setAttribute('aria-label', s); el.setAttribute('title', s);
      });
    },
    load: function (lang) {
      return fetch('language/' + lang + '.lang').then(function (r) {
        if (!r.ok) throw new Error('lang ' + r.status);
        return r.text();
      }).then(function (txt) { dict = parse(txt); I18N.lang = lang; });
    },
    /* Đổi ngôn ngữ, lưu lại và áp dụng ngay (không cần tải lại trang) */
    set: function (lang) {
      if (LANGS.indexOf(lang) < 0) return Promise.resolve();
      try { localStorage.setItem(KEY, lang); } catch (e) { /* bỏ qua */ }
      return I18N.load(lang).then(function () { I18N.apply(); document.dispatchEvent(new CustomEvent('i18n')); });
    }
  };

  I18N.ready = I18N.load(I18N.lang).catch(function () { return I18N.load('vi'); }).then(function () {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { I18N.apply(); });
    else I18N.apply();
  });
})();
