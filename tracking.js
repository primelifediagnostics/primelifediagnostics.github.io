/*!
 * Prime Life Diagnostics - cookie consent + Google tracking
 * One file, loaded from the <head> of every page: <script src="/tracking.js"></script>
 *
 * What it does
 *  1. Sets Google Consent Mode to "denied" by default (nothing is sent to Google).
 *  2. Shows a cookie banner with equally prominent Accept / Reject buttons.
 *  3. Only after the visitor accepts does it load Google Analytics (GA4) and Google Ads.
 *  4. Records these events (only for visitors who accepted):
 *       phone_click, whatsapp_click, email_click, booking_click,
 *       booking_widget_interaction (visitor clicked inside the Setmore booking form),
 *       booking_complete (fired by thank-you.html)
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * SETTINGS
   * ------------------------------------------------------------- */
  var GA_ID = 'G-JRCSHS3V6T';
  var ADS_ID = 'AW-18295000895';

  // OPTIONAL: Google Ads conversion labels.
  // In Google Ads: Goals > Conversions > your conversion action > Tag setup > "Use Google Tag Manager / install the tag yourself"
  // Copy the part AFTER the slash in  AW-18295000895/XXXXXXXX  and paste it between the quotes.
  // Leave '' to skip (you can instead import GA4 key events into Google Ads).
  var ADS_LABELS = {
    phone_click: '',
    whatsapp_click: '',
    booking_complete: ''
  };

  var CONSENT_KEY = 'pld_consent_v1';

  /* ---------------------------------------------------------------
   * GOOGLE TAG SETUP (consent defaults to denied)
   * ------------------------------------------------------------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied'
  });

  var granted = false;
  var loaded = false;
  var waiting = [];
  var widgetSeen = false;

  function readChoice() {
    try { return window.localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function saveChoice(value) {
    try { window.localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* ignore */ }
  }

  function clearGoogleCookies() {
    var host = window.location.hostname.replace(/^www\./, '');
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].replace(/^\s+/, '');
      if (/^(_ga|_gid|_gat|_gcl|_gac|_gu)/.test(name)) {
        [null, host, '.' + host].forEach(function (domain) {
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' +
            (domain ? '; domain=' + domain : '');
        });
      }
    });
  }

  function grantAndLoad() {
    granted = true;
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted'
    });

    if (!loaded) {
      loaded = true;
      gtag('js', new Date());
      gtag('config', GA_ID);
      gtag('config', ADS_ID);

      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
      document.head.appendChild(s);
    }

    var queued = waiting.slice();
    waiting.length = 0;
    queued.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
  }

  function deny() {
    var wasGranted = granted;
    granted = false;
    gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied'
    });
    if (wasGranted) { clearGoogleCookies(); }
  }

  /* ---------------------------------------------------------------
   * PUBLIC HELPERS
   * ------------------------------------------------------------- */
  // pldTrack('event_name', { any: 'params' }, 'optionalAdsLabelKey')
  function track(name, params, labelKey) {
    if (!granted) { return; }
    gtag('event', name, params || {});
    var label = ADS_LABELS[labelKey || name];
    if (label) {
      gtag('event', 'conversion', { send_to: ADS_ID + '/' + label });
    }
  }
  window.pldTrack = track;

  // Run something once the visitor has accepted cookies (immediately if they already have).
  window.pldWhenTracking = function (fn) {
    if (granted) { fn(); } else { waiting.push(fn); }
  };

  window.pldCookieSettings = function () { showBanner(true); };

  /* ---------------------------------------------------------------
   * BANNER
   * ------------------------------------------------------------- */
  function showBanner(force) {
    if (document.getElementById('pld-consent')) { return; }
    if (!document.body) { return; }

    var css = document.createElement('style');
    css.id = 'pld-consent-css';
    css.textContent =
      '#pld-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;' +
      'max-width:760px;margin:0 auto;background:#fff;color:#102a43;border:1px solid #d9e2ec;' +
      'border-radius:14px;box-shadow:0 10px 40px rgba(16,42,67,.25);padding:18px 20px;' +
      'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
      '#pld-consent h2{margin:0 0 6px;font-size:16px;font-weight:700;color:#102a43}' +
      '#pld-consent p{margin:0 0 14px;color:#486581}' +
      '#pld-consent .pld-row{display:flex;gap:10px;flex-wrap:wrap}' +
      '#pld-consent button{flex:1 1 140px;min-height:44px;padding:10px 18px;border-radius:10px;' +
      'font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;border:2px solid #1769aa}' +
      '#pld-consent .pld-accept{background:#1769aa;color:#fff}' +
      '#pld-consent .pld-reject{background:#fff;color:#1769aa}' +
      '#pld-consent button:focus-visible{outline:3px solid #f0b429;outline-offset:2px}';
    document.head.appendChild(css);

    var box = document.createElement('div');
    box.id = 'pld-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookie preferences');
    box.innerHTML =
      '<h2>Cookies on our website</h2>' +
      '<p>We use analytics and advertising cookies to understand how our website is used and ' +
      'how our adverts perform. They are only set if you accept. You can change your choice ' +
      'at any time using &ldquo;Cookie settings&rdquo; at the bottom of any page.</p>' +
      '<div class="pld-row">' +
      '<button type="button" class="pld-accept">Accept cookies</button>' +
      '<button type="button" class="pld-reject">Reject cookies</button>' +
      '</div>';
    document.body.appendChild(box);

    function close() {
      if (box.parentNode) { box.parentNode.removeChild(box); }
    }

    box.querySelector('.pld-accept').addEventListener('click', function () {
      saveChoice('granted');
      grantAndLoad();
      close();
    });

    box.querySelector('.pld-reject').addEventListener('click', function () {
      saveChoice('denied');
      deny();
      close();
    });

    if (force) {
      var first = box.querySelector('.pld-accept');
      if (first && first.focus) { first.focus(); }
    }
  }

  function addFooterLink() {
    var footer = document.querySelector('footer');
    if (!footer || document.getElementById('pld-cookie-link')) { return; }
    var wrap = document.createElement('div');
    wrap.id = 'pld-cookie-link';
    wrap.style.cssText = 'text-align:center;padding:12px 16px;font-size:13px';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Cookie settings';
    btn.style.cssText = 'background:none;border:0;padding:0;color:inherit;font:inherit;' +
      'text-decoration:underline;cursor:pointer;opacity:.8';
    btn.addEventListener('click', function () { showBanner(true); });
    wrap.appendChild(btn);
    footer.appendChild(wrap);
  }

  /* ---------------------------------------------------------------
   * CLICK TRACKING (calls, WhatsApp, email, booking buttons)
   * ------------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) { return; }
    var href = a.getAttribute('href') || '';
    var info = { link_url: href, page_path: window.location.pathname };

    if (href.indexOf('tel:') === 0) {
      track('phone_click', info);
    } else if (/(^|\/\/)(wa\.me|api\.whatsapp\.com)/.test(href)) {
      track('whatsapp_click', info);
    } else if (href.indexOf('mailto:') === 0) {
      track('email_click', info);
    } else if (/appointment\.html|#booking/.test(href)) {
      track('booking_click', info);
    }
  }, true);

  // The Setmore booking form lives inside an iframe, which the page cannot see into.
  // When a visitor clicks into it, the page window loses focus to that iframe - we use that
  // as a signal that they started using the booking form.
  window.addEventListener('blur', function () {
    window.setTimeout(function () {
      var el = document.activeElement;
      if (!widgetSeen && el && el.tagName === 'IFRAME' && /setmore/i.test(el.src || '')) {
        widgetSeen = true;
        track('booking_widget_interaction', { page_path: window.location.pathname });
      }
    }, 0);
  });

  /* ---------------------------------------------------------------
   * START
   * ------------------------------------------------------------- */
  var choice = readChoice();
  if (choice === 'granted') {
    grantAndLoad();
  }

  function ready() {
    addFooterLink();
    if (choice !== 'granted' && choice !== 'denied') { showBanner(false); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
