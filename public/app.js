// public/app.js
(function () {
  function qs(id){ return document.getElementById(id); }
  function getShop(){ return new URLSearchParams(location.search).get('shop'); }

  // Ждём инициализации App Bridge (новая версия встраивает auth в fetch)
  function ready(tries){
    tries = tries || 0;
    if (!window.shopify) {
      if (tries < 50) return setTimeout(function(){ ready(tries+1); }, 100);
      var s = qs('stats'); if (s) s.textContent = 'Не удалось инициализировать App Bridge.';
      // даже без shopify попробуем работать: если прилетит 401 — отправим на /api/auth
    }
    init();
  }

  function ensureAuth(r){
    if (r.status === 401) {
      var s = getShop();
      location.href = '/api/auth' + (s ? ('?shop=' + encodeURIComponent(s)) : '');
      throw '401';
    }
    return r;
  }

  function init(){
    var listBtn = qs('listBtn'), scanBtn = qs('scanBtn'), tagBtn = qs('tagBtn'), stats = qs('stats');
    var listTbl = qs('listTbl'), listBody = listTbl.querySelector('tbody');
    var susTbl  = qs('susTbl'),  susBody  = susTbl.querySelector('tbody');
    var checkAll= qs('checkAll');

    function customerRow(i,c){
      var a=(c.addresses&&c.addresses[0])||{};
      return '<tr><td>'+(i+1)+'</td><td>'+(c.displayName||'')+'</td><td>'+(c.email||'')+'</td><td>'+(a.city||'')+'</td><td>'+(a.country||'')+'</td></tr>';
    }
    function suspectRow(c){
      return '<tr><td><input type="checkbox" data-id="'+c.id+'"></td><td>'+(c.displayName||'')+'</td><td>'+(c.email||'')+'</td><td>'+c.reasons.join(', ')+'</td></tr>';
    }

    if (listBtn) listBtn.onclick = function(){
      listBtn.disabled = true; stats.textContent = 'Загружаю клиентов…'; listBody.innerHTML='';
      fetch('/api/customers/list?limit=50')
        .then(ensureAuth).then(function(r){ return r.json(); })
        .then(function(d){
          var arr=d.customers||[];
          listTbl.style.display=arr.length?'':'none';
          listBody.innerHTML=arr.map(function(c,i){ return customerRow(i,c); }).join('');
          stats.textContent='Клиентов: '+(d.count!=null?d.count:arr.length);
        })
        .catch(function(e){ if(e!=='401') stats.textContent='Ошибка: '+e; })
        .finally(function(){ listBtn.disabled=false; });
    };

    if (scanBtn) scanBtn.onclick = function(){
      scanBtn.disabled = true; tagBtn.disabled = true; stats.textContent = 'Сканирую…'; susBody.innerHTML='';
      fetch('/api/customers/scan?max=50&batch=25')
        .then(ensureAuth).then(function(r){ return r.json(); })
        .then(function(d){
          var arr=d.suspects||[];
          susTbl.style.display=arr.length?'':'none';
          susBody.innerHTML=arr.map(suspectRow).join('');
          stats.textContent='Проверено: '+d.totalChecked+'. Найдено: '+arr.length+'.';
          tagBtn.disabled=!arr.length;
        })
        .catch(function(e){ if(e!=='401') stats.textContent='Ошибка: '+e; })
        .finally(function(){ scanBtn.disabled=false; });
    };

    if (tagBtn) tagBtn.onclick = function(){
      var ids=[].slice.call(susBody.querySelectorAll('input[type="checkbox"]:checked')).map(function(i){return i.dataset.id;});
      if(!ids.length){ alert('Отметь хотя бы одного клиента'); return; }
      tagBtn.disabled=true;
      fetch('/api/customers/tag', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ids: ids, tag: 'suspect_bot' })
      })
      .then(ensureAuth).then(function(r){ return r.json(); })
      .then(function(d){
        var errs=(d.results||[]).filter(function(x){ return (x.errors||[]).length; }).length;
        alert('Готово. Ошибок: '+errs);
      })
      .catch(function(e){ if(e!=='401') alert('Ошибка: '+e); })
      .finally(function(){ tagBtn.disabled=false; });
    };

    if (checkAll) checkAll.addEventListener('change', function(){
      var on=checkAll.checked;
      [].forEach.call(susBody.querySelectorAll('input[type="checkbox"]'), function(cb){ cb.checked=on; });
    });
  }

  document.addEventListener('DOMContentLoaded', function(){ ready(); });
})();
