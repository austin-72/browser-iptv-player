// Runs on every page but only acts on the IPTV Player app (it carries <meta name="iptv-direct-streams">).
(function () {
  if (!document.querySelector('meta[name="iptv-direct-streams"]')) return;
  var api = typeof browser !== 'undefined' ? browser : chrome;
  try {
    api.runtime.sendMessage({ app: location.hostname }, function (r) {
      if (r && r.ok) document.documentElement.setAttribute('data-iptv-direct', '1');
    });
  } catch (e) {}
})();
