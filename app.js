(function () {
  function qs(id){ return document.getElementById(id); }
  var root = qs('appRoot');
  var apiKey = root ? root.dataset.apiKey : '';

  function getHost() {
    var params = new URLSearchParams(window.location.search);
    return params.get('host');
  }
  function getShop() {
    var params = new URLSearchParams(window.location.search);
    return params.get('shop');
  }

  function waitForAB(tries) {
    tries = tries || 0;
    var AB  = window['app-bridge'];
    var ABU = window['app-bridge-utils'];
    if (!AB || !ABU) {
      if (tries < 50) return setTimeout(function(){ waitForAB(tries + 1); }, 100);
      var stats = qs('stats');
      if (stats) stats.textContent = 'Не удалось загрузить Shopify App Bridge. Обновите страницу.';
      return;
    }

    var app = AB.createApp({ apiKey: apiKey, host: getHost() });

    function authedFetch(url, options) {
      options = options || {};
      return ABU.getSessionToken(app).then(function(token){
        var headers = options.headers || {};
        headers.Authorization = 'Bearer ' + token;
        options.headers = headers;
        return fetch(url, options);
      });
    }

    var listBtn  = qs('listBtn');
    var scanBtn  = qs('scanBtn');
    var tagBtn   = qs('tagBtn');
    var statsEl  = qs('stats');

    var listTbl  = qs('listTbl');
    var listBody = listTbl.querySelector('tbody');

    var susTbl   = qs('susTbl');
    var susBody  = susTbl.querySelector('tbody');
    var checkAll = qs('checkAll');

    function customerRow(i, c){
      var addr = (c.addresses && c.addresses[0]) || {};
      return '<tr>'
        + '<td>' + (i+1) + '</td>'
        + '<td>' + (c.displayName || '') + '</td>'
        + '<td>' + (c.email || '') + '</td>'
        + '<td>' + (addr.city || '') + '</td>'
        + '<td>' + (addr.country || '') + '</td>'
        + '</tr>';
    }

    function suspectRow(c){
      return '<tr>'
        + '<td><input type="checkbox" data-id="' + c.id + '"></td>'
        + '<td>' + (c.displayName || '') + '</td>'
        + '<td>' + (c.email || '') + '</td>'
        + '<td>' + c.reasons.join(', ') + '</td>'
        + '</tr>';
    }

    if (listBtn) listBtn.onclick = function () {
      listBtn.disabled = true;
      statsEl.textContent = 'Загружаю клиентов…';
      listBody.innerHTML = '';
      authedFetch('/api/customers/list?limit=50')
        .then(function(r){
          if (r.status === 401) {
            var s = getShop();
            window.location.href = '/api/auth' + (s ? ('?shop=' + encodeURIComponent(s)) : '');
            return Promise.reject('401');
          }
          return r.json();
        })
        .then(function(data){
          var arr = data.customers || [];
          listTbl.style.display = arr.length ? '' : 'none';
          listBody.innerHTML = arr.map(function(c,i){ return customerRow(i,c); }).join('');
          statsEl.textContent = 'Клиентов: ' + (data.count != null ? data.count : arr.length);
        })
        .catch(function(e){
          if (e !== '401') statsEl.textContent = 'Ошибка: ' + e;
        })
        .finally(function(){ listBtn.disabled = false; });
    };

    if (scanBtn) scanBtn.onclick = function () {
      scanBtn.disabled = true; tagBtn.disabled = true; statsEl.textContent = 'Сканирую…';
      susBody.innerHTML = '';
      authedFetch('/api/customers/scan?max=50&batch=25')
        .then(function(r){
          if (r.status === 401) {
            var s = getShop();
            window.location.href = '/api/auth' + (s ? ('?shop=' + encodeURIComponent(s)) : '');
            return Promise.reject('401');
          }
          return r.json();
        })
        .then(function(data){
          var suspects = data.suspects || [];
          susTbl.style.display = suspects.length ? '' : 'none';
          susBody.innerHTML = suspects.map(function(c){ return suspectRow(c); }).join('');
          statsEl.textContent = 'Проверено: ' + data.totalChecked + '. Найдено подозрительных: ' + suspects.length + '.';
          tagBtn.disabled = suspects.length === 0;
        })
        .catch(function(e){
          if (e !== '401') statsEl.textContent = 'Ошибка: ' + e;
        })
        .finally(function(){ scanBtn.disabled = false; });
    };

    if (tagBtn) tagBtn.onclick = function () {
      var ids = Array.prototype.slice.call(susBody.querySelectorAll('input[type="checkbox"]:checked')).map(function(i){ return i.dataset.id; });
      if (!ids.length) { alert('Отметь хотя бы одного клиента'); return; }
      tagBtn.disabled = true;
      authedFetch('/api/customers/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids, tag: 'suspect_bot' })
      })
      .then(function(r){
        if (r.status === 401) {
          var s = getShop();
          window.location.href = '/api/auth' + (s ? ('?shop=' + encodeURIComponent(s)) : '');
          return Promise.reject('401');
        }
        return r.json();
      })
      .then(function(data){
        var errs = (data.results || []).filter(function(x){ return (x.errors||[]).length; }).length;
        alert('Готово. Ошибок: ' + errs);
      })
      .catch(function(e){
        if (e !== '401') alert('Ошибка: ' + e);
      })
      .finally(function(){ tagBtn.disabled = false; });
    };

    if (checkAll) {
      checkAll.addEventListener('change', function(){
        var on = checkAll.checked;
        Array.prototype.forEach.call(susBody.querySelectorAll('input[type="checkbox"]'), function(cb){ cb.checked = on; });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function(){ waitForAB(); });
})();
