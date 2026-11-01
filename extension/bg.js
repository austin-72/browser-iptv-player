// Adds "Access-Control-Allow-Origin: *" to responses for requests made BY the IPTV Player app pages only,
// so the app's web player can read streams from providers that don't allow web players. Nothing else is touched.
var api = typeof browser !== 'undefined' ? browser : chrome;

function apply(hosts) {
  var rules = hosts.length ? [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'access-control-allow-origin', operation: 'set', value: '*' },
        { header: 'access-control-expose-headers', operation: 'set', value: '*' }
      ]
    },
    condition: { initiatorDomains: hosts, resourceTypes: ['xmlhttprequest', 'media', 'other'] }
  }] : [];
  return api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: rules });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || typeof msg.app !== 'string' || !/^[a-z0-9.\-\[\]:]+$/i.test(msg.app)) return;
  api.storage.local.get('hosts', function (d) {
    var hosts = (d && d.hosts) || [];
    var done = function () { reply({ ok: true }); };
    if (hosts.indexOf(msg.app) >= 0) return apply(hosts).then(done, function () { reply({ ok: false }); });
    hosts.push(msg.app);
    api.storage.local.set({ hosts: hosts }, function () { apply(hosts).then(done, function () { reply({ ok: false }); }); });
  });
  return true;
});
