/* Đa ngôn ngữ dùng chung cho app và Getting Started.
   Chuỗi nằm trong language/<mã>.lang (key=value, "#" là chú thích, "\n" xuống dòng).
   Gắn lên HTML:
     data-i18n="khoá"        -> textContent
     data-i18n-html="khoá"   -> innerHTML (cho chuỗi có <kbd>, <b>...)
     data-i18n-aria="khoá"   -> aria-label + title
     data-i18n-label="khoá"  -> thuộc tính label (md-filter-chip...)
   I18N.ready là Promise xong khi đã nạp file ngôn ngữ. */
(function () {
  var KEY = 'camera.lang', dict = {};
  /* Danh sách ngôn ngữ: [mã (trùng tên file language/<mã>.lang), tên bản ngữ, tên tiếng Anh]. Thêm ngôn ngữ = thêm file .lang + một dòng ở đây */
  var LIST = [
    ['vi', 'Tiếng Việt', 'Vietnamese'], ['en', 'English', 'English'], ['zh-CN', '简体中文', 'Chinese (Simplified)'], ['zh-TW', '繁體中文', 'Chinese (Traditional)'],
    ['ja', '日本語', 'Japanese'], ['ko', '한국어', 'Korean'], ['es', 'Español', 'Spanish'], ['fr', 'Français', 'French'], ['de', 'Deutsch', 'German'],
    ['pt-BR', 'Português (Brasil)', 'Portuguese (Brazil)'], ['ru', 'Русский', 'Russian'], ['id', 'Bahasa Indonesia', 'Indonesian'], ['th', 'ไทย', 'Thai'],
    ['hi', 'हिन्दी', 'Hindi'], ['it', 'Italiano', 'Italian'], ['tr', 'Türkçe', 'Turkish'], ['pl', 'Polski', 'Polish'], ['nl', 'Nederlands', 'Dutch'],
    ['uk', 'Українська', 'Ukrainian'], ['ms', 'Bahasa Melayu', 'Malay']
  ], LANGS = LIST.map(function (l) { return l[0]; });
  var norm = function (s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); };

  /* Chọn ngôn ngữ theo trình duyệt: khớp đúng mã, rồi mã gốc (pt-PT → pt-BR, zh-HK → zh-TW) */
  function fromBrowser() {
    var tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    for (var i = 0; i < tags.length; i++) {
      var tg = String(tags[i]).toLowerCase(), hit = LANGS.filter(function (c) { return c.toLowerCase() === tg; })[0];
      if (!hit && /^zh/.test(tg)) hit = /hant|tw|hk|mo/.test(tg) ? 'zh-TW' : 'zh-CN';
      if (!hit) hit = LANGS.filter(function (c) { return c.toLowerCase().split('-')[0] === tg.split('-')[0]; })[0];
      if (hit) return hit;
    }
    return 'en';
  }

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
    return fromBrowser();
  }

  function detectStored() { try { var s = localStorage.getItem(KEY); return LANGS.indexOf(s) >= 0 ? s : 'auto'; } catch (e) { return 'auto'; } }

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
    list: LIST,
    /* 'auto' = theo thiết bị (không có giá trị đã lưu) */
    pref: (function () { try { return localStorage.getItem(KEY) ? detectStored() : 'auto'; } catch (e) { return 'auto'; } })(),
    /* Tìm ngôn ngữ theo tên bản ngữ / tên tiếng Anh / mã, không phân biệt hoa thường và dấu */
    search: function (q) {
      q = norm(q || '').trim();
      return LIST.filter(function (l) { return !q || norm(l[1]).indexOf(q) >= 0 || norm(l[2]).indexOf(q) >= 0 || norm(l[0]).indexOf(q) >= 0; });
    },
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
      root.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', I18N.t(el.dataset.i18nPh)); });
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
      if (lang !== 'auto' && LANGS.indexOf(lang) < 0) return Promise.resolve();
      try { if (lang === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, lang); } catch (e) { /* bỏ qua */ }
      I18N.pref = lang;
      return I18N.load(lang === 'auto' ? fromBrowser() : lang).then(function () { I18N.apply(); document.dispatchEvent(new CustomEvent('i18n')); });
    }
  };

  I18N.ready = I18N.load(I18N.lang).catch(function () { return I18N.load('vi'); }).then(function () {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { I18N.apply(); });
    else I18N.apply();
  });
})();
