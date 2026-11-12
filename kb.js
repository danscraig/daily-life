/* Keyboard helper for every page: while a text field has focus the bottom bar steps aside (class "kb" on <html>),
   and the field is scrolled into the part of the screen the keyboard leaves free, so what you type is never behind it. */
(function () {
  if (!window.matchMedia || !matchMedia('(pointer: coarse)').matches) return;
  var root = document.documentElement, inFrame = window.parent !== window;
  function isField(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|file|color|image|reset)$/.test(el.type || 'text');
  }
  function visibleBottom() {   // lowest visible y, in this window's own coordinates
    try {
      if (inFrame && window.frameElement && parent.visualViewport) {
        var p = parent.visualViewport, r = window.frameElement.getBoundingClientRect();
        return Math.min(window.innerHeight, p.offsetTop + p.height - r.top);
      }
    } catch (e) {}
    var v = window.visualViewport;
    return v ? v.offsetTop + v.height : window.innerHeight;
  }
  function reveal() {
    var el = document.activeElement;
    if (!isField(el) || el.isContentEditable) return;   // the notes editor follows its own caret
    var r = el.getBoundingClientRect(), vb = visibleBottom();
    if (r.height > vb * 0.5) return;   // tall boxes scroll their own caret
    var over = r.bottom + 18 - vb;
    if (over > 0) window.scrollBy(0, over);
    else if (r.top < 70) window.scrollBy(0, r.top - 90);
  }
  function mark() { root.classList.toggle('kb', isField(document.activeElement)); }
  document.addEventListener('focusin', function () {
    mark();
    [0, 120, 350, 700].forEach(function (ms) { setTimeout(reveal, ms); });
  });
  document.addEventListener('focusout', function () { setTimeout(mark, 60); });
  window.addEventListener('resize', function () { reveal(); });
  try { if (inFrame && parent.visualViewport) parent.visualViewport.addEventListener('resize', function () { setTimeout(reveal, 60); }); } catch (e) {}
})();
