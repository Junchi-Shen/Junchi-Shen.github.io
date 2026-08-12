/* Shared site behaviour: the bilingual switch.
   The design exposes `language` as an authoring prop (bilingual | en | zh);
   on the live site the same three modes are user-selectable and remembered. */
(function () {
  var MODES = ['bilingual', 'en', 'zh'];
  var KEY = 'js-lang';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : 'bilingual';
    } catch (e) { return 'bilingual'; }
  }

  function apply(mode) {
    document.documentElement.dataset.lang = mode;
    document.documentElement.lang = mode === 'zh' ? 'zh' : 'en';
    document.querySelectorAll('[data-lang-set]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.langSet === mode));
    });
  }

  function set(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    apply(mode);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-lang-set]');
    if (btn) set(btn.dataset.langSet);
  });

  apply(read());
  window.siteLang = { get: read, set: set };
})();
